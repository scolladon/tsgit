import {
  configInvalidEnumValue,
  configMissingValue,
  workingTreeFileTooLarge,
} from '../../../domain/commands/error.js';
import type { IndexEntry } from '../../../domain/git-index/index.js';
import { FILE_MODE, type FileMode } from '../../../domain/objects/index.js';
import type { FilePath, ObjectId } from '../../../domain/objects/object-id.js';
import { gitfileTooLarge, notARepository } from '../../../domain/repository/error.js';
import { submodulePathIsSymlink } from '../../../domain/submodule/error.js';
import type { Context } from '../../../ports/context.js';
import type { WorkingTreeDelta } from '../../primitives/compare-working-tree-entry.js';
import {
  findLastEntry,
  findLastSubsectionEntry,
  type LocatedConfigEntry,
} from '../../primitives/config-read.js';
import {
  type GitlinkCheckout,
  probeGitlinkCheckout,
} from '../../primitives/internal/gitlink-head.js';
import { joinPath } from '../../primitives/internal/join-working-tree-path.js';
import { findTreeEntry } from '../../primitives/internal/resolve-tree-path.js';
import { type GitmodulesRow, parseGitmodules } from '../../primitives/parse-gitmodules.js';
import { readBlob } from '../../primitives/read-blob.js';
import { resolveRefOrMissing } from '../../primitives/resolve-ref.js';
import { MAX_GITMODULES_BYTES } from '../../primitives/types.js';
import type { ChangedPath, StatusResult } from '../status.js';
import { treeOf } from './history-rewrite.js';

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

export type RepositoryCheckout = Extract<GitlinkCheckout, { readonly kind: 'repository' }>;

/** The repository a gitlink's `.git` leads to, refusing one git cannot read as git does; `undefined` when nothing is checked out there. */
export const populatedCheckout = async (
  ctx: Context,
  path: FilePath,
): Promise<RepositoryCheckout | undefined> => {
  const checkout = await probeGitlinkCheckout(ctx, path);
  if (checkout.kind === 'oversized') throw gitfileTooLarge(checkout.shown);
  if (checkout.kind === 'broken') throw notARepository(checkout.shown);
  return checkout.kind === 'none' ? undefined : checkout;
};

/** The submodule's own changes, read once its `.git` leads to a repository; one that leads to none refuses. */
const insideState = async (
  ctx: Context,
  { path }: IndexEntry,
  state: SubmoduleState,
  { childStatus }: SubmoduleDeps,
): Promise<SubmoduleState> => {
  const checkout = await populatedCheckout(ctx, path);
  if (checkout === undefined) return state;
  return { ...state, ...insideOf(await childStatus(await checkout.context())) };
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
 * Which ignore mode governs a submodule: its own `.git/config` key under the name the
 * `.gitmodules` row gives it, then the row's own value (an unknown value there reads as
 * unset, as git warns and moves on), then `diff.ignoreSubmodules`, else `none`. Without a
 * row git reads no per-submodule key at all, so only the shared mode applies.
 */
export const resolveSubmoduleIgnore = async (
  ctx: Context,
  path: FilePath,
  rows: ReadonlyArray<GitmodulesRow>,
  shared: SubmoduleIgnore | undefined,
): Promise<SubmoduleIgnore> =>
  (await configuredSubmoduleIgnore(ctx, path, rows)) ?? shared ?? 'none';

/**
 * The ignore mode a submodule's own configuration declares — git's
 * submodule-config diff flags: the `.git/config` key under the `.gitmodules`
 * name, else the row's value; nothing without a row, and nothing from `diff.ignoreSubmodules`.
 */
export const configuredSubmoduleIgnore = async (
  ctx: Context,
  path: FilePath,
  rows: ReadonlyArray<GitmodulesRow>,
): Promise<SubmoduleIgnore | undefined> => {
  const row = rows.find((candidate) => candidate.path === path);
  if (row === undefined) return undefined;
  const own = configuredOrUndefined(
    await findLastSubsectionEntry(ctx, 'submodule', row.name, 'ignore'),
  );
  return own ?? (row.ignore === undefined ? undefined : ignoreModeOf(row.ignore));
};

/** Where `.gitmodules` is read from: the working tree, else the blob the index records; the whole index tells an unmerged one. */
export interface GitmodulesSource {
  readonly workDir: string;
  readonly entries: ReadonlyArray<IndexEntry>;
}

/** git's `is_gitmodules_unmerged`: a `.gitmodules` entry at any stage above zero. */
const isGitmodulesUnmerged = (entries: ReadonlyArray<IndexEntry>): boolean =>
  entries.some((entry) => entry.path === GITMODULES_FILE && entry.flags.stage !== 0);

const stagedGitmodulesOf = (entries: ReadonlyArray<IndexEntry>): IndexEntry | undefined =>
  entries.find((entry) => entry.path === GITMODULES_FILE);

/** The blob git's `HEAD:.gitmodules` names, when HEAD records one. */
const headGitmodulesBlob = async (ctx: Context): Promise<ObjectId | undefined> => {
  const head = await resolveRefOrMissing(ctx, 'HEAD');
  if (head === undefined) return undefined;
  const entry = await findTreeEntry(ctx, await treeOf(ctx, head), GITMODULES_FILE);
  if (entry === undefined || NON_BLOB_MODES.has(entry.mode)) return undefined;
  return entry.id;
};

const NON_BLOB_MODES: ReadonlySet<FileMode> = new Set([FILE_MODE.DIRECTORY, FILE_MODE.GITLINK]);

/** The recorded `.gitmodules` git falls back to without a working file: the staged blob, else HEAD's. Callers have settled that the entries hold it merged, as git reads none otherwise. */
export const readRecordedGitmodules = async (
  ctx: Context,
  entries: ReadonlyArray<IndexEntry>,
): Promise<ReadonlyArray<GitmodulesRow>> => {
  const id = stagedGitmodulesOf(entries)?.id ?? (await headGitmodulesBlob(ctx));
  if (id === undefined) return [];
  const blob = await readBlob(ctx, id, { maxBytes: MAX_GITMODULES_BYTES });
  return parseGitmodules(new TextDecoder().decode(blob.content));
};

/** The working `.gitmodules` text, `undefined` without one; a file past the bound refuses before it is read. */
export const readWorkingGitmodules = async (
  ctx: Context,
  workDir: string,
): Promise<string | undefined> => {
  const path = joinPath(workDir, GITMODULES_FILE);
  if (!(await ctx.fs.exists(path))) return undefined;
  const { size } = await ctx.fs.stat(path);
  if (size > MAX_GITMODULES_BYTES) {
    throw workingTreeFileTooLarge(path as FilePath, size, MAX_GITMODULES_BYTES);
  }
  return ctx.fs.readUtf8(path);
};

/**
 * The `.gitmodules` rows git's `submodule_from_path` consults: the working file, else the staged
 * blob, else HEAD's — and none at all while the index holds `.gitmodules` unmerged, as
 * `repo_read_gitmodules` skips the whole read then.
 */
export const readGitmodulesRows = async (
  ctx: Context,
  { workDir, entries }: GitmodulesSource,
): Promise<ReadonlyArray<GitmodulesRow>> => {
  if (isGitmodulesUnmerged(entries)) return [];
  const text = await readWorkingGitmodules(ctx, workDir);
  return text === undefined ? readRecordedGitmodules(ctx, entries) : parseGitmodules(text);
};

/** `diff.ignoreSubmodules`, which git parses on every run whether or not a submodule exists. */
const sharedIgnore = async (ctx: Context): Promise<SubmoduleIgnore | undefined> =>
  configuredOrUndefined(await findLastEntry(ctx, 'diff', 'ignoreSubmodules'));

/**
 * The ignore mode of each gitlink. `diff.ignoreSubmodules` is validated up front;
 * nothing else is read for a repository without a gitlink, nor under a forced mode.
 */
export const submoduleIgnores = async (
  ctx: Context,
  gitmodules: GitmodulesSource,
  gitlinks: ReadonlyArray<FilePath>,
  forced?: SubmoduleIgnore,
): Promise<ReadonlyMap<FilePath, SubmoduleIgnore>> => {
  const shared = await sharedIgnore(ctx);
  // git's `--ignore-submodules=<mode>` on the command line overrides every configured mode.
  if (forced !== undefined) return new Map(gitlinks.map((path) => [path, forced]));
  if (gitlinks.length === 0) return new Map();
  const rows = await readGitmodulesRows(ctx, gitmodules);
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
