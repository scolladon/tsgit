/**
 * Smart-HTTP receive-pack client helpers, used by `push`.
 *
 * Symmetric to `upload-pack-client.ts`:
 * - `discoverReceivePackRefs` — service-bound wrapper around
 *  `discoverRefsForService(..., 'git-receive-pack')`.
 * - `selectPushCapabilities` — the capabilities git's send-pack requests
 *  from the server's advertisement.
 */
import type { Advertisement } from '../../../domain/protocol/index.js';
import {
  AGENT,
  CLIENT_CAPABILITIES_PUSH,
  peerNegotiatesObjectFormat,
} from '../../../domain/protocol/index.js';
import type { GitServiceSession } from './git-service-session.js';
import { discoverRefsForService } from './refs-discovery.js';

export const discoverReceivePackRefs = async (session: GitServiceSession): Promise<Advertisement> =>
  discoverRefsForService(session, 'git-receive-pack');

const REPORT_STATUS = 'report-status';
const REPORT_STATUS_V2 = 'report-status-v2';

const advertises = (advertised: ReadonlyArray<string>, name: string): boolean =>
  advertised.some((capability) => capability === name || capability.startsWith(`${name}=`));

/**
 * git's send-pack capability line: each token it asks for, in its order, only
 * when the server advertises it — `report-status-v2` in place of
 * `report-status` when both are offered — the push's own requests, then `optIns`
 * (`atomic` for an atomic push), then OUR `object-format` and agent, the
 * server's own values never echoed back.
 */
export const selectPushCapabilities = (
  advertised: ReadonlyArray<string>,
  objectFormat: 'sha1' | 'sha256',
  optIns: ReadonlyArray<string> = [],
): ReadonlyArray<string> => {
  const offered = (name: string): boolean => advertises(advertised, name);
  // git asks for the v2 report whenever the server offers it.
  const requested = (name: string): string =>
    name === REPORT_STATUS && offered(REPORT_STATUS_V2) ? REPORT_STATUS_V2 : name;
  return [
    ...CLIENT_CAPABILITIES_PUSH.map(requested).filter(offered),
    ...optIns.filter(offered),
    ...(peerNegotiatesObjectFormat(advertised) ? [`object-format=${objectFormat}`] : []),
    ...(offered('agent') ? [AGENT] : []),
  ];
};
