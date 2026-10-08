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
 * measured at the commit that tag names. A reference that names no commit at
 * all is not a refusal: git reports it on `error:` and hands the decision on
 * to HEAD. When upstream and HEAD disagree, git warns which way it decided
 * (measured, git 2.55.0).
 */

import type { ObjectId, RefName } from '../../../domain/objects/index.js';
import { shortBranchName } from '../../../domain/refs/short-branch-name.js';
import type { Context } from '../../../ports/context.js';
import { readConfig } from '../../primitives/config-read.js';
import { lookupTypedCommitReference } from '../../primitives/internal/lookup-commit-reference.js';
import {
  createObjectTypeTable,
  type ObjectTypeTable,
} from '../../primitives/internal/object-type-table.js';
import { resolveRefOrMissing, resolveTerminalName } from '../../primitives/resolve-ref.js';
import { isAncestor } from './is-ancestor.js';
import { applyRefspec, parseRefspec } from './ref-spec.js';
import { buildRemoteTable } from './remote-config.js';
import { resolvingCandidateRefs } from './revision-name.js';

const HEAD_NAME = 'HEAD' as RefName;

/** git's pseudo-remote for "this repository": `branch.<n>.merge` then names a
 *  local ref outright instead of one a fetch refspec has to map. */
const LOCAL_REMOTE = '.';

/** git's `^` marker for a refspec that excludes rather than maps. */
const NEGATIVE_PREFIX = '^';
/** git's `+` marker for a force-updating refspec. */
const FORCE_PREFIX = '+';

/** What an unforced delete measures against: the commit HEAD names, and the
 *  object table every lookup and walk of the call shares with it. */
export interface MergeValve {
  readonly table: ObjectTypeTable;
  readonly head: ObjectId | undefined;
}

/** git's `delete_branches` prologue: HEAD is looked up first — before any
 *  branch is checked or resolved — into a fresh table for the whole call. */
export const openMergeValve = async (ctx: Context): Promise<MergeValve> => {
  const table = createObjectTypeTable();
  return { table, head: await referenceCommit(ctx, table, HEAD_NAME) };
};

/** `tipCommit` is the branch tip already looked up into the valve's table,
 *  the way git's `check_branch_commit` does before consulting it at all. */
export const branchMerged = async (
  ctx: Context,
  name: RefName,
  tipCommit: ObjectId,
  { table, head }: MergeValve,
): Promise<boolean> => {
  const upstream = await upstreamReference(ctx, table, name);
  if (upstream === undefined || upstream.commit === head) {
    return head !== undefined && (await isAncestor(ctx, tipCommit, head, table));
  }
  const merged = await isAncestor(ctx, tipCommit, upstream.commit, table);
  const mergedToHead = head !== undefined && (await isAncestor(ctx, tipCommit, head, table));
  if (merged !== mergedToHead) {
    warnUpstreamDisagrees(ctx, name, upstream.name, merged ? 'upstream-only' : 'head-only');
  }
  return merged;
};

interface UpstreamReference {
  /** The ref the upstream's symbolic chain ends at — the name git's warning carries. */
  readonly name: RefName;
  readonly commit: ObjectId;
}

/** Which side the branch is merged to when upstream and HEAD disagree. */
type MergedOnlyTo = 'upstream-only' | 'head-only';

const DISAGREEMENT_WARNINGS: Readonly<
  Record<MergedOnlyTo, (branch: string, upstream: RefName) => string>
> = {
  'upstream-only': (branch, upstream) =>
    `deleting branch '${branch}' that has been merged to\n         '${upstream}', but not yet merged to HEAD`,
  'head-only': (branch, upstream) =>
    `not deleting branch '${branch}' that is not yet merged to\n         '${upstream}', even though it is merged to HEAD`,
};

/** git's transition-period reminder: upstream and HEAD disagree on whether the branch is merged. */
const warnUpstreamDisagrees = (
  ctx: Context,
  name: RefName,
  upstream: RefName,
  mergedOnlyTo: MergedOnlyTo,
): void => {
  const branch = shortBranchName(name);
  const merged = mergedOnlyTo === 'upstream-only';
  ctx.logger?.warn?.(DISAGREEMENT_WARNINGS[mergedOnlyTo](branch, upstream), {
    branch,
    upstream,
    merged,
  });
};

const upstreamReference = async (
  ctx: Context,
  table: ObjectTypeTable,
  name: RefName,
): Promise<UpstreamReference | undefined> => {
  const upstream = await upstreamRef(ctx, name);
  const terminal = upstream === undefined ? undefined : await resolveTerminalName(ctx, upstream);
  if (terminal === undefined) return undefined;
  const commit = await referenceCommit(ctx, table, terminal);
  return commit === undefined ? undefined : { name: terminal, commit };
};

/** git's `lookup_commit_reference` over a resolved reference, against the
 *  call's table: the commit the ref names through any annotated-tag chain,
 *  `undefined` when it resolves to nothing or that lookup fails. */
const referenceCommit = async (
  ctx: Context,
  table: ObjectTypeTable,
  ref: RefName,
): Promise<ObjectId | undefined> => {
  const tip = await resolveRefOrMissing(ctx, ref);
  if (tip === undefined) return undefined;
  return lookupTypedCommitReference(ctx, table, tip);
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
  await buildRemoteTable(ctx);
  const config = await readConfig(ctx);
  const tracking = config.branch?.get(shortBranchName(name));
  const merge = tracking?.merge;
  const remote = tracking?.remote;
  if (merge === undefined || remote === undefined) return undefined;
  const mapped = firstMapping(config.remote?.get(remote)?.fetch, merge as RefName);
  if (mapped !== undefined || remote !== LOCAL_REMOTE) return mapped;
  return dwimLocalMerge(ctx, merge);
};

/**
 * git's `repo_dwim_ref` over `branch.<n>.merge` for the pseudo-remote `.`:
 * `set_merge` stores the full ref the value resolves to, and keeps the raw
 * value unless exactly one namespace resolves — an ambiguous name is no
 * resolution at all, and each skipped namespace warns.
 */
const dwimLocalMerge = async (ctx: Context, merge: string): Promise<RefName> => {
  const found = await resolvingCandidateRefs(ctx, merge);
  return found.length === 1 ? (found[0] as RefName) : (merge as RefName);
};

/**
 * Whether `query_refspecs` consults `spec` for a named source at all. It skips
 * a negative refspec and one carrying no destination outright. An EMPTY
 * destination is not skipped there but maps to the empty ref name, which
 * resolves to nothing; and an empty source stands for `HEAD`, which no
 * `branch.<n>.merge` value names. Both reach the same answer by being skipped.
 */
export const mapsNamedSource = (spec: string): boolean => {
  // Stryker disable next-line MethodExpression: equivalent — `^` is a forbidden ref-name character, so no spec `assertRemoteRefspecsValid` lets through ENDS with one; the flipped probe never fires, and the colon test below then rejects the negative spec anyway, since a validated one carries no colon at all.
  if (spec.startsWith(NEGATIVE_PREFIX)) return false;
  const body = spec.startsWith(FORCE_PREFIX) ? spec.slice(1) : spec;
  // git splits on the LAST colon; a ref name can hold none, so the two agree
  // on every spec `assertRemoteRefspecsValid` lets through.
  const colon = body.lastIndexOf(':');
  return colon > 0 && colon < body.length - 1;
};

/** The first fetch refspec that maps `ref`, the way git's
 *  `remote_find_tracking` takes the earliest match in config order. */
const firstMapping = (
  specs: ReadonlyArray<string> | undefined,
  ref: RefName,
): RefName | undefined => {
  // Stryker disable next-line ArrayDeclaration: equivalent — the fallback only stands in for a remote with no fetch refspec, and any element put in its place holds no colon, so mapsNamedSource passes it over and the loop still ends in `undefined`.
  for (const spec of specs ?? []) {
    if (!mapsNamedSource(spec)) continue;
    const mapped = applyRefspec(parseRefspec(spec), ref);
    if (mapped !== undefined) return mapped;
  }
  return undefined;
};
