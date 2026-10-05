/**
 * Smart-HTTP receive-pack client helpers, used by `push`.
 *
 * Symmetric to `upload-pack-client.ts`:
 * - `discoverReceivePackRefs` — service-bound wrapper around
 *  `discoverRefsForService(..., 'git-receive-pack')`.
 * - `selectPushCapabilities` — intersect the server's advertised
 *  capability set with the tsgit-supported v1 subset:
 *  `report-status`, `side-band-64k`, `ofs-delta`, `delete-refs`, the
 *  push's opt-ins (`atomic`, `push-cert`), plus the appended `agent` slot.
 */
import type { Advertisement } from '../../../domain/protocol/index.js';
import {
  AGENT,
  CLIENT_CAPABILITIES_PUSH,
  negotiateCapabilities as negotiateProtocolCapabilities,
  peerNegotiatesObjectFormat,
} from '../../../domain/protocol/index.js';
import type { GitServiceSession } from './git-service-session.js';
import { discoverRefsForService } from './refs-discovery.js';

export const discoverReceivePackRefs = async (session: GitServiceSession): Promise<Advertisement> =>
  discoverRefsForService(session, 'git-receive-pack');

/**
 * The agent slot is always appended client-side — the server does not need
 * to advertise it for us to send our own. Any server-advertised `agent=...`
 * is dropped by the dedup filter so it does not leak into our request.
 *
 * emits non-delta packs so we never advertise
 * `thin-pack`; it is absent from `CLIENT_CAPABILITIES_PUSH` already, so the
 * intersect step naturally drops it from any server-side advertisement.
 *
 * `object-format=<objectFormat>` is appended the same unconditional way as
 * AGENT: it is OUR OWN algorithm, sent verbatim regardless of what the
 * server advertised.
 *
 * `optIns` are the capabilities only some pushes ask for — `atomic` for an
 * atomic push, `push-cert` for a signed one — still intersected with the
 * advertisement.
 */
export const selectPushCapabilities = (
  advertised: ReadonlyArray<string>,
  objectFormat: 'sha1' | 'sha256',
  optIns: ReadonlyArray<string> = [],
): ReadonlyArray<string> => {
  const clientWants = [...CLIENT_CAPABILITIES_PUSH.filter((c) => c !== AGENT), ...optIns];
  const intersected = negotiateProtocolCapabilities(advertised, clientWants);
  // git orders `object-format` before `agent`, and sends it only when the
  // peer advertised the capability.
  return peerNegotiatesObjectFormat(advertised)
    ? [...intersected, `object-format=${objectFormat}`, AGENT]
    : [...intersected, AGENT];
};
