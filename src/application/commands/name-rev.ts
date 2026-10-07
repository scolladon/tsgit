/**
 * Tier-1 `name-rev` command — git's `git name-rev`: name a commit by the nearest
 * ref that **contains** it (a descendant-or-self ref), via a reverse-reachability
 * flood down from every qualifying ref (ADRs 283–285). Returns structured data
 * only: the chosen ref (full name), whether it is an annotated tag (the `^0`
 * peel), and the ordered `~`/`^` navigation steps. The library renders no name
 * string and abbreviates no ref — assembling `tags/v2.0~3^2~1` is the caller's.
 */

import { errorDataCode } from '../../domain/error-data-code.js';
import {
  buildRefFilter,
  commitIsBeforeCutoff,
  firstParentName,
  foldSteps,
  isBetterName,
  mergeParentName,
  type NameRevCutoff,
  type NameRevStep,
  nameRevCutoff,
  type RevName,
} from '../../domain/name-rev/index.js';
import type { ObjectId, RefName } from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import { enumerateRefs } from '../primitives/enumerate-refs.js';
import type { BoundedReader } from '../primitives/internal/bounded-reader.js';
import { boundedReaderFor } from '../primitives/internal/concurrency.js';
import {
  type CommitMeta,
  commitMetaOf,
  readCommitMeta,
} from '../primitives/internal/read-commit-meta.js';
import { getRefStore } from '../primitives/ref-store.js';
import { reportAmbiguousOid } from './internal/ambiguous-oid-report.js';
import { type NameRevOptions, parseNameRevOptions } from './internal/name-rev-options.js';
import { parseObjectGently, peelLoadedTip, peelNameRevTip } from './internal/name-rev-tip.js';
import { assertOperationalRepository } from './internal/repo-state.js';
import { evaluateRevision } from './rev-parse.js';

export type { NameRevOptions, NameRevStep };

export interface NameRevResult {
  /** Full 40-hex oid of the named object — a commit, or a tag, tree or blob named by exact ref match. */
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

/** A queued commit's meta plus the id it belongs to — `walkRef`'s stack shape. */
interface NameRevNode extends CommitMeta {
  readonly id: ObjectId;
}

type MetaReader = BoundedReader<CommitMeta | undefined>;

/**
 * Name `rev` (default `HEAD`). An argument git's `repo_get_oid` cannot read, or
 * whose object `parse_object` cannot load, is skipped with git's note rather
 * than refused — `undefined`, as git prints nothing for it and exits 0. A tag,
 * tree or blob is named only by a ref pointing straight at it — git's exact
 * ref match — never by the commit a tag peels to.
 */
export const nameRev = (
  ctx: Context,
  rev?: string,
  opts: NameRevOptions = {},
): Promise<NameRevResult | undefined> => nameRevOf(ctx, rev ?? DEFAULT_REV, opts, 'object');

/** git `name-rev --peel-tag`, as `describe --contains` runs it: a tag names its commit. */
export const nameRevPeeled = (
  ctx: Context,
  rev: string | undefined,
  opts: NameRevOptions,
): Promise<NameRevResult | undefined> => nameRevOf(ctx, rev ?? DEFAULT_REV, opts, 'peel');

const nameRevOf = async (
  ctx: Context,
  rev: string,
  opts: NameRevOptions,
  tags: TagArgument,
): Promise<NameRevResult | undefined> => {
  await assertOperationalRepository(ctx);
  const target = await readTarget(ctx, rev, tags);
  if (target === undefined) return undefined;
  const filter = buildRefFilter(parseNameRevOptions(opts));
  // Stryker disable next-line MethodExpression: equivalent — `listRefNames` already
  // returns refs in name order, so this `.sort()` is a defensive no-op (the
  // reverse-alphabetical tie test names the same ref with or without it).
  const refs = [...(await enumerateRefs(ctx))].filter((ref) => filter.qualifies(ref)).sort();
  if (!target.isCommit) return exactRefMatch(ctx, refs, target.id);
  return nameCommit(ctx, refs, target.id);
};

/** Flood every naming ref down to `target` and fold the best name it received. */
const nameCommit = async (
  ctx: Context,
  refs: ReadonlyArray<RefName>,
  target: ObjectId,
): Promise<NameRevResult> => {
  const cutoff = nameRevCutoff((await readCommitMeta(ctx, target)) as CommitMeta);
  const revNames = new Map<ObjectId, RevName>();
  const metas: MetaReader = boundedReaderFor(ctx, 'ioBound', (id) => readCommitMeta(ctx, id));
  for (const ref of refs) await walkRef(ctx, ref, revNames, cutoff, metas);
  const name = revNames.get(target);
  if (name === undefined) return { oid: target, ref: undefined, tagDeref: false, steps: [] };
  return { oid: target, ref: name.ref, tagDeref: name.tagDeref, steps: foldSteps(name) };
};

/** git's `get_exact_ref_match`: the first naming ref whose own value is `target`. */
const exactRefMatch = async (
  ctx: Context,
  refs: ReadonlyArray<RefName>,
  target: ObjectId,
): Promise<NameRevResult> => {
  const store = getRefStore(ctx);
  for (const ref of refs) {
    const resolved = await store.resolveDirect(ref);
    if (resolved.kind === 'direct' && resolved.id === target) {
      return { oid: target, ref, tagDeref: false, steps: [] };
    }
  }
  return { oid: target, ref: undefined, tagDeref: false, steps: [] };
};

/** The codes a `repo_get_oid` that read no object refuses with. */
const UNREAD_ARGUMENT_CODES: ReadonlySet<string | undefined> = new Set([
  'OBJECT_NOT_FOUND',
  'REVPARSE_UNRESOLVED',
  'PATH_NOT_IN_TREE',
  'AMBIGUOUS_OID_PREFIX',
]);

/** Which object a tag argument names: the tag itself, or (git's `--peel-tag`) its commit. */
type TagArgument = 'object' | 'peel';

interface NameRevTarget {
  readonly id: ObjectId;
  readonly isCommit: boolean;
}

const readTarget = async (
  ctx: Context,
  rev: string,
  tags: TagArgument,
): Promise<NameRevTarget | undefined> => {
  const id = await readArgumentOid(ctx, rev);
  if (id === undefined) return skipArgument(ctx, `Could not get sha1 for ${rev}. Skipping.`);
  const object = await parseObjectGently(ctx, id);
  if (object === undefined) return skipArgument(ctx, `Could not get object for ${rev}. Skipping.`);
  if (tags === 'object') return { id, isCommit: object.type === 'commit' };
  const { commit } = await peelLoadedTip(ctx, id, object);
  if (commit === undefined) return skipArgument(ctx, `Could not get commit for ${rev}. Skipping.`);
  return { id: commit.id, isCommit: true };
};

const readArgumentOid = async (ctx: Context, rev: string): Promise<ObjectId | undefined> => {
  try {
    return await evaluateRevision(ctx, rev);
  } catch (error) {
    if (!UNREAD_ARGUMENT_CODES.has(errorDataCode(error))) throw error;
    reportAmbiguousOid(ctx, error);
    return undefined;
  }
};

const skipArgument = (ctx: Context, note: string): undefined => {
  ctx.logger?.info?.(note);
  return undefined;
};

/** Flood down from a single ref, recording the best name for each commit reached. */
const walkRef = async (
  ctx: Context,
  ref: RefName,
  revNames: Map<ObjectId, RevName>,
  cutoff: NameRevCutoff,
  metas: MetaReader,
): Promise<void> => {
  const tip = await seedRef(ctx, ref, revNames, cutoff);
  if (tip === undefined) return;
  const stack: NameRevNode[] = [tip];
  while (stack.length > 0) {
    const node = stack.pop() as NameRevNode;
    const name = revNames.get(node.id) as RevName;
    const queued = await expandParents(node, name, revNames, cutoff, metas);
    // Reverse-push so the first parent is popped first (git's LIFO traversal).
    for (let index = queued.length - 1; index >= 0; index -= 1)
      stack.push(queued[index] as NameRevNode);
  }
};

/** Resolve + peel a ref to its tip commit and seed its name; `undefined` if it loses, can't peel, or is pruned. */
const seedRef = async (
  ctx: Context,
  ref: RefName,
  revNames: Map<ObjectId, RevName>,
  cutoff: NameRevCutoff,
): Promise<NameRevNode | undefined> => {
  const resolved = await getRefStore(ctx).resolveDirect(ref);
  if (resolved.kind !== 'direct') return undefined;
  const tip = await peelNameRevTip(ctx, resolved.id);
  if (tip.commit === undefined) return undefined;
  const meta = await commitMetaOf(ctx, tip.commit);
  if (commitIsBeforeCutoff(meta, cutoff)) return undefined;
  const seed: RevName = {
    ref,
    tagDeref: tip.deref,
    fromTag: ref.startsWith(TAGS_PREFIX),
    taggerDate: tip.deref ? tip.taggerDate : tip.commit.data.committer.timestamp,
    generation: 0,
    distance: 0,
    steps: [],
  };
  return accept(revNames, tip.commit.id, seed) ? { id: tip.commit.id, ...meta } : undefined;
};

/** The parents whose candidate name improved on `accept`'s gate — synchronous, no read involved. */
const acceptedParents = (
  parents: ReadonlyArray<ObjectId>,
  name: RevName,
  revNames: Map<ObjectId, RevName>,
): ObjectId[] =>
  parents.filter((oid, index) =>
    accept(revNames, oid, index === 0 ? firstParentName(name) : mergeParentName(name, index + 1)),
  );

/** Name each parent of `node` and return the parent nodes whose name improved and are not pruned. */
const expandParents = async (
  node: NameRevNode,
  name: RevName,
  revNames: Map<ObjectId, RevName>,
  cutoff: NameRevCutoff,
  metas: MetaReader,
): Promise<NameRevNode[]> => {
  const accepted = acceptedParents(node.parents, name, revNames);
  for (const oid of accepted) metas.start(oid); // overlap: fire every read before consuming any
  const queued: NameRevNode[] = [];
  for (const oid of accepted) {
    const meta = await metas.start(oid);
    metas.forget(oid); // or the flood retains one memo entry per commit walked
    if (meta === undefined || commitIsBeforeCutoff(meta, cutoff)) continue;
    queued.push({ id: oid, ...meta });
  }
  return queued;
};

/** Record `candidate` for `oid` iff its slot is empty or the candidate is a better name. */
const accept = (revNames: Map<ObjectId, RevName>, oid: ObjectId, candidate: RevName): boolean => {
  const existing = revNames.get(oid);
  if (existing !== undefined && !isBetterName(existing, candidate)) return false;
  revNames.set(oid, candidate);
  return true;
};
