/**
 * Smart-HTTP upload-pack client helpers shared by `clone` and `fetch`.
 *
 * Each helper is a thin composition of Phase 8 protocol primitives:
 * - `discoverRefs` — GETs `/info/refs?service=git-upload-pack` and parses the
 *   advertisement.
 * - `selectFetchCapabilities` — intersect the server's advertised capability
 *   set with the tsgit-supported v1 subset (no multi_ack_detailed, no
 *   thin-pack, no no-progress; always append `agent=tsgit/<ver>`).
 * - `uniqueRefOids` — strip duplicates from the advertisement's ref oids so
 *   the upload-pack request body's `want` lines are deduplicated.
 * - `readableStreamToAsyncIterable` — adapt a fetch `Response.body` stream
 *   to an `AsyncIterable<Uint8Array>` with `cancel()`-on-early-return so the
 *   underlying socket closes cleanly when the consumer throws or breaks.
 */
import type { ObjectId } from '../../../domain/objects/index.js';
import type { AdvertisedRef, Advertisement } from '../../../domain/protocol/index.js';
import {
  AGENT,
  buildDiscoveryUrl,
  CLIENT_CAPABILITIES_FETCH,
  decodePktStream,
  negotiateCapabilities as negotiateProtocolCapabilities,
  parseAdvertisedRefs,
} from '../../../domain/protocol/index.js';
import type { Context } from '../../../ports/context.js';
import type { HttpTransport } from '../../../ports/http-transport.js';

export const discoverRefs = async (
  ctx: Context,
  transport: HttpTransport,
  url: string,
): Promise<Advertisement> => {
  const discoveryUrl = buildDiscoveryUrl(url, 'git-upload-pack');
  const response = await transport.request({
    url: discoveryUrl,
    method: 'GET',
    headers: { accept: 'application/x-git-upload-pack-advertisement' },
    ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
  });
  // 2xx responses pass through; HTTP errors surface via withRetry / the
  // adapter as TsgitError. We don't gate on a specific status here — the
  // pkt-line parser will reject any non-protocol payload below.
  const pktStream = decodePktStream(readableStreamToAsyncIterable(response.body));
  return parseAdvertisedRefs(pktStream, 'git-upload-pack');
};

/**
 * Adapt a `ReadableStream<Uint8Array>` body to an `AsyncIterable<Uint8Array>`.
 * On early exit (consumer throws or breaks) the iterator's `return` hook
 * calls `cancel()` so the stream + underlying socket close cleanly —
 * `releaseLock` alone leaves the stream open.
 */
export const readableStreamToAsyncIterable = (
  stream: ReadableStream<Uint8Array>,
): AsyncIterable<Uint8Array> => ({
  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    const reader = stream.getReader();
    return {
      next: async (): Promise<IteratorResult<Uint8Array>> => {
        const { done, value } = await reader.read();
        return done ? { done: true, value: undefined } : { done: false, value };
      },
      return: async (): Promise<IteratorResult<Uint8Array>> => {
        try {
          await reader.cancel();
        } catch {
          // swallow — adapter closes the underlying socket regardless
        }
        return { done: true, value: undefined };
      },
    };
  },
});

/**
 * Drop client capabilities Phase 12.x cannot honor end-to-end (see Phase 12.1
 * design §3.6): no negotiation rounds (`multi_ack_detailed`), no thin-pack
 * repair, no `no-progress` (we want channel-2 text for the reporter). Always
 * append the agent string — the server does not need to advertise it for the
 * client to send it.
 */
export const selectFetchCapabilities = (
  advertised: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const clientWants = CLIENT_CAPABILITIES_FETCH.filter(
    (c) => c !== 'multi_ack_detailed' && c !== 'thin-pack' && c !== 'no-progress' && c !== AGENT,
  );
  const intersected = negotiateProtocolCapabilities(advertised, clientWants);
  return [...intersected, AGENT];
};

/**
 * Deduplicate advertised ref oids preserving order. Peeled oids are
 * informational only — a strict v1 server may reject a `want <peeled-oid>`
 * because the peeled oid is not in the advertised set. Real `git clone`
 * requests the tag ref and the server packs the commit transitively.
 */
export const uniqueRefOids = (refs: ReadonlyArray<AdvertisedRef>): ReadonlyArray<ObjectId> => {
  const seen = new Set<string>();
  const out: ObjectId[] = [];
  for (const r of refs) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r.id);
  }
  return out;
};
