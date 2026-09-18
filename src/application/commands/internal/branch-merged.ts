/**
 * git's `branch_merged` — the safety valve `branch -d` runs and `-D` skips.
 *
 * The reference a tip is measured against is the branch's configured upstream
 * when one NAMES A COMMIT, and HEAD otherwise. An upstream REPLACES HEAD
 * rather than widening the test: a branch merged into its upstream but not
 * into HEAD counts as merged, and one merged into HEAD but behind its
 * upstream does not (measured, git 2.55.0). With neither reference available
 * — an unborn HEAD and no upstream — nothing counts as merged.
 *
 * Both sides are commits, never raw ref values: git runs each through
 * `lookup_commit_reference`, so a reference standing on an annotated tag is
 * measured at the commit that tag names. The reference side uses the gentle
 * lookup git does — one that names no commit at all is not a refusal, it just
 * hands the decision on to HEAD (measured, git 2.55.0).
 */

import type { ObjectId, RefName } from '../../../domain/objects/index.js';
import { refCandidates } from '../../../domain/refs/index.js';
import { shortBranchName } from '../../../domain/refs/short-branch-name.js';
import type { Context } from '../../../ports/context.js';
import { readConfig } from '../../primitives/config-read.js';
import { peelRefToCommit } from '../../primitives/internal/peel-ref-to-commit.js';
import { resolveRefOrMissing } from '../../primitives/resolve-ref.js';
import { isAncestor } from './is-ancestor.js';
import { applyRefspec, parseRefspec } from './ref-spec.js';
import { assertFetchRefspecsValid } from './remote-config.js';

const HEAD_NAME = 'HEAD' as RefName;

/** git's pseudo-remote for "this repository": `branch.<n>.merge` then names a
 *  local ref outright instead of one a fetch refspec has to map. */
const LOCAL_REMOTE = '.';

/** git's `^` marker for a refspec that excludes rather than maps. */
const NEGATIVE_PREFIX = '^';
/** git's `+` marker for a force-updating refspec. */
const FORCE_PREFIX = '+';

/** `tipCommit` is the branch tip already peeled to a commit, the way git's
 *  `check_branch_commit` peels it before consulting the valve at all. */
export const branchMerged = async (
  ctx: Context,
  name: RefName,
  tipCommit: ObjectId,
): Promise<boolean> => {
  const reference = await mergeReference(ctx, name);
  return reference !== undefined && (await isAncestor(ctx, tipCommit, reference));
};

const mergeReference = async (ctx: Context, name: RefName): Promise<ObjectId | undefined> => {
  const upstream = await upstreamRef(ctx, name);
  const upstreamCommit = upstream === undefined ? undefined : await referenceCommit(ctx, upstream);
  return upstreamCommit ?? (await referenceCommit(ctx, HEAD_NAME));
};

/** git's `lookup_commit_reference` over a resolved reference: the commit the
 *  ref names through any annotated-tag chain, `undefined` when it resolves to
 *  nothing or lands on something that is not a commit. */
const referenceCommit = async (ctx: Context, ref: RefName): Promise<ObjectId | undefined> => {
  const tip = await resolveRefOrMissing(ctx, ref);
  if (tip === undefined) return undefined;
  return (await peelRefToCommit(ctx, tip))?.commit.id;
};

/**
 * git's `branch_get_upstream`: the ref `branch.<n>.merge` names once
 * `branch.<n>.remote` has placed it. A merge key without a remote key
 * configures no upstream at all; every remote's own fetch refspecs are asked
 * to map the merge value first, and only the pseudo-remote `.` falls through
 * to a name resolution when none of them does. Any other remote without a
 * mapping refspec leaves no upstream to consult.
 */
const upstreamRef = async (ctx: Context, name: RefName): Promise<RefName | undefined> => {
  const config = await readConfig(ctx);
  const tracking = config.branch?.get(shortBranchName(name));
  const merge = tracking?.merge;
  const remote = tracking?.remote;
  if (merge === undefined || remote === undefined) return undefined;
  // git reaches the remote through `remote_get`, which builds the whole remote
  // table before answering and dies on the first unusable fetch refspec — any
  // remote's, not only the one this branch names.
  assertFetchRefspecsValid(config);
  const mapped = firstMapping(config.remote?.get(remote)?.fetch, merge as RefName);
  if (mapped !== undefined || remote !== LOCAL_REMOTE) return mapped;
  return dwimLocalMerge(ctx, merge);
};

/**
 * git's `repo_dwim_ref` over `branch.<n>.merge` for the pseudo-remote `.`:
 * `set_merge` stores the full ref the value resolves to, and keeps the raw
 * value only when the resolution fails. It counts EVERY candidate namespace
 * that holds the name and resolves only on exactly one — an ambiguous name is
 * no resolution at all.
 */
const dwimLocalMerge = async (ctx: Context, merge: string): Promise<RefName> => {
  const found: RefName[] = [];
  for (const candidate of refCandidates(merge)) {
    if (await candidateResolves(ctx, candidate as RefName)) found.push(candidate as RefName);
  }
  return found.length === 1 ? (found[0] as RefName) : (merge as RefName);
};

/** Whether one dwim candidate names an object, the way `expand_ref` counts it —
 *  a dangling or broken candidate counts for nothing rather than refusing. */
const candidateResolves = async (ctx: Context, candidate: RefName): Promise<boolean> => {
  try {
    return (await resolveRefOrMissing(ctx, candidate)) !== undefined;
  } catch {
    return false;
  }
};

/**
 * Whether `query_refspecs` consults `spec` for a named source at all. It skips
 * a negative refspec and one carrying no destination outright. An EMPTY
 * destination is not skipped there but maps to the empty ref name, which
 * resolves to nothing; and an empty source stands for `HEAD`, which no
 * `branch.<n>.merge` value names. Both reach the same answer by being skipped.
 */
const mapsNamedSource = (spec: string): boolean => {
  if (spec.startsWith(NEGATIVE_PREFIX)) return false;
  const body = spec.startsWith(FORCE_PREFIX) ? spec.slice(1) : spec;
  // git splits on the LAST colon; a ref name can hold none, so the two agree
  // on every spec `assertFetchRefspecsValid` lets through.
  const colon = body.lastIndexOf(':');
  return colon > 0 && colon < body.length - 1;
};

/** The first fetch refspec that maps `ref`, the way git's
 *  `remote_find_tracking` takes the earliest match in config order. */
const firstMapping = (
  specs: ReadonlyArray<string> | undefined,
  ref: RefName,
): RefName | undefined => {
  for (const spec of specs ?? []) {
    if (!mapsNamedSource(spec)) continue;
    const mapped = applyRefspec(parseRefspec(spec), ref);
    if (mapped !== undefined) return mapped;
  }
  return undefined;
};
