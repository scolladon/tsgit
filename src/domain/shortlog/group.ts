import type { ObjectId } from '../objects/index.js';
import { compareBytes } from '../objects/index.js';

const nameEncoder = new TextEncoder();

/** A walk-ordered commit projection, with the chosen identity already selected. */
export interface ShortlogEntry {
  readonly name: string;
  readonly email: string;
  readonly id: ObjectId;
  readonly subject: string;
}

/** One commit within a `shortlog` group. */
export interface ShortlogCommit {
  readonly id: ObjectId;
  readonly email: string;
  readonly subject: string;
}

/** A per-identity-name `shortlog` group; commits are oldest first. */
export interface ShortlogGroup {
  readonly name: string;
  readonly commits: ReadonlyArray<ShortlogCommit>;
}

/**
 * Group walk-ordered (newest-first) entries by identity name — git's default
 * `shortlog`. Commits sharing a name merge into one group regardless of email
 * (each commit keeps its own); every group's commits are reversed to oldest
 * first; groups are byte-sorted ascending by name (git's `string_list`
 * `strcmp`, UTF-8 bytes — not JS UTF-16 default sort).
 */
export const groupShortlog = (
  entries: ReadonlyArray<ShortlogEntry>,
): ReadonlyArray<ShortlogGroup> => {
  const buckets = new Map<string, ShortlogCommit[]>();
  for (const { name, email, id, subject } of entries) {
    const commit: ShortlogCommit = { id, email, subject };
    const bucket = buckets.get(name);
    if (bucket === undefined) buckets.set(name, [commit]);
    else bucket.push(commit);
  }
  return [...buckets.entries()]
    .map(([name, commits]) => ({ name, commits: [...commits].reverse() }))
    .sort((a, b) => compareBytes(nameEncoder.encode(a.name), nameEncoder.encode(b.name)));
};
