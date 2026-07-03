/**
 * Stateful seam between application commands and the wire transport that
 * carries the git smart protocol (`git-upload-pack` / `git-receive-pack`).
 *
 * The HTTP session wraps today's discovery GET (`info/refs?service=...`) and
 * exchange POST (`git-upload-pack` / `git-receive-pack`) helpers verbatim —
 * wire bytes are unchanged. The SSH session spawns one persistent duplex
 * channel that serves BOTH `advertisement()` and `exchange()` — see
 * `SshGitServiceSession` below.
 */
import { adapterUnavailable } from '../../../domain/commands/error.js';
import { httpError, networkError, operationAborted } from '../../../domain/error.js';
import {
  buildDiscoveryUrl,
  decodePktStream,
  type GitExchange,
  invalidBaseUrl,
  type PktLine,
  type Service,
} from '../../../domain/protocol/index.js';
import { readableStreamToAsyncIterable } from '../../../operators/readable-stream.js';
import type { Context } from '../../../ports/context.js';
import type { SshChannel, SshTransport } from '../../../ports/ssh-channel.js';
import { withDefaults } from './network-pipeline.js';
import { parseRemoteUrl, type RemoteUrl } from './remote-url.js';
import { buildSshArgs } from './ssh-argv.js';
import { resolveSshCommand } from './ssh-command.js';

export interface GitServiceSession {
  readonly advertisement: () => Promise<AsyncIterable<PktLine>>;
  readonly exchange: GitExchange;
  readonly close: () => Promise<void>;
  /** Whether `advertisement()` carries the HTTP `# service=...` prologue (false over SSH). */
  readonly servicePrologue: boolean;
}

const EXCHANGE_HEADERS: Readonly<Record<Service, Readonly<Record<string, string>>>> = {
  'git-upload-pack': {
    'content-type': 'application/x-git-upload-pack-request',
    accept: 'application/x-git-upload-pack-result',
  },
  'git-receive-pack': {
    'content-type': 'application/x-git-receive-pack-request',
    accept: 'application/x-git-receive-pack-result',
  },
};

const ADVERTISEMENT_ACCEPT: Readonly<Record<Service, string>> = {
  'git-upload-pack': 'application/x-git-upload-pack-advertisement',
  'git-receive-pack': 'application/x-git-receive-pack-advertisement',
};

/**
 * Open a session against `url` for `service`. HTTP(S) URLs get the existing
 * discovery/exchange wire shape. SSH URLs (`ssh://`, scp-like) spawn a real
 * channel when the runtime supplies `ctx.ssh`; browser/memory (no `ctx.ssh`)
 * refuse inertly.
 */
export const openGitSession = (ctx: Context, url: string, service: Service): GitServiceSession => {
  const remote = parseRemoteUrl(url);
  if (remote.kind === 'http') return createHttpSession(ctx, remote.url, service);
  if (ctx.ssh === undefined) {
    throw adapterUnavailable(ctx.runtime, 'ssh: transport unavailable in this runtime');
  }
  return new SshGitServiceSession(ctx, ctx.ssh, remote, service);
};

interface PktRequest {
  readonly url: string;
  readonly method: 'GET' | 'POST';
  readonly headers: Readonly<Record<string, string>>;
  readonly reasonLabel: string;
  readonly body?: Uint8Array;
}

const createHttpSession = (ctx: Context, url: string, service: Service): GitServiceSession => {
  const transport = withDefaults(
    ctx,
    ctx.config?.auth !== undefined ? { auth: ctx.config.auth } : {},
  );

  const requestPkts = async (req: PktRequest): Promise<AsyncIterable<PktLine>> => {
    const response = await transport.request({
      url: req.url,
      method: req.method,
      headers: req.headers,
      ...(req.body !== undefined ? { body: req.body } : {}),
      ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
    });
    if (response.statusCode !== 200) {
      throw httpError(response.statusCode, `${req.reasonLabel} returned ${response.statusCode}`);
    }
    return decodePktStream(readableStreamToAsyncIterable(response.body));
  };

  const advertisement = (): Promise<AsyncIterable<PktLine>> =>
    requestPkts({
      url: buildDiscoveryUrl(url, service),
      method: 'GET',
      headers: { accept: ADVERTISEMENT_ACCEPT[service] },
      reasonLabel: `${service} discovery`,
    });

  const exchange = (requestBytes: Uint8Array): Promise<AsyncIterable<PktLine>> =>
    requestPkts({
      url: buildExchangeUrl(url, service),
      method: 'POST',
      headers: EXCHANGE_HEADERS[service],
      reasonLabel: service,
      body: requestBytes,
    });

  return { advertisement, exchange, close: async () => {}, servicePrologue: true };
};

const buildExchangeUrl = (baseUrl: string, service: Service): string => {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw invalidBaseUrl('invalid URL');
  }
  if (parsed.hash !== '') throw invalidBaseUrl('fragment must not be set');
  const path = parsed.pathname.endsWith('/') ? parsed.pathname.slice(0, -1) : parsed.pathname;
  return `${parsed.protocol}//${parsed.host}${path}/${service}${parsed.search}`;
};

type SshRemoteUrl = Extract<RemoteUrl, { kind: 'ssh' }>;

/**
 * SSH `GitServiceSession`: one spawned duplex channel serves BOTH
 * `advertisement()` and `exchange()` — unlike HTTP's independent
 * request/response pairs, ssh has no service prologue and no per-call
 * connection. The channel and its decoded pkt-line iterator are materialised
 * lazily on first use and shared across every call; each call hands back an
 * inert "view" whose own `return()` never tears down the shared reader —
 * only `close()` does, by killing the child process.
 */
class SshGitServiceSession implements GitServiceSession {
  readonly servicePrologue = false;
  private readonly ctx: Context;
  private readonly ssh: SshTransport;
  private readonly remote: SshRemoteUrl;
  private readonly service: Service;
  private channel: Promise<SshChannel> | undefined;
  private lines: Promise<AsyncIterator<PktLine>> | undefined;

  constructor(ctx: Context, ssh: SshTransport, remote: SshRemoteUrl, service: Service) {
    this.ctx = ctx;
    this.ssh = ssh;
    this.remote = remote;
    this.service = service;
  }

  advertisement = (): Promise<AsyncIterable<PktLine>> => this.continuation();

  exchange: GitExchange = async (requestBytes: Uint8Array): Promise<AsyncIterable<PktLine>> => {
    const channel = await this.openChannel();
    return this.continuation(startStdinWrite(channel.stdin, requestBytes));
  };

  close = async (): Promise<void> => {
    if (this.channel === undefined) return;
    const channel = await this.channel;
    await channel.close();
  };

  private openChannel(): Promise<SshChannel> {
    this.channel ??= spawnChannel(this.ctx, this.ssh, this.remote, this.service);
    return this.channel;
  }

  private async continuation(awaitWrite?: () => Promise<void>): Promise<AsyncIterable<PktLine>> {
    const channel = await this.openChannel();
    const iterator = await this.sharedIterator(channel);
    const signal = this.ctx.signal;
    return { [Symbol.asyncIterator]: () => wrapInert({ iterator, channel, signal, awaitWrite }) };
  }

  private sharedIterator(channel: SshChannel): Promise<AsyncIterator<PktLine>> {
    this.lines ??= Promise.resolve(
      decodePktStream(readableStreamToAsyncIterable(channel.stdout))[Symbol.asyncIterator](),
    );
    return this.lines;
  }
}

const spawnChannel = async (
  ctx: Context,
  ssh: SshTransport,
  remote: SshRemoteUrl,
  service: Service,
): Promise<SshChannel> => {
  const resolved = await resolveSshCommand(ctx);
  const args = buildSshArgs({ service, parsed: remote, baseArgs: resolved.baseArgs });
  return ssh.open({
    command: resolved.program,
    args,
    env: {},
    ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
  });
};

const writeToStdin = async (
  stdin: WritableStream<Uint8Array>,
  bytes: Uint8Array,
): Promise<void> => {
  const writer = stdin.getWriter();
  try {
    await writer.write(bytes);
  } finally {
    writer.releaseLock();
  }
};

/**
 * Begin the stdin write WITHOUT awaiting it: the caller must be free to drain
 * stdout concurrently, otherwise a request larger than the OS pipe buffer
 * deadlocks the duplex channel (the server blocks writing side-band progress
 * to its full stdout, stops draining stdin, and the client write never
 * resolves). A write failure is parked and re-surfaced by the returned thunk
 * at the natural end of the response stream, so it is never swallowed.
 */
const startStdinWrite = (
  stdin: WritableStream<Uint8Array>,
  bytes: Uint8Array,
): (() => Promise<void>) => {
  let failure: unknown;
  const settled = writeToStdin(stdin, bytes).catch((error: unknown) => {
    failure = error;
  });
  return async () => {
    await settled;
    if (failure !== undefined) throw failure;
  };
};

/**
 * Wrap the shared decode iterator so an early consumer `return()` (e.g.
 * `parseAdvertisedRefs`'s cleanup after the advertisement's terminating
 * flush) never cancels the underlying channel reader. Only a natural `done`
 * — the channel's stdout truly closing — checks the process exit code.
 */
interface InertWrap {
  readonly iterator: AsyncIterator<PktLine>;
  readonly channel: SshChannel;
  readonly signal?: AbortSignal | undefined;
  readonly awaitWrite?: (() => Promise<void>) | undefined;
}

const wrapInert = ({
  iterator,
  channel,
  signal,
  awaitWrite,
}: InertWrap): AsyncIterator<PktLine> => ({
  next: async (): Promise<IteratorResult<PktLine>> => {
    const result = await iterator.next();
    if (result.done) {
      await assertCleanExit(channel, signal);
      await awaitWrite?.();
    }
    return result;
  },
  return: async (): Promise<IteratorResult<PktLine>> => ({ done: true, value: undefined }),
});

const assertCleanExit = async (channel: SshChannel, signal?: AbortSignal): Promise<void> => {
  const code = await channel.exit;
  if (code === 0) return;
  if (signal?.aborted === true) throw operationAborted();
  throw networkError(`ssh exited with code ${code}`);
};
