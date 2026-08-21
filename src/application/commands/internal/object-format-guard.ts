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
  isSupportedObjectFormat,
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
  // An algorithm we do not implement is a DIFFERENT condition from a known
  // algorithm that simply differs from ours, and git words them differently.
  // Passing `local` unconditionally would render every out-of-set value as a
  // pairing mismatch and leave the discriminating field never exercised.
  if (!isSupportedObjectFormat(peer)) throw unsupportedObjectFormat(peer);
  if (verb === 'push') throw pushObjectFormatUnsupported(local, peer);
  throw unsupportedObjectFormat(peer, local);
};
