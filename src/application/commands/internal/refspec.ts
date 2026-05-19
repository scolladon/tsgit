/**
 * Refspec parser — v1 subset.
 *
 * Accepted forms (everything else throws `REFSPEC_INVALID`):
 *
 *  <src>:<dst> standard push
 *  +<src>:<dst> force push
 *  :<dst> delete remote dst
 *  <branch> shorthand for refs/heads/<branch>:refs/heads/<branch>
 *  +<branch> force shorthand
 *  HEAD source-side symbolic; resolver expands
 *
 * Short-form (no slash) inputs are expanded to `refs/heads/<name>` on
 * BOTH sides of the colon. Tag refspecs must be fully-qualified
 * (`refs/tags/v1.0:refs/tags/v1.0`).
 *
 * The parser is purely structural: it does NOT validate the ref name
 * grammar (that lives in `validateRefName`). The resolver layer applies
 * `validateRefName` before any ref is read or written to disk.
 */
import { refspecInvalid } from '../../../domain/protocol/error.js';

export type Force = 'force' | 'normal';

export interface ParsedRefspec {
  readonly force: Force;
  /** Source ref name (local). Empty string for delete-only refspecs. */
  readonly src: string;
  /** Destination ref name (remote). Always non-empty. */
  readonly dst: string;
  /** True iff src is empty (delete). */
  readonly isDelete: boolean;
}

const SHORT_FORM_PREFIX = 'refs/heads/';

const expandShort = (name: string): string => {
  // Fully-qualified ref names already contain at least one slash, so an
  // input without a slash is the short form (e.g. `main`). HEAD is a
  // special source token that the resolver expands — leave it untouched.
  if (name === 'HEAD') return name;
  if (name.includes('/')) return name;
  return `${SHORT_FORM_PREFIX}${name}`;
};

export const parseRefspec = (raw: string): ParsedRefspec => {
  if (raw === '') {
    throw refspecInvalid(raw, 'refspec must not be empty');
  }
  let body = raw;
  let force: Force = 'normal';
  if (body.startsWith('+')) {
    force = 'force';
    body = body.slice(1);
  }
  if (body === '') {
    throw refspecInvalid(raw, 'refspec must not be empty after force prefix');
  }

  const colonCount = countOccurrences(body, ':');
  if (colonCount > 1) {
    throw refspecInvalid(raw, 'refspec must contain at most one colon');
  }

  if (colonCount === 0) {
    // Shorthand: src and dst are the same expanded form.
    const expanded = expandShort(body);
    return { force, src: expanded, dst: expanded, isDelete: false };
  }

  const colonAt = body.indexOf(':');
  const srcRaw = body.slice(0, colonAt);
  const dstRaw = body.slice(colonAt + 1);
  if (dstRaw === '') {
    throw refspecInvalid(raw, 'destination must not be empty');
  }
  const dst = expandShort(dstRaw);
  if (dst === 'HEAD') {
    throw refspecInvalid(raw, 'destination must not be HEAD');
  }
  if (srcRaw === '') {
    return { force, src: '', dst, isDelete: true };
  }
  const src = expandShort(srcRaw);
  return { force, src, dst, isDelete: false };
};

const countOccurrences = (s: string, ch: string): number => {
  let count = 0;
  for (let i = 0; i < s.length; i += 1) {
    if (s[i] === ch) count += 1;
  }
  return count;
};
