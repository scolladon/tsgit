/**
 * `rm` porcelain — remove tracked paths from the index (and the working tree
 * unless `cached`), faithful to `git rm`. Before removing, the same safety valve
 * `git rm` runs (`check_local_mod`) refuses paths whose removal would lose
 * un-recoverable changes, unless `force` (or, per category, `cached`) overrides.
 * The resulting index + tree read back (via `git ls-files --stage` /
 * `git write-tree`) match canonical git; raw index bytes differ only by per-host
 * stat-cache fields.
 *
 * @writes
 *   surface: rm
 *   kind:    equivalent-under-readback
 *   format:  git-index-tree-state
 */
import {
  pathspecNoMatch,
  rmLocalModifications,
  rmRecursiveWithoutR,
  rmStagedAndLocalChanges,
  rmStagedChanges,
} from '../../domain/commands/error.js';
import type { FlatTreeEntry } from '../../domain/diff/flat-tree.js';
import { dirname, TsgitError } from '../../domain/error.js';
import type { GitIndex, IndexEntry } from '../../domain/git-index/index.js';
import type { IndexPathKey } from '../../domain/git-index/index-path-key.js';
import {
  escapedPathOf,
  indexPathKey,
  isLossy,
  keyOfPath,
} from '../../domain/git-index/index-path-key.js';
import {
  type ResolveUndoRecord,
  resolveUndoRecordOf,
} from '../../domain/git-index/resolve-undo.js';
import { emptyPathspec } from '../../domain/index.js';
import { FILE_MODE } from '../../domain/objects/index.js';
import type { FilePath, ObjectId } from '../../domain/objects/object-id.js';
import { MATCH_LEVEL, type MatchLevel } from '../../domain/pathspec/wildcard.js';
import { gitmodulesNotStaged, submoduleNameNotFound } from '../../domain/submodule/error.js';
import { relativePathBetween, submoduleGitfile } from '../../domain/submodule/gitlink-path.js';
import type { Context } from '../../ports/context.js';
import {
  compareWorkingTreeDelta,
  isWorkingTreeModified,
  type WorkingTreeDelta,
} from '../primitives/compare-working-tree-entry.js';
import { indexEntryFromStat } from '../primitives/internal/index-entry-from-stat.js';
import { joinPath } from '../primitives/internal/join-working-tree-path.js';
import {
  pruneEmptiedDirectories,
  survivingDirectoriesOf,
} from '../primitives/internal/prune-emptied-directories.js';
import { buildCheckinAttributeProvider } from '../primitives/internal/read-gitattributes.js';
import { deriveGitlinkContext } from '../primitives/internal/submodule-context.js';
import { type GitmodulesRow, parseGitmodules } from '../primitives/parse-gitmodules.js';
import { readHeadTreeEscaped } from '../primitives/read-head-tree.js';
import { readIndex } from '../primitives/read-index.js';
import { updateConfigOperations } from '../primitives/update-config.js';
import { removeConfigSectionInText } from '../primitives/update-config-sections.js';
import { writeObject } from '../primitives/write-object.js';
import { acquireIndexLock } from './internal/index-update.js';
import {
  type PositivePathspec,
  resolveCommandPathspec,
  trackPositives,
} from './internal/pathspec-intake.js';
import { assertOperationalRepository, requireWorkTree } from './internal/repo-state.js';
import { submoduleState } from './internal/submodule-state.js';
import { removeDirectory, removeFile } from './internal/working-tree.js';
import { status } from './status.js';

const GITMODULES_FILE = '.gitmodules' as FilePath;

// A predicate (not a static Set) so Stryker attributes per-test coverage to
// each literal — a module-level `new Set([...])` initializer runs before any
// test, leaving its string mutants unattributed under `coverageAnalysis`.
const isIndexMissingCode = (code: string): boolean =>
  code === 'FILE_NOT_FOUND' || code === 'INVALID_INDEX_HEADER' || code === 'INVALID_INDEX_ENTRY';

export interface RmOptions {
  readonly cached?: boolean;
  /** Override the safety valve (`-f`) — remove even staged / locally-modified paths. */
  readonly force?: boolean;
  /** Allow a pathspec to remove a whole directory (`-r`); without it, git refuses. */
  readonly recursive?: boolean;
}

export interface RmResult {
  readonly removed: ReadonlyArray<FilePath>;
}

/**
 * Remove the given paths from the index (and from the working tree unless
 * `cached: true`). Refuses when a path isn't tracked, matches `git rm`'s default.
 */
export const rm = async (
  ctx: Context,
  paths: ReadonlyArray<string>,
  opts: RmOptions = {},
): Promise<RmResult> => {
  await assertOperationalRepository(ctx);
  const workDir = requireWorkTree(ctx, 'rm');
  if (paths.length === 0) throw emptyPathspec();
  const { matcher, positives } = resolveCommandPathspec(ctx, paths);
  const lock = await acquireIndexLock(ctx);
  try {
    const index = await readIndex(ctx).catch((err: unknown) => {
      if (err instanceof TsgitError && isIndexMissingCode(err.data.code)) {
        return {
          entries: [] as ReadonlyArray<IndexEntry>,
          indexMtime: undefined as GitIndex['indexMtime'],
        };
      }
      throw err;
    });
    const byPath = groupByPath(index.entries);
    const removed: FilePath[] = [];
    const removedKeys: IndexPathKey[] = [];
    const removedGroups: ReadonlyArray<IndexEntry>[] = [];
    const tracker = trackPositives(matcher, positives);
    for (const [key, stages] of byPath) {
      const [first] = stages as readonly [IndexEntry, ...IndexEntry[]];
      if (tracker.observe(escapedPathOf(first)).matched) {
        removed.push(first.path);
        removedKeys.push(key);
        removedGroups.push(stages);
      }
    }
    enforcePositiveLevels(positives, tracker.highest(), opts.recursive === true);
    const removedEntries = removedGroups.flat().filter(isStageZero);
    if (opts.force !== true) {
      await enforceSafetyValve(ctx, removedEntries, opts.cached === true, index.indexMtime);
    }
    await enforceGitmodulesStaged(ctx, index.entries, index.indexMtime, removedEntries);
    for (const key of removedKeys) byPath.delete(key);
    if (!opts.cached) {
      const gitmodules = await removeFromWorkTree(ctx, workDir, removedGroups);
      if (gitmodules !== undefined) byPath.set(keyOfPath(GITMODULES_FILE), [gitmodules]);
    }
    await lock.commit(Array.from(byPath.values()).flat(), 'update', {
      resolveUndo: resolvedRecordsOf(removedGroups),
    });
    return { removed };
  } finally {
    await lock.release();
  }
};

/** Remove the working-tree side of the matched entries; the staged `.gitmodules` it edited, if any. */
const removeFromWorkTree = async (
  ctx: Context,
  workDir: string,
  removedGroups: ReadonlyArray<ReadonlyArray<IndexEntry>>,
): Promise<IndexEntry | undefined> => {
  const entries = removedGroups
    .map(([first]) => first as IndexEntry)
    .filter((entry) => !isLossy(entry));
  const gitlinks = entries.filter((entry) => entry.mode === FILE_MODE.GITLINK);
  const gitmodules = await readGitmodules(ctx, workDir, gitlinks);
  await enforceEmbeddedNamed(ctx, workDir, gitlinks, gitmodules);
  await removeWorkingTree(ctx, entries, gitmodules);
  await pruneEmptiedDirectories(
    ctx,
    workDir,
    entries.map((entry) => entry.path),
    survivingDirectoriesOf([]),
  );
  return dropGitmodulesSections(ctx, workDir, gitlinks, gitmodules);
};

interface Gitmodules {
  readonly text: string;
  readonly rows: ReadonlyArray<GitmodulesRow>;
}

/** The working `.gitmodules`, read only when a gitlink is about to go; absent file, no rows. */
const readGitmodules = async (
  ctx: Context,
  workDir: string,
  gitlinks: ReadonlyArray<IndexEntry>,
): Promise<Gitmodules> => {
  const file = joinPath(workDir, GITMODULES_FILE);
  if (gitlinks.length === 0 || !(await ctx.fs.exists(file))) return { text: '', rows: [] };
  const text = await ctx.fs.readUtf8(file);
  return { text, rows: parseGitmodules(text) };
};

const submoduleNameOf = (gitmodules: Gitmodules, path: FilePath): string =>
  gitmodules.rows.find((row) => row.path === path)?.name ?? path;

/** FILE_NOT_FOUND is the only tolerable error: the working path is already gone. */
const removeWorkingTree = async (
  ctx: Context,
  entries: ReadonlyArray<IndexEntry>,
  gitmodules: Gitmodules,
): Promise<void> => {
  for (const entry of entries) {
    await removeFromDisk(ctx, entry, gitmodules).catch((err: unknown) => {
      if (err instanceof TsgitError && err.data.code === 'FILE_NOT_FOUND') return;
      throw err;
    });
  }
};

const removeFromDisk = (ctx: Context, entry: IndexEntry, gitmodules: Gitmodules): Promise<void> =>
  entry.mode === FILE_MODE.GITLINK
    ? removeSubmodule(ctx, entry.path, submoduleNameOf(gitmodules, entry.path))
    : removeFile(ctx, entry.path);

/** An uninitialized submodule has no directory; git removes only its index entry. */
const removeSubmodule = async (ctx: Context, path: FilePath, name: string): Promise<void> => {
  const directory = joinPath(requireWorkTree(ctx, 'rm'), path);
  if ((await ctx.fs.lstat(directory).catch(() => undefined)) === undefined) return;
  await migrateGitDir(ctx, path, name);
  await removeDirectory(ctx, path);
};

/** Whether the submodule carries its repository as a `.git` directory rather than a gitfile. */
const carriesEmbeddedRepository = async (ctx: Context, dotGit: string): Promise<boolean> => {
  const stat = await ctx.fs.lstat(dotGit).catch(() => undefined);
  return stat?.isDirectory === true && !stat.isSymbolicLink;
};

/** git dies on an embedded repository it cannot name; checked before anything is removed. */
const enforceEmbeddedNamed = async (
  ctx: Context,
  workDir: string,
  gitlinks: ReadonlyArray<IndexEntry>,
  { rows }: Gitmodules,
): Promise<void> => {
  for (const { path } of gitlinks) {
    if (rows.some((row) => row.path === path)) continue;
    if (await carriesEmbeddedRepository(ctx, joinPath(workDir, `${path}/.git`))) {
      throw submoduleNameNotFound(path);
    }
  }
};

/**
 * A repository embedded in the submodule would die with its directory: git first moves it
 * into `<gitDir>/modules/<name>` and leaves the gitfile an absorbed submodule carries.
 */
const migrateGitDir = async (ctx: Context, path: FilePath, name: string): Promise<void> => {
  const workDir = requireWorkTree(ctx, 'rm');
  const dotGit = joinPath(workDir, `${path}/.git`);
  if (!(await carriesEmbeddedRepository(ctx, dotGit))) return;
  const moduleDir = `${ctx.layout.gitDir}/modules/${name}`;
  await ctx.fs.mkdir(dirname(moduleDir));
  await ctx.fs.rename(dotGit, moduleDir);
  const worktree = relativePathBetween(moduleDir, joinPath(workDir, path));
  await updateConfigOperations(deriveGitlinkContext(ctx, moduleDir, path), [
    { kind: 'set', section: 'core', key: 'worktree', value: worktree },
  ]);
  await ctx.fs.writeUtf8(dotGit, `${submoduleGitfile(name, path)}\n`);
};

/**
 * git refuses to touch a gitlink while the working `.gitmodules` differs by content from
 * its staged entry: the section edit would otherwise stage changes nobody reviewed.
 */
const enforceGitmodulesStaged = async (
  ctx: Context,
  entries: ReadonlyArray<IndexEntry>,
  indexMtime: GitIndex['indexMtime'],
  removed: ReadonlyArray<IndexEntry>,
): Promise<void> => {
  if (!removed.some((entry) => entry.mode === FILE_MODE.GITLINK)) return;
  const staged = entries.find((entry) => isStageZero(entry) && entry.path === GITMODULES_FILE);
  if (staged === undefined) return;
  const provider = await buildCheckinAttributeProvider(ctx);
  const delta = await compareWorkingTreeDelta(ctx, staged, provider, indexMtime);
  if (delta.status === 'modified') throw gitmodulesNotStaged();
};

/**
 * git drops the `.gitmodules` section of each removed submodule and stages the result;
 * a file without a matching section is left alone, and so is an absent one.
 */
const dropGitmodulesSections = async (
  ctx: Context,
  workDir: string,
  gitlinks: ReadonlyArray<IndexEntry>,
  { text, rows }: Gitmodules,
): Promise<IndexEntry | undefined> => {
  const sections = rows.filter((row) => gitlinks.some(({ path }) => row.path === path));
  if (sections.length === 0) return undefined;
  const file = joinPath(workDir, GITMODULES_FILE);
  const edited = sections.reduce(removeSection, text);
  await ctx.fs.writeUtf8(file, edited);
  const id = (await writeObject(ctx, {
    type: 'blob',
    id: '' as ObjectId,
    content: new TextEncoder().encode(edited),
  })) as ObjectId;
  return indexEntryFromStat(await ctx.fs.lstat(file), FILE_MODE.REGULAR, id, GITMODULES_FILE);
};

const removeSection = (text: string, row: GitmodulesRow): string =>
  removeConfigSectionInText(text, `submodule.${row.name}`);

/** Every stage of a path, in index order, so an unmerged path stays whole. */
const groupByPath = (
  entries: ReadonlyArray<IndexEntry>,
): Map<IndexPathKey, ReadonlyArray<IndexEntry>> => {
  const byPath = new Map<IndexPathKey, IndexEntry[]>();
  for (const entry of entries) {
    const key = indexPathKey(entry);
    const stages = byPath.get(key);
    if (stages === undefined) byPath.set(key, [entry]);
    else stages.push(entry);
  }
  return byPath;
};

const isStageZero = (entry: IndexEntry): boolean => entry.flags.stage === 0;

/** The unmerged paths the rm removed, so `git ls-files --resolve-undo` can bring them back. */
const resolvedRecordsOf = (
  removedGroups: ReadonlyArray<ReadonlyArray<IndexEntry>>,
): ReadonlyArray<ResolveUndoRecord> =>
  removedGroups.filter((stages) => !stages.every(isStageZero)).map(resolveUndoRecordOf);

/**
 * git rm's per-pathspec check, in argument order: each positive must match a
 * tracked path, and one that only reaches paths beneath a directory is a
 * directory removal git refuses without `-r`.
 */
const enforcePositiveLevels = (
  positives: ReadonlyArray<PositivePathspec>,
  highest: ReadonlyArray<MatchLevel>,
  recursive: boolean,
): void => {
  positives.forEach((positive, i) => {
    const level = highest[i] ?? MATCH_LEVEL.NONE;
    if (level === MATCH_LEVEL.NONE) throw pathspecNoMatch(positive.spelling);
    if (level === MATCH_LEVEL.RECURSIVE && !recursive) throw rmRecursiveWithoutR(positive.spelling);
  });
};

/**
 * `git rm`'s `check_local_mod` valve. Validates every matched entry up front and
 * removes nothing if any path is refused. A path whose working file is absent is
 * never refused (the deletion is the goal). For a present file:
 * `staged` = index `(id, mode)` differs from HEAD; `local` = working file differs
 * from the index entry. `--cached` (`cached`) suppresses the staged-only and
 * local-only categories but not the combined one — faithful to git.
 */
interface LocalModCategories {
  readonly both: ReadonlyArray<FilePath>;
  readonly stagedOnly: ReadonlyArray<FilePath>;
  readonly localOnly: ReadonlyArray<FilePath>;
}

/**
 * git's `check_local_mod`: a gitlink is also modified when its dirty check finds anything,
 * counting untracked files and ignoring the configured ignore mode.
 */
const isLocallyModified = async (
  ctx: Context,
  entry: IndexEntry,
  delta: WorkingTreeDelta,
): Promise<boolean> => {
  if (entry.mode !== FILE_MODE.GITLINK) return isWorkingTreeModified(delta.status);
  const state = await submoduleState(ctx, entry, delta, {
    ignore: 'none',
    childStatus: (child) => status(child),
  });
  return (
    isWorkingTreeModified(delta.status) ||
    state.commitChanged ||
    state.trackedChanges ||
    state.untrackedChanges
  );
};

/** Classify entries by modification category for the safety valve. */
const classifyEntries = async (
  ctx: Context,
  entries: ReadonlyArray<IndexEntry>,
  head: ReadonlyMap<FilePath, FlatTreeEntry>,
  cached: boolean,
  indexMtime: GitIndex['indexMtime'],
): Promise<LocalModCategories> => {
  const provider = await buildCheckinAttributeProvider(ctx);
  const both: FilePath[] = [];
  const stagedOnly: FilePath[] = [];
  const localOnly: FilePath[] = [];
  for (const entry of entries) {
    const delta = await compareWorkingTreeDelta(ctx, entry, provider, indexMtime);
    if (delta.status === 'absent') continue;
    const local = await isLocallyModified(ctx, entry, delta);
    const staged = isStaged(head, entry);
    if (staged && local) both.push(entry.path);
    else if (staged && !cached) stagedOnly.push(entry.path);
    else if (local && !cached) localOnly.push(entry.path);
  }
  return { both, stagedOnly, localOnly };
};

const enforceSafetyValve = async (
  ctx: Context,
  entries: ReadonlyArray<IndexEntry>,
  cached: boolean,
  indexMtime: GitIndex['indexMtime'],
): Promise<void> => {
  const head = await headTreeEntries(ctx);
  const { both, stagedOnly, localOnly } = await classifyEntries(
    ctx,
    entries,
    head,
    cached,
    indexMtime,
  );
  // Precedence: surface the strongest required override first (`both` needs `-f`).
  if (both.length > 0) throw rmStagedAndLocalChanges(both);
  if (stagedOnly.length > 0) throw rmStagedChanges(stagedOnly);
  if (localOnly.length > 0) throw rmLocalModifications(localOnly);
};

const isStaged = (head: ReadonlyMap<FilePath, FlatTreeEntry>, entry: IndexEntry): boolean => {
  const headEntry = head.get(escapedPathOf(entry));
  // Absent from HEAD (newly added / never committed) counts as staged, as does a
  // blob-id or mode difference.
  return headEntry === undefined || headEntry.id !== entry.id || headEntry.mode !== entry.mode;
};

// An unborn HEAD (no commits yet) has no tree — every entry is then staged.
const headTreeEntries = async (ctx: Context): Promise<ReadonlyMap<FilePath, FlatTreeEntry>> =>
  (await readHeadTreeEscaped(ctx))?.entries ?? new Map();
