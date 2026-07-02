/**
 * Refs discovery, parameterised by service and transport-agnostic over the
 * `GitServiceSession` seam.
 *
 * `discoverRefs` originally targeted `git-upload-pack` only. Push uses
 * the same pkt-line advertisement format and parser against
 * `git-receive-pack`; only the service differs. The session owns the wire
 * shape (HTTP discovery GET vs. an SSH channel with no `# service=...`
 * prologue) — this module just feeds `session.advertisement()` through the
 * shared parser.
 *
 * The legacy `upload-pack-client.ts` is a thin re-export that binds the
 * service to `'git-upload-pack'` so existing callers do not have to change.
 */
import type { Advertisement, Service } from '../../../domain/protocol/index.js';
import { parseAdvertisedRefs } from '../../../domain/protocol/index.js';
import type { GitServiceSession } from './git-service-session.js';

export const discoverRefsForService = async (
  session: GitServiceSession,
  service: Service,
): Promise<Advertisement> => {
  const pktStream = await session.advertisement();
  return parseAdvertisedRefs(pktStream, service, { servicePrologue: session.servicePrologue });
};
