/**
 * Tier-1 `name-rev` command — git's `git name-rev`: name a commit by the nearest
 * ref that **contains** it (a descendant-or-self ref), via a reverse-reachability
 * flood down from every qualifying ref (ADRs 283–285). Returns structured data
 * only: the chosen ref (full name), whether it is an annotated tag (the `^0`
 * peel), and the ordered `~`/`^` navigation steps. The library renders no name
 * string and abbreviates no ref — assembling `tags/v2.0~3^2~1` is the caller's.
 */
import {
  buildRefFilter,
  commitIsBeforeCutoff,
  firstParentName,
  foldSteps,
  isBetterName,
  mergeParentName,
  type NameRevStep,
  nameRevCutoff,
  type RevName,
} from '../../domain/name-rev/index.js';
import type { Commit, ObjectId, RefName } from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import { enumerateRefs } from '../primitives/enumerate-refs.js';
import { peelRefToCommit } from '../primitives/internal/peel-ref-to-commit.js';
import { readObject } from '../primitives/read-object.js';
import { getRefStore } from '../primitives/ref-store.js';
import { parseNameRevOptions } from './internal/name-rev-options.js';
import { assertOperationalRepository } from './internal/repo-state.js';
import { resolveCommit } from './internal/resolve-rev.js';

export type { NameRevStep };

export interface NameRevOptions {
  /** Restrict the naming sources to tags (`refs/tags/*`). */
  readonly tags?: boolean;
  /** Full-refname globs a ref must match to be a naming source (`*`/`?` cross `/`). */
  readonly refs?: string | ReadonlyArray<string>;
  /** Full-refname globs that drop a ref from the naming sources. */
  readonly exclude?: string | ReadonlyArray<string>;
}

export interface NameRevResult {
  /** Full 40-hex oid of the named commit. */
  readonly oid: ObjectId;
  /** Naming ref (full name, e.g. `refs/tags/v1.0`); `undefined` when unnameable. */
  readonly ref: RefName | undefined;
  /** `true` when the ref is an annotated tag (the caller renders `^0` at the tip). */
  readonly tagDeref: boolean;
  /** Navigation from the ref's commit down to `oid` (`~count` / `^number`). */
  readonly steps: ReadonlyArray<NameRevStep>;
}

const DEFAULT_REV = 'HEAD';
const TAGS_PREFIX = 'refs/tags/';

export const nameRev = async (
  ctx: Context,
  rev?: string,
  opts: NameRevOptions = {},
): Promise<NameRevResult> => {
  await assertOperationalRepository(ctx);
  const target = await resolveCommit(ctx, rev ?? DEFAULT_REV);
  const targetCommit = (await readObject(ctx, target)) as Commit;
  const cutoff = nameRevCutoff(targetCommit.data.committer.timestamp);
  const filter = buildRefFilter(parseNameRevOptions(opts));
  const refs = [...(await enumerateRefs(ctx))].filter((ref) => filter.qualifies(ref)).sort();
  const revNames = new Map<ObjectId, RevName>();
  for (const ref of refs) await walkRef(ctx, ref, revNames, cutoff);

  const name = revNames.get(target);
  if (name === undefined) return { oid: target, ref: undefined, tagDeref: false, steps: [] };
  return { oid: target, ref: name.ref, tagDeref: name.tagDeref, steps: foldSteps(name) };
};

/** Flood down from a single ref, recording the best name for each commit reached. */
const walkRef = async (
  ctx: Context,
  ref: RefName,
  revNames: Map<ObjectId, RevName>,
  cutoff: number,
): Promise<void> => {
  const tip = await seedRef(ctx, ref, revNames, cutoff);
  if (tip === undefined) return;
  const stack: Commit[] = [tip];
  while (stack.length > 0) {
    const commit = stack.pop() as Commit;
    const name = revNames.get(commit.id) as RevName;
    const queued = await expandParents(ctx, commit, name, revNames, cutoff);
    // Reverse-push so the first parent is popped first (git's LIFO traversal).
    for (let index = queued.length - 1; index >= 0; index -= 1) stack.push(queued[index] as Commit);
  }
};

/** Resolve + peel a ref to its tip commit and seed its name; `undefined` if it loses, can't peel, or is pruned. */
const seedRef = async (
  ctx: Context,
  ref: RefName,
  revNames: Map<ObjectId, RevName>,
  cutoff: number,
): Promise<Commit | undefined> => {
  const resolved = await getRefStore(ctx).resolveDirect(ref);
  if (resolved.kind !== 'direct') return undefined;
  const tip = await peelRefToCommit(ctx, resolved.id);
  if (tip === undefined) return undefined;
  if (commitIsBeforeCutoff(tip.commit.data.committer.timestamp, cutoff)) return undefined;
  const seed: RevName = {
    ref,
    tagDeref: tip.viaTag,
    fromTag: ref.startsWith(TAGS_PREFIX),
    taggerDate: tip.viaTag ? tip.taggerDate : tip.commit.data.committer.timestamp,
    generation: 0,
    distance: 0,
    steps: [],
  };
  return accept(revNames, tip.commit.id, seed) ? tip.commit : undefined;
};

/** Name each parent of `commit` and return the parent commits whose name improved and are not pruned. */
const expandParents = async (
  ctx: Context,
  commit: Commit,
  name: RevName,
  revNames: Map<ObjectId, RevName>,
  cutoff: number,
): Promise<Commit[]> => {
  const queued: Commit[] = [];
  const parents = commit.data.parents;
  for (let index = 0; index < parents.length; index += 1) {
    const parentOid = parents[index] as ObjectId;
    const candidate = index === 0 ? firstParentName(name) : mergeParentName(name, index + 1);
    if (!accept(revNames, parentOid, candidate)) continue;
    const parent = await readObject(ctx, parentOid);
    if (parent.type !== 'commit') continue;
    if (commitIsBeforeCutoff(parent.data.committer.timestamp, cutoff)) continue;
    queued.push(parent);
  }
  return queued;
};

/** Record `candidate` for `oid` iff its slot is empty or the candidate is a better name. */
const accept = (revNames: Map<ObjectId, RevName>, oid: ObjectId, candidate: RevName): boolean => {
  const existing = revNames.get(oid);
  // equivalent-mutant: flipping this `false` to `true` cannot change the output —
  // it returns *before* the `set` below, so the worse candidate is never recorded;
  // it only re-queues a commit whose name did not improve, redundant work that
  // re-propagates the unchanged name and still terminates on the finite history DAG.
  if (existing !== undefined && !isBetterName(existing, candidate)) return false;
  revNames.set(oid, candidate);
  return true;
};
