/**
 * git's `branch_merged` — the safety valve `branch -d` runs and `-D` skips.
 *
 * The reference a tip is measured against is the branch's configured upstream
 * when one RESOLVES, and HEAD otherwise. An upstream REPLACES HEAD rather
 * than widening the test: a branch merged into its upstream but not into HEAD
 * counts as merged, and one merged into HEAD but behind its upstream does
 * not (measured, git 2.55.0). With neither reference available — an unborn
 * HEAD and no upstream — nothing counts as merged.
 */

import type { ObjectId, RefName } from '../../../domain/objects/index.js';
import { shortBranchName } from '../../../domain/refs/short-branch-name.js';
import type { Context } from '../../../ports/context.js';
import { readConfig } from '../../primitives/config-read.js';
import { resolveRefOrMissing } from '../../primitives/resolve-ref.js';
import { isAncestor } from './is-ancestor.js';
import { applyRefspec, parseRefspec } from './ref-spec.js';

const HEAD_NAME = 'HEAD' as RefName;

/** git's pseudo-remote for "this repository": `branch.<n>.merge` then names a
 *  local ref outright instead of one a fetch refspec has to map. */
const LOCAL_REMOTE = '.';

export const branchMerged = async (
  ctx: Context,
  name: RefName,
  tip: ObjectId,
): Promise<boolean> => {
  const reference = await mergeReference(ctx, name);
  return reference !== undefined && (await isAncestor(ctx, tip, reference));
};

const mergeReference = async (ctx: Context, name: RefName): Promise<ObjectId | undefined> => {
  const upstream = await upstreamRef(ctx, name);
  const upstreamTip = upstream === undefined ? undefined : await resolveRefOrMissing(ctx, upstream);
  return upstreamTip ?? (await resolveRefOrMissing(ctx, HEAD_NAME));
};

/**
 * git's `branch_get_upstream`: the ref `branch.<n>.merge` names once
 * `branch.<n>.remote` has placed it. A merge key without a remote key
 * configures no upstream at all; the pseudo-remote `.` takes the merge ref
 * verbatim; any other remote must carry a fetch refspec that maps it, and
 * without one there is no upstream to consult.
 */
const upstreamRef = async (ctx: Context, name: RefName): Promise<RefName | undefined> => {
  const config = await readConfig(ctx);
  const tracking = config.branch?.get(shortBranchName(name));
  const merge = tracking?.merge;
  const remote = tracking?.remote;
  if (merge === undefined || remote === undefined) return undefined;
  if (remote === LOCAL_REMOTE) return merge as RefName;
  return firstMapping(config.remote?.get(remote)?.fetch, merge as RefName);
};

/** The first fetch refspec that maps `ref`, the way git's
 *  `remote_find_tracking` takes the earliest match in config order. */
const firstMapping = (
  specs: ReadonlyArray<string> | undefined,
  ref: RefName,
): RefName | undefined => {
  for (const spec of specs ?? []) {
    const mapped = applyRefspec(parseRefspec(spec), ref);
    if (mapped !== undefined) return mapped;
  }
  return undefined;
};
