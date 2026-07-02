/**
 * Stateful seam between application commands and the wire transport that
 * carries the git smart protocol (`git-upload-pack` / `git-receive-pack`).
 *
 * The HTTP session wraps today's discovery GET (`info/refs?service=...`) and
 * exchange POST (`git-upload-pack` / `git-receive-pack`) helpers verbatim —
 * wire bytes are unchanged. SSH is not wired here: opening a session against
 * an `ssh://` or scp-like URL refuses inertly; spawning a real channel is a
 * later part.
 */
import { adapterUnavailable } from '../../../domain/commands/error.js';
import { httpError } from '../../../domain/error.js';
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
import { withDefaults } from './network-pipeline.js';
import { parseRemoteUrl } from './remote-url.js';

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
 * discovery/exchange wire shape; SSH URLs (`ssh://`, scp-like) refuse inertly
 * — real SSH transport lands in a later part.
 */
export const openGitSession = (ctx: Context, url: string, service: Service): GitServiceSession => {
  const remote = parseRemoteUrl(url);
  if (remote.kind === 'ssh') {
    throw adapterUnavailable(ctx.runtime, 'ssh: transport unavailable in this runtime');
  }
  return createHttpSession(ctx, remote.url, service);
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
