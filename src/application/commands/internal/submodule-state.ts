import {
  configInvalidEnumValue,
  configMissingValue,
  workingTreeFileTooLarge,
} from '../../../domain/commands/error.js';
import type { IndexEntry } from '../../../domain/git-index/index.js';
import { FILE_MODE } from '../../../domain/objects/index.js';
import type { FilePath } from '../../../domain/objects/object-id.js';
import { gitfileTooLarge, notARepository } from '../../../domain/repository/error.js';
import { submodulePathIsSymlink } from '../../../domain/submodule/error.js';
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
import { readBlob } from '../../primitives/read-blob.js';
import { MAX_GITMODULES_BYTES } from '../../primitives/types.js';
import type { ChangedPath, StatusResult } from '../status.js';

export type SubmoduleState = NonNullable<ChangedPath['submodule']>;

/** The status run inside a checked-out submodule, injected so this module only types `status`. */
export interface SubmoduleDeps {
  readonly childStatus: (child: Context) => Promise<StatusResult>;
  readonly ignore: SubmoduleIgnore;
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

/** git refuses a symlink where a submodule belongs unless `dirty` stops it looking; any other file there is only a type change. */
const refuseSymlink = (
  { path }: IndexEntry,
  { worktreeMode }: WorkingTreeDelta,
  ignore: SubmoduleIgnore,
  state: SubmoduleState,
): SubmoduleState => {
  if (worktreeMode === FILE_MODE.SYMLINK && ignore !== 'dirty') throw submodulePathIsSymlink(path);
  return state;
};

/** The submodule's own changes, read once its `.git` leads to a repository; one that leads to none refuses. */
const insideState = async (
  ctx: Context,
  { path }: IndexEntry,
  state: SubmoduleState,
  { childStatus, ignore }: SubmoduleDeps,
): Promise<SubmoduleState> => {
  const checkout = await probeGitlinkCheckout(ctx, path);
  if (checkout.kind === 'oversized') throw gitfileTooLarge(checkout.shown);
  if (checkout.kind === 'broken') throw notARepository(checkout.shown);
  if (checkout.kind === 'none') return state;
  const inside = insideOf(await childStatus(await checkout.context()));
  return {
    ...state,
    ...inside,
    untrackedChanges: inside.untrackedChanges && ignore !== 'untracked',
  };
};

/**
 * What git's dirty check reports for a gitlink: the checkout's HEAD moving off the
 * recorded commit, then, unless the mode stops at the commit, the submodule's own changes.
 */
export const submoduleState = async (
  ctx: Context,
  entry: IndexEntry,
  delta: WorkingTreeDelta,
  deps: SubmoduleDeps,
): Promise<SubmoduleState> => {
  const state = {
    commitChanged: delta.status === 'modified',
    trackedChanges: false,
    untrackedChanges: false,
  };
  if (delta.status === 'type-changed') return refuseSymlink(entry, delta, deps.ignore, state);
  if (deps.ignore === 'dirty') return state;
  return insideState(ctx, entry, state, deps);
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
  shared: SubmoduleIgnore | undefined,
): Promise<SubmoduleIgnore> => {
  const row = rows.find((candidate) => candidate.path === path);
  const own = configuredOrUndefined(
    await findLastSubsectionEntry(ctx, 'submodule', row?.name ?? path, 'ignore'),
  );
  const declared = row?.ignore === undefined ? undefined : ignoreModeOf(row.ignore);
  return own ?? declared ?? shared ?? 'none';
};

/** Where `.gitmodules` is read from: the working tree, else the blob the index holds. */
export interface GitmodulesSource {
  readonly workDir: string;
  readonly stage0: ReadonlyMap<FilePath, IndexEntry>;
}

const readIndexedGitmodules = async (
  ctx: Context,
  stage0: ReadonlyMap<FilePath, IndexEntry>,
): Promise<ReadonlyArray<GitmodulesRow>> => {
  const indexed = stage0.get(GITMODULES_FILE as FilePath);
  if (indexed === undefined) return [];
  const blob = await readBlob(ctx, indexed.id, { maxBytes: MAX_GITMODULES_BYTES });
  return parseGitmodules(new TextDecoder().decode(blob.content));
};

const readGitmodules = async (
  ctx: Context,
  { workDir, stage0 }: GitmodulesSource,
): Promise<ReadonlyArray<GitmodulesRow>> => {
  const path = joinPath(workDir, GITMODULES_FILE);
  if (!(await ctx.fs.exists(path))) return readIndexedGitmodules(ctx, stage0);
  const { size } = await ctx.fs.stat(path);
  if (size > MAX_GITMODULES_BYTES) {
    throw workingTreeFileTooLarge(path as FilePath, size, MAX_GITMODULES_BYTES);
  }
  return parseGitmodules(await ctx.fs.readUtf8(path));
};

/** `diff.ignoreSubmodules`, which git parses on every run whether or not a submodule exists. */
const sharedIgnore = async (ctx: Context): Promise<SubmoduleIgnore | undefined> =>
  configuredOrUndefined(await findLastEntry(ctx, 'diff', 'ignoreSubmodules'));

/**
 * The ignore mode of each gitlink. `diff.ignoreSubmodules` is validated up front;
 * nothing else is read for a repository without a gitlink.
 */
export const submoduleIgnores = async (
  ctx: Context,
  gitmodules: GitmodulesSource,
  gitlinks: ReadonlyArray<FilePath>,
): Promise<ReadonlyMap<FilePath, SubmoduleIgnore>> => {
  const shared = await sharedIgnore(ctx);
  if (gitlinks.length === 0) return new Map();
  const rows = await readGitmodules(ctx, gitmodules);
  const modes = await Promise.all(
    gitlinks.map(
      async (path): Promise<readonly [FilePath, SubmoduleIgnore]> => [
        path,
        await resolveSubmoduleIgnore(ctx, path, rows, shared),
      ],
    ),
  );
  return new Map(modes);
};
