import { badBranchMergeOptions } from '../../../domain/commands/error.js';
import { splitCmdline } from '../../../domain/config/split-cmdline.js';
import {
  type MergeCommandLine,
  parseMergeCommandLine,
} from '../../../domain/merge/merge-command-line.js';
import type { RefName } from '../../../domain/objects/index.js';
import { shortBranchName } from '../../../domain/refs/short-branch-name.js';
import type { Context } from '../../../ports/context.js';
import { findLastSubsectionEntry } from '../../primitives/config-read.js';

const NONE: MergeCommandLine = {};

/**
 * git's `parse_branch_merge_options`: the current branch's
 * `branch.<b>.mergeoptions`, split as `split_cmdline` does and parsed as
 * merge's own command line. A detached HEAD reads none.
 */
export const branchMergeOptions = async (
  ctx: Context,
  branch: RefName | undefined,
): Promise<MergeCommandLine> => {
  if (branch === undefined) return NONE;
  const name = shortBranchName(branch);
  const entry = await findLastSubsectionEntry(ctx, 'branch', name, 'mergeoptions');
  if (entry === undefined || entry.value === null) return NONE;
  const split = splitCmdline(entry.value);
  if (split.kind === 'error') throw badBranchMergeOptions(name, split.reason);
  return parseMergeCommandLine(split.argv);
};
