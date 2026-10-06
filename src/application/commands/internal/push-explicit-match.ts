/**
 * git's `match_explicit` for a refspec that pushes: its source is matched
 * against the local refs and its destination against the remote's, as
 * `count_refspec_match` does, and a destination nothing matches is either a
 * full `refs/` name or guessed under the namespace the source lives in. A side
 * git refuses to resolve keeps the spelling `parseRefspec` gave it.
 */
import { HEADS_PREFIX, TAGS_PREFIX } from '../../../domain/refs/ref-prefixes.js';
import { refspecMatches } from './push-delete-target.js';
import type { ParsedRefspec } from './refspec.js';

export interface LocalPushRefs {
  /** Every local ref under `refs/`. */
  readonly names: ReadonlyArray<string>;
  /** Each local symref, `HEAD` included, onto the ref it finally resolves to. */
  readonly symrefs: ReadonlyMap<string, string>;
}

export type ExplicitMatch =
  | { readonly kind: 'matched'; readonly src: string; readonly dst: string }
  | { readonly kind: 'unmatched'; readonly dst: string; readonly reason: 'ambiguous' };

const REFS_PREFIX = 'refs/';
const FORCE_PREFIX = '+';

/** The sides as written: the force mark dropped, `undefined` for a missing destination. */
const writtenSides = (raw: string): { readonly src: string; readonly dst: string | undefined } => {
  const body = raw.startsWith(FORCE_PREFIX) ? raw.slice(1) : raw;
  const colon = body.lastIndexOf(':');
  return colon === -1
    ? { src: body, dst: undefined }
    : { src: body.slice(0, colon), dst: body.slice(colon + 1) };
};

const uniqueMatch = (pattern: string, names: ReadonlyArray<string>): string | undefined => {
  const matches = refspecMatches(pattern, names);
  return matches.length === 1 ? matches[0] : undefined;
};

/** git's `guess_ref`: a new destination lands beside the branch or tag pushed. */
const guessRef = (name: string, peer: string | undefined): string | undefined => {
  if (peer?.startsWith(HEADS_PREFIX) === true) return `${HEADS_PREFIX}${name}`;
  if (peer?.startsWith(TAGS_PREFIX) === true) return `${TAGS_PREFIX}${name}`;
  return undefined;
};

/** A missing destination is the source's own name, a symref's only when it is a branch. */
const defaultDestination = (
  src: string,
  matched: string | undefined,
  local: LocalPushRefs,
): string | undefined => {
  const target = local.symrefs.get(src);
  if (target === undefined) return matched;
  return target.startsWith(HEADS_PREFIX) ? target : undefined;
};

export const matchExplicitPush = (
  raw: string,
  parsed: ParsedRefspec,
  local: LocalPushRefs,
  remoteNames: ReadonlyArray<string>,
): ExplicitMatch => {
  const written = writtenSides(raw);
  const matched = uniqueMatch(written.src, local.names);
  const src = matched ?? parsed.src;
  const dstValue = written.dst ?? defaultDestination(src, matched, local) ?? parsed.dst;
  const matches = refspecMatches(dstValue, remoteNames);
  if (matches.length > 1) return { kind: 'unmatched', dst: dstValue, reason: 'ambiguous' };
  const peer = local.symrefs.get(src) ?? matched;
  const dst =
    matches[0] ??
    (dstValue.startsWith(REFS_PREFIX) ? dstValue : (guessRef(dstValue, peer) ?? parsed.dst));
  return { kind: 'matched', src, dst };
};
