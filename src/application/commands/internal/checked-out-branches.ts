/**
 * git's `branch_checked_out` — which worktree, if any, holds a branch.
 * `prepare_checked_out_branches` registers three claims for every non-bare
 * worktree: the branch its HEAD names, the branch an in-progress rebase will
 * reattach, and the branch a bisect started from. A worktree whose HEAD is
 * detached mid-`rebase -i` therefore still holds the branch the rebase is
 * replaying, which is why a HEAD-only predicate misses it.
 */
import { errorDataCode } from '../../../domain/error-data-code.js';
import type { RefName } from '../../../domain/objects/index.js';
import type { FilePath } from '../../../domain/objects/object-id.js';
import { HEADS_PREFIX } from '../../../domain/refs/ref-prefixes.js';
import type { Context } from '../../../ports/context.js';
import { listWorktrees, type WorktreeEntry } from '../../primitives/list-worktrees.js';
import { commonGitDir } from '../../primitives/path-layout.js';

const REBASE_APPLY_DIR = 'rebase-apply';
const REBASE_MERGE_DIR = 'rebase-merge';
const HEAD_NAME_FILE = 'head-name';
/** `rebase-apply/` is shared with `am`, which marks itself with this file and
 *  records no branch of its own. */
const APPLYING_MARKER = 'applying';
const BISECT_LOG_FILE = 'BISECT_LOG';
const BISECT_START_FILE = 'BISECT_START';
/** What a rebase writes into `head-name` when it started from a detached HEAD. */
const DETACHED_HEAD_TEXT = 'detached HEAD';

const readOptionalText = async (ctx: Context, path: string): Promise<string | undefined> => {
  try {
    return await ctx.fs.readUtf8(path);
  } catch (err) {
    if (errorDataCode(err) === 'FILE_NOT_FOUND') return undefined;
    throw err;
  }
};

/**
 * git's `get_branch`, composed back into the full ref its caller builds: the
 * file's text with trailing newlines dropped and any `refs/heads/` prefix
 * stripped, re-prefixed with `refs/heads/`. Empty text and git's literal
 * `detached HEAD` both name nothing. git additionally abbreviates text that
 * parses as a raw oid (a bisect started from a detached HEAD writes one) —
 * that step is display formatting, so the raw text stands here instead; either
 * way the composed name is not one a branch of the same repository carries.
 */
const stateBranch = async (
  ctx: Context,
  adminDir: string,
  relative: string,
): Promise<RefName | undefined> => {
  const raw = await readOptionalText(ctx, `${adminDir}/${relative}`);
  if (raw === undefined) return undefined;
  const text = raw.replace(/\n+$/, '');
  if (text === '' || text === DETACHED_HEAD_TEXT) return undefined;
  const short = text.startsWith(HEADS_PREFIX) ? text.slice(HEADS_PREFIX.length) : text;
  return `${HEADS_PREFIX}${short}` as RefName;
};

/** The branch an in-progress rebase will reattach. `rebase-apply/` is consulted
 *  first and `rebase-merge/` only in its absence, as `wt_status_check_rebase`
 *  does; an `am` under the same directory names no branch. */
const rebasingBranch = async (ctx: Context, adminDir: string): Promise<RefName | undefined> => {
  if (await ctx.fs.exists(`${adminDir}/${REBASE_APPLY_DIR}`)) {
    if (await ctx.fs.exists(`${adminDir}/${REBASE_APPLY_DIR}/${APPLYING_MARKER}`)) return undefined;
    return stateBranch(ctx, adminDir, `${REBASE_APPLY_DIR}/${HEAD_NAME_FILE}`);
  }
  return stateBranch(ctx, adminDir, `${REBASE_MERGE_DIR}/${HEAD_NAME_FILE}`);
};

/** The branch a bisect started from — claimed only while `BISECT_LOG` stands,
 *  the same gate `wt_status_check_bisect` reads. */
const bisectingBranch = async (ctx: Context, adminDir: string): Promise<RefName | undefined> => {
  if (!(await ctx.fs.exists(`${adminDir}/${BISECT_LOG_FILE}`))) return undefined;
  return stateBranch(ctx, adminDir, BISECT_START_FILE);
};

/** A worktree's own per-worktree state directory: the common dir for the main
 *  checkout, its registration directory for a linked one. */
const adminDirOf = (ctx: Context, worktree: WorktreeEntry): string =>
  worktree.id === undefined ? commonGitDir(ctx) : `${commonGitDir(ctx)}/worktrees/${worktree.id}`;

/** Every branch `worktree` holds; a bare checkout holds none. */
const branchesHeldBy = async (
  ctx: Context,
  worktree: WorktreeEntry,
): Promise<ReadonlyArray<RefName>> => {
  if (worktree.bare) return [];
  const adminDir = adminDirOf(ctx, worktree);
  const claims = [
    worktree.branch,
    await rebasingBranch(ctx, adminDir),
    await bisectingBranch(ctx, adminDir),
  ];
  // Equivalent mutant, deliberately not suppressed — a line-level disable would also silence the detected mutants sharing this line. the only consumer asks `includes(name)` for a concrete RefName, which no undefined claim can equal, so keeping them changes no answer.
  return claims.filter((claim): claim is RefName => claim !== undefined);
};

/**
 * The worktree holding `name`, or `undefined` when none does. git's map keeps
 * the LAST registration for a branch two worktrees both claim, so the walk
 * reports the last holder rather than the first.
 */
export const worktreeHolding = async (
  ctx: Context,
  name: RefName,
): Promise<FilePath | undefined> => {
  let holder: FilePath | undefined;
  for (const worktree of await listWorktrees(ctx)) {
    if ((await branchesHeldBy(ctx, worktree)).includes(name)) holder = worktree.path;
  }
  return holder;
};
