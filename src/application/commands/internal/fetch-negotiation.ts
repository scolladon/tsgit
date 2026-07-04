/**
 * Version negotiation + fallback dispatch for the fetch-side wire protocol.
 *
 * `negotiateDiscovery` decides v1 vs. v2 the way real git does: by peeking at
 * the FIRST line of the discovery response rather than trusting the request
 * header (a server may ignore `Git-Protocol: version=2` and reply with the
 * legacy v1 advertisement). Because that first line has to be inspected
 * before it is known which parser owns the stream, it is read once and
 * pushed back onto a one-shot replay wrapper — both `parseV2Capabilities`
 * (which re-validates the line is exactly `version 2`) and `parseAdvertisedRefs`
 * need to see it as the first item their own iteration produces.
 *
 * `negotiatePackBytes` performs the actual pack exchange once the version is
 * known, sharing the same bounded-drain step (`drainPackBodyBounded`) on
 * both legs so the v1 leg's byte-cap/progress behaviour is unchanged from
 * before this module existed.
 */
import { sanitize } from '../../../domain/commands/error.js';
import type { Advertisement, PktLine } from '../../../domain/protocol/index.js';
import {
  buildLsRefsRequest,
  buildUploadPackRequest,
  buildV2FetchRequest,
  parseAdvertisedRefs,
  parseLsRefsResponse,
  parseUploadPackResponse,
  parseV2Capabilities,
  parseV2FetchResponse,
  supportsV2Fetch,
  v2CommandUnsupported,
} from '../../../domain/protocol/index.js';
import { consumeServiceHeaderFlush } from '../../../domain/protocol/upload-pack.js';
import type { Context } from '../../../ports/context.js';
import {
  drainPackBodyBounded,
  type FetchPackInput,
  hasSideBand,
  type PackDownload,
} from '../../primitives/fetch-pack.js';
import type { GitServiceSession } from './git-service-session.js';

export type FetchWireVersion = 1 | 2;

export interface DiscoveryResult {
  readonly version: FetchWireVersion;
  readonly advertisement: Advertisement;
}

const VERSION_2_LINE = 'version 2';
const TEXT_DECODER = new TextDecoder();

const stripTrailingNewline = (value: string): string =>
  value.endsWith('\n') ? value.slice(0, -1) : value;

const isVersion2Line = (pkt: IteratorResult<PktLine>): boolean =>
  !pkt.done &&
  pkt.value.kind === 'data' &&
  stripTrailingNewline(TEXT_DECODER.decode(pkt.value.payload)) === VERSION_2_LINE;

/**
 * Replays one already-consumed `IteratorResult` before delegating every
 * subsequent call to the real iterator — the pushback needed to hand a
 * peeked-at first line back to a parser that expects to read it itself.
 * `return()` delegates too, so an early-exit parser cleanup (e.g.
 * `parseAdvertisedRefs`'s `finally`) still releases the underlying reader.
 */
const withPushback = (
  iter: AsyncIterator<PktLine>,
  first: IteratorResult<PktLine>,
): AsyncIterable<PktLine> => {
  let replayed = false;
  return {
    [Symbol.asyncIterator]: (): AsyncIterator<PktLine> => ({
      next: (): Promise<IteratorResult<PktLine>> => {
        if (replayed) return iter.next();
        replayed = true;
        return Promise.resolve(first);
      },
      return: async (value?: unknown): Promise<IteratorResult<PktLine>> =>
        (await iter.return?.(value)) ?? { done: true, value: undefined },
    }),
  };
};

/**
 * Discover refs, dispatching on whichever version the server actually
 * replied with. HTTP v1 sessions carry the `# service=...` prologue ahead of
 * the ref lines; HTTP v2 sessions do not — the response starts directly with
 * `version 2\n`. SSH sessions never carry it either way. Since whether the
 * prologue is present can only be known by looking at the wire, the first
 * line is always peeked before deciding to consume it as a service header.
 */
const resolveFirstDiscoveryLine = async (
  iter: AsyncIterator<PktLine>,
  peeked: IteratorResult<PktLine>,
  servicePrologue: boolean,
): Promise<IteratorResult<PktLine>> => {
  if (!servicePrologue || isVersion2Line(peeked)) return peeked;
  await consumeServiceHeaderFlush(iter, peeked, 'git-upload-pack');
  return iter.next();
};

/**
 * Real git advertises `filter` as a sub-feature of the v2 `fetch` command
 * (`fetch=shallow wait-for-done filter`), not as a top-level ref-advertisement
 * capability the way v1 does. Folding it into `advertisement.capabilities`
 * keeps `advertisesFilter` — and the filter guard in clone/fetch that calls
 * it — version-agnostic.
 */
const withV2FilterCapability = (
  advertisement: Advertisement,
  fetchFeatures: ReadonlySet<string>,
): Advertisement =>
  fetchFeatures.has('filter')
    ? { ...advertisement, capabilities: [...advertisement.capabilities, 'filter'] }
    : advertisement;

export const negotiateDiscovery = async (session: GitServiceSession): Promise<DiscoveryResult> => {
  const pktStream = await session.advertisement();
  const iter = pktStream[Symbol.asyncIterator]();
  const peeked = await iter.next();
  const first = await resolveFirstDiscoveryLine(iter, peeked, session.servicePrologue);
  if (!isVersion2Line(first)) {
    const advertisement = await parseAdvertisedRefs(withPushback(iter, first), 'git-upload-pack', {
      servicePrologue: false,
    });
    return { version: 1, advertisement };
  }

  const capabilities = await parseV2Capabilities(withPushback(iter, first));
  if (!supportsV2Fetch(capabilities)) throw v2CommandUnsupported('fetch');
  const responsePkts = await session.exchange(buildLsRefsRequest({ symrefs: true }));
  const lsRefsAdvertisement = await parseLsRefsResponse(responsePkts);
  const advertisement = withV2FilterCapability(lsRefsAdvertisement, capabilities.fetchFeatures);
  return { version: 2, advertisement };
};

/** Pack-byte negotiation only ever calls `session.exchange` — narrowing to this one member keeps test stubs a one-liner and the dependency honest (ISP). */
export type PackExchangeSession = Pick<GitServiceSession, 'exchange'>;

const v2Args = (input: Pick<FetchPackInput, 'depth' | 'filter'>): ReadonlyArray<string> => {
  const args: string[] = [];
  if (input.depth !== undefined) args.push(`deepen ${input.depth}`);
  if (input.filter !== undefined) args.push(`filter ${input.filter}`);
  return args;
};

const negotiateV2PackBytes = async (
  ctx: Context,
  session: PackExchangeSession,
  input: FetchPackInput,
): Promise<PackDownload> => {
  const requestBody = buildV2FetchRequest({
    wants: input.wants,
    haves: input.haves,
    args: v2Args(input),
    done: true,
  });
  const pktSource = await session.exchange(requestBody);
  const parsed = await parseV2FetchResponse(pktSource);
  const packBytes = await drainPackBodyBounded(ctx, input, parsed.packBody);
  return { packBytes, shallow: parsed.shallow, unshallow: parsed.unshallow };
};

const negotiateV1PackBytes = async (
  ctx: Context,
  session: PackExchangeSession,
  input: FetchPackInput,
): Promise<PackDownload> => {
  const requestBody = buildUploadPackRequest({
    wants: input.wants,
    haves: input.haves,
    capabilities: input.capabilities,
    done: true,
    // Stryker disable next-line ConditionalExpression: equivalent — `buildUploadPackRequest` treats `depth: undefined` like an absent field, so spreading unconditionally emits no `deepen` line.
    ...(input.depth !== undefined ? { depth: input.depth } : {}),
    // Stryker disable next-line ConditionalExpression: equivalent — `buildUploadPackRequest` treats `filter: undefined` like an absent field, so spreading unconditionally emits no `filter` line.
    ...(input.filter !== undefined ? { filter: input.filter } : {}),
  });
  const pktSource = await session.exchange(requestBody);
  const parsed = await parseUploadPackResponse(pktSource, {
    sideBand: hasSideBand(input.capabilities),
    // Sanitize sideband-2 text BEFORE it crosses the ProgressReporter port:
    // user-supplied reporters are free implementations and the contract does
    // not require sanitization — a logging reporter that forwards the bytes
    // verbatim would be vulnerable to terminal injection from a malicious
    // server. Sanitizing at the boundary leaves no untrusted byte on the
    // reporter call surface.
    onProgress: (text) => ctx.progress.update(input.progressOp, 0, undefined, sanitize(text)),
    // Stryker disable next-line ConditionalExpression: equivalent — `parseUploadPackResponse` treats `expectShallow: true` identically on a non-shallow stream (the NAK pkt is pushed back and processed as the non-shallow path).
    expectShallow: input.depth !== undefined,
  });
  const packBytes = await drainPackBodyBounded(ctx, input, parsed.packBody);
  return { packBytes, shallow: parsed.shallow, unshallow: parsed.unshallow };
};

/**
 * Fetches and drains the pack body for the negotiated `version`, returning
 * the shared `PackDownload` shape both legs feed into `fetchPack`'s
 * (version-agnostic) trailer verification + artifact-write tail.
 */
export const negotiatePackBytes = (
  ctx: Context,
  session: PackExchangeSession,
  version: FetchWireVersion,
  input: FetchPackInput,
): Promise<PackDownload> =>
  version === 2
    ? negotiateV2PackBytes(ctx, session, input)
    : negotiateV1PackBytes(ctx, session, input);
