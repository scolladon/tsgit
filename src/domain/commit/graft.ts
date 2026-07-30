/**
 * Grafts a shallow-boundary commit's parent list to empty, in place of the
 * true (unavailable) parents recorded in its object bytes. Pure, zero I/O —
 * the caller supplies the per-`Context` shallow set.
 *
 * Consequence: a masked commit's `id` is the object's true oid, but its
 * `data.parents` no longer matches the bytes `id` hashes to (`id !==
 * hash(data)` for the masked shape). That is safe because nothing re-derives
 * an id from a walked commit's data — object writers (`create-commit.ts`)
 * always build their own `CommitData` from scratch. A future surface that
 * needs to re-serialise a read commit must read the raw object instead of
 * reusing a walked one.
 */
import type { Commit } from '../objects/commit.js';
import type { ObjectId } from '../objects/object-id.js';

const NO_PARENTS: ReadonlyArray<ObjectId> = Object.freeze([]);

/**
 * The parent list a walk should see for `id`: `parents` unchanged, or
 * `NO_PARENTS` when `id` is a shallow boundary. Returns `parents` BY
 * REFERENCE on the non-masked path — callers may use that identity to skip
 * rebuilding a containing object.
 */
export const graftedParents = (
  id: ObjectId,
  parents: ReadonlyArray<ObjectId>,
  shallow: ReadonlySet<ObjectId>,
): ReadonlyArray<ObjectId> => {
  if (shallow.size === 0 || !shallow.has(id)) return parents;
  return NO_PARENTS;
};

/**
 * Apply the shallow-boundary mask to a read `Commit`: the identical input
 * reference when `commit.id` is not a boundary, or a shallow copy whose
 * `data.parents` is empty otherwise. Every other field — `tree`, `author`,
 * `committer`, `message`, `gpgSignature`, `extraHeaders` — is untouched.
 */
export const applyGraft = (commit: Commit, shallow: ReadonlySet<ObjectId>): Commit => {
  const parents = graftedParents(commit.id, commit.data.parents, shallow);
  if (parents === commit.data.parents) return commit;
  return { ...commit, data: { ...commit.data, parents } };
};
