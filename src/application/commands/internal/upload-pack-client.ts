/**
 * Smart-HTTP upload-pack client helpers shared by `clone` and `fetch`.
 *
 * Each helper is a thin composition of protocol primitives:
 * - `discoverRefs` — service-bound wrapper around the parameterised
 *  `discoverRefsForService` in `refs-discovery.ts` (binds
 *  `'git-upload-pack'`).
 * - `selectFetchCapabilities` — intersect the server's advertised capability
 *  set with the tsgit-supported v1 subset (no multi_ack_detailed, no
 *  thin-pack, no no-progress; always append `agent=tsgit/<ver>`).
 * - `uniqueRefOids` — strip duplicates from the advertisement's ref oids so
 *  the upload-pack request body's `want` lines are deduplicated.
 *
 * Push (12.3) reuses the parameterised `discoverRefsForService` directly via
 * `receive-pack-client.ts`.
 */
import type { ObjectId } from '../../../domain/objects/index.js';
import type { AdvertisedRef, Advertisement } from '../../../domain/protocol/index.js';
import {
  AGENT,
  CLIENT_CAPABILITIES_FETCH,
  negotiateCapabilities as negotiateProtocolCapabilities,
} from '../../../domain/protocol/index.js';
import type { Context } from '../../../ports/context.js';
import type { HttpTransport } from '../../../ports/http-transport.js';
import { discoverRefsForService } from './refs-discovery.js';

export const discoverRefs = async (
  ctx: Context,
  transport: HttpTransport,
  url: string,
): Promise<Advertisement> => discoverRefsForService(ctx, transport, url, 'git-upload-pack');

/**
 * Drop client capabilities.x cannot honor end-to-end (see
 * design): no negotiation rounds (`multi_ack_detailed`), no thin-pack
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

/**
 * True when the server's ref-advertisement capability set includes the
 * `filter` token — the prerequisite for a partial-clone `filter` request.
 */
export const advertisesFilter = (capabilities: ReadonlyArray<string>): boolean =>
  capabilities.includes('filter');
