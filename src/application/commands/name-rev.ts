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
import { peelRefToCommit } from '../primitives/internal/peel-ref-to-commit.js';
import {
  type CommitMeta,
  commitMetaOf,
  readCommitMeta,
} from '../primitives/internal/read-commit-meta.js';
import { getRefStore } from '../primitives/ref-store.js';
import { type NameRevOptions, parseNameRevOptions } from './internal/name-rev-options.js';
import { assertOperationalRepository } from './internal/repo-state.js';
import { resolveCommit } from './internal/resolve-rev.js';

export type { NameRevOptions, NameRevStep };

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

/** A queued commit's meta plus the id it belongs to — `walkRef`'s stack shape. */
interface NameRevNode extends CommitMeta {
  readonly id: ObjectId;
}

type MetaReader = BoundedReader<CommitMeta | undefined>;

export const nameRev = async (
  ctx: Context,
  rev?: string,
  opts: NameRevOptions = {},
): Promise<NameRevResult> => {
  await assertOperationalRepository(ctx);
  const target = await resolveCommit(ctx, rev ?? DEFAULT_REV);
  const targetMeta = (await readCommitMeta(ctx, target)) as CommitMeta;
  const cutoff = nameRevCutoff(targetMeta);
  const filter = buildRefFilter(parseNameRevOptions(opts));
  // Stryker disable next-line MethodExpression: equivalent — `listRefNames` already
  // returns refs in name order, so this `.sort()` is a defensive no-op (the
  // reverse-alphabetical tie test names the same ref with or without it).
  const refs = [...(await enumerateRefs(ctx))].filter((ref) => filter.qualifies(ref)).sort();
  const revNames = new Map<ObjectId, RevName>();
  const metas: MetaReader = boundedReaderFor(ctx, 'ioBound', (id) => readCommitMeta(ctx, id));
  for (const ref of refs) await walkRef(ctx, ref, revNames, cutoff, metas);

  const name = revNames.get(target);
  if (name === undefined) return { oid: target, ref: undefined, tagDeref: false, steps: [] };
  return { oid: target, ref: name.ref, tagDeref: name.tagDeref, steps: foldSteps(name) };
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
  const tip = await peelRefToCommit(ctx, resolved.id);
  if (tip === undefined) return undefined;
  const meta = await commitMetaOf(ctx, tip.commit);
  if (commitIsBeforeCutoff(meta, cutoff)) return undefined;
  const seed: RevName = {
    ref,
    tagDeref: tip.viaTag,
    fromTag: ref.startsWith(TAGS_PREFIX),
    taggerDate: tip.viaTag ? tip.taggerDate : tip.commit.data.committer.timestamp,
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
