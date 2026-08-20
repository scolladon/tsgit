/**
 * Shared object-format mismatch guard for both wire directions and both
 * protocol versions. Fetch/clone discover the peer's declared algorithm over
 * their own leg (v1 advertisement token or v2 capability); push discovers it
 * over its v1-only leg. This is the one place "peer !== local" becomes a
 * refusal, so the fetch-direction code (`UNSUPPORTED_OBJECT_FORMAT`) and the
 * push-direction code (`PUSH_OBJECT_FORMAT_UNSUPPORTED`) stay distinguishable
 * by code rather than by call site.
 */
import {
  pushObjectFormatUnsupported,
  unsupportedObjectFormat,
} from '../../../domain/protocol/index.js';

export type ObjectFormatVerb = 'fetch' | 'push';

export const assertPeerAlgorithm = (
  local: 'sha1' | 'sha256',
  peer: string,
  verb: ObjectFormatVerb,
): void => {
  if (peer === local) return;
  if (verb === 'push') throw pushObjectFormatUnsupported(local, peer);
  throw unsupportedObjectFormat(peer, local);
};
