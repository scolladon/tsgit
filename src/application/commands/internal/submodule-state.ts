import {
  configInvalidEnumValue,
  configMissingValue,
  workingTreeFileTooLarge,
} from '../../../domain/commands/error.js';
import type { IndexEntry } from '../../../domain/git-index/index.js';
import type { FilePath } from '../../../domain/objects/object-id.js';
import { gitfileTooLarge, notARepository } from '../../../domain/repository/error.js';
import type { Context } from '../../../ports/context.js';
import type { WorkingTreeDelta } from '../../primitives/compare-working-tree-entry.js';
import {
  findLastEntry,
  findLastSubsectionEntry,
  type LocatedConfigEntry,
} from '../../primitives/config-read.js';
import { probeGitlinkCheckout } from '../../primitives/internal/gitlink-head.js';
import { joinPath } from '../../primitives/internal/join-working-tree-path.js';
import { type GitmodulesRow, parseGitmodules } from '../../primitives/parse-gitmodules.js';
import { MAX_GITMODULES_BYTES } from '../../primitives/types.js';
import type { ChangedPath, StatusResult } from '../status.js';

export type SubmoduleState = NonNullable<ChangedPath['submodule']>;

/** The status run inside a checked-out submodule, injected so this module only types `status`. */
export interface SubmoduleDeps {
  readonly childStatus: (child: Context) => Promise<StatusResult>;
}

/** git checks only the `S..U` field of a nested gitlink row: such a row adds untracked changes, not tracked ones. */
const isOnlyUntracked = ({ submodule }: ChangedPath): boolean =>
  submodule?.commitChanged === false &&
  submodule.trackedChanges === false &&
  submodule.untrackedChanges;

const insideOf = (
  result: StatusResult,
): Pick<SubmoduleState, 'trackedChanges' | 'untrackedChanges'> => ({
  trackedChanges: result.unmerged.length > 0 || result.changes.some((row) => !isOnlyUntracked(row)),
  untrackedChanges:
    result.untracked.length > 0 || result.changes.some((row) => row.submodule?.untrackedChanges),
});

/**
 * What git's dirty check reports for a gitlink: the checkout's HEAD moving off the
 * recorded commit, then, once a `.git` that leads to no repository has refused,
 * the submodule's own changes.
 */
export const submoduleState = async (
  ctx: Context,
  entry: IndexEntry,
  delta: WorkingTreeDelta,
  { childStatus }: SubmoduleDeps,
): Promise<SubmoduleState> => {
  const state = {
    commitChanged: delta.status === 'modified',
    trackedChanges: false,
    untrackedChanges: false,
  };
  if (delta.status === 'type-changed') return state;
  const checkout = await probeGitlinkCheckout(ctx, entry.path);
  if (checkout.kind === 'oversized') throw gitfileTooLarge(checkout.shown);
  if (checkout.kind === 'broken') throw notARepository(checkout.shown);
  if (checkout.kind === 'none') return state;
  return { ...state, ...insideOf(await childStatus(await checkout.context())) };
};

export type SubmoduleIgnore = 'none' | 'untracked' | 'dirty' | 'all';

const IGNORE_MODES: ReadonlyArray<SubmoduleIgnore> = ['none', 'untracked', 'dirty', 'all'];
const GITMODULES_FILE = '.gitmodules';

const ignoreModeOf = (value: string): SubmoduleIgnore | undefined =>
  IGNORE_MODES.find((mode) => mode === value);

/** A config value git refuses: valueless, or outside the four modes. */
const configuredMode = ({ key, source, line, value }: LocatedConfigEntry): SubmoduleIgnore => {
  if (value === null) throw configMissingValue(key, source, line);
  const mode = ignoreModeOf(value);
  if (mode === undefined) throw configInvalidEnumValue(key, source, value, line);
  return mode;
};

const configuredOrUndefined = (
  entry: LocatedConfigEntry | undefined,
): SubmoduleIgnore | undefined => (entry === undefined ? undefined : configuredMode(entry));

/**
 * Which ignore mode governs a submodule: its own `.git/config` key, then the
 * `.gitmodules` row (an unknown value there reads as unset, as git warns and moves on),
 * then `diff.ignoreSubmodules`, else `none`. The name is the row whose `path` is the entry's.
 */
export const resolveSubmoduleIgnore = async (
  ctx: Context,
  path: FilePath,
  rows: ReadonlyArray<GitmodulesRow>,
): Promise<SubmoduleIgnore> => {
  const row = rows.find((candidate) => candidate.path === path);
  const own = configuredOrUndefined(
    await findLastSubsectionEntry(ctx, 'submodule', row?.name ?? path, 'ignore'),
  );
  const declared = row?.ignore === undefined ? undefined : ignoreModeOf(row.ignore);
  const shared = configuredOrUndefined(await findLastEntry(ctx, 'diff', 'ignoreSubmodules'));
  return own ?? declared ?? shared ?? 'none';
};

const readWorktreeGitmodules = async (
  ctx: Context,
  workDir: string,
): Promise<ReadonlyArray<GitmodulesRow>> => {
  const path = joinPath(workDir, GITMODULES_FILE);
  if (!(await ctx.fs.exists(path))) return [];
  const { size } = await ctx.fs.stat(path);
  if (size > MAX_GITMODULES_BYTES) {
    throw workingTreeFileTooLarge(path as FilePath, size, MAX_GITMODULES_BYTES);
  }
  return parseGitmodules(await ctx.fs.readUtf8(path));
};

/**
 * The gitlinks whose changes git's `all` mode hides from the working-tree column.
 * Nothing is read for a repository without a gitlink.
 */
export const hiddenSubmodules = async (
  ctx: Context,
  workDir: string,
  gitlinks: ReadonlyArray<FilePath>,
): Promise<ReadonlySet<FilePath>> => {
  if (gitlinks.length === 0) return new Set();
  const rows = await readWorktreeGitmodules(ctx, workDir);
  const modes = await Promise.all(gitlinks.map((path) => resolveSubmoduleIgnore(ctx, path, rows)));
  return new Set(gitlinks.filter((_, at) => modes[at] === 'all'));
};
