/**
 * Smart-HTTP receive-pack client helpers, used by `push`.
 *
 * Symmetric to `upload-pack-client.ts`:
 * - `discoverReceivePackRefs` — service-bound wrapper around
 *  `discoverRefsForService(..., 'git-receive-pack')`.
 * - `selectPushCapabilities` — intersect the server's advertised
 *  capability set with the tsgit-supported v1 subset:
 *  `report-status`, `side-band-64k`, `ofs-delta`, `atomic`, `delete-refs`,
 *  plus the appended `agent` slot.
 */
import type { Advertisement } from '../../../domain/protocol/index.js';
import {
  AGENT,
  CLIENT_CAPABILITIES_PUSH,
  negotiateCapabilities as negotiateProtocolCapabilities,
} from '../../../domain/protocol/index.js';
import type { Context } from '../../../ports/context.js';
import type { HttpTransport } from '../../../ports/http-transport.js';
import { discoverRefsForService } from './refs-discovery.js';

export const discoverReceivePackRefs = async (
  ctx: Context,
  transport: HttpTransport,
  url: string,
): Promise<Advertisement> => discoverRefsForService(ctx, transport, url, 'git-receive-pack');

/**
 * The agent slot is always appended client-side — the server does not need
 * to advertise it for us to send our own. Any server-advertised `agent=...`
 * is dropped by the dedup filter so it does not leak into our request.
 *
 * emits non-delta packs so we never advertise
 * `thin-pack`; it is absent from `CLIENT_CAPABILITIES_PUSH` already, so the
 * intersect step naturally drops it from any server-side advertisement.
 */
export const selectPushCapabilities = (
  advertised: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const clientWants = CLIENT_CAPABILITIES_PUSH.filter((c) => c !== AGENT);
  const intersected = negotiateProtocolCapabilities(advertised, clientWants);
  return [...intersected, AGENT];
};
