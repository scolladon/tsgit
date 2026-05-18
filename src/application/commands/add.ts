import { invalidOption, workingTreeFileTooLarge } from '../../domain/commands/error.js';
import { TsgitError } from '../../domain/error.js';
import type { IndexEntry } from '../../domain/git-index/index.js';
import { emptyPathspec, pathspecNoMatch } from '../../domain/index.js';
import type { FileMode, ObjectId } from '../../domain/objects/index.js';
import type { FilePath } from '../../domain/objects/object-id.js';
import type { Context } from '../../ports/context.js';
import { readIndex } from '../primitives/read-index.js';
import { MAX_WORKING_TREE_BLOB_BYTES, type WalkWorkingTreeEntry } from '../primitives/types.js';
import { walkWorkingTree } from '../primitives/walk-working-tree.js';
import { writeObject } from '../primitives/write-object.js';
import { defaultIgnorePredicate, type IgnorePredicate } from './internal/add-ignore.js';
import { acquireIndexLock } from './internal/index-update.js';
import {
  assertNoPendingOperation,
  assertNotBare,
  assertRepository,
} from './internal/repo-state.js';
import { readFile, validatePath } from './internal/working-tree.js';

const INDEX_MISSING_CODES = new Set([
  'FILE_NOT_FOUND',
  'INVALID_INDEX_HEADER',
  'INVALID_INDEX_ENTRY',
]);

export interface AddOptions {
  readonly force?: boolean;
  readonly all?: boolean;
  readonly breakStaleLockMs?: number;
}

export interface AddResult {
  readonly added: ReadonlyArray<FilePath>;
  readonly modified: ReadonlyArray<FilePath>;
  readonly removed: ReadonlyArray<FilePath>;
}

/**
 * Stage paths in the index. Two modes:
 *
 * - **Literal-path mode** (`paths` non-empty, `all` falsy): every path is
 *   validated, read, hashed, and staged. Missing paths reject the whole call.
 * - **Bulk mode** (`paths` empty, `all === true`): walk the working tree,
 *   stage every modified/new tracked file plus every untracked, non-ignored
 *   file. Files missing from disk but present in the prior index land in
 *   `removed`. `.git` and embedded repositories are skipped.
 *
 * Both modes acquire `.git/index.lock` once, read the existing index under
 * the lock, and commit a single replacement — no partial writes.
 */
export const add = async (
  ctx: Context,
  paths: ReadonlyArray<string>,
  opts: AddOptions = {},
): Promise<AddResult> => {
  await assertRepository(ctx);
  await assertNotBare(ctx, 'add');
  // Allow `add` during a conflicted merge — staging resolved files IS the
  // path forward. Other pending operations (rebase / cherry-pick / revert)
  // still block.
  await assertNoPendingOperation(ctx, { except: 'merge' });
  if (opts.all === true) {
    if (paths.length !== 0) {
      throw invalidOption('all', 'pathspec must be empty when all=true');
    }
    return addAll(ctx, opts);
  }
  if (paths.length === 0) throw emptyPathspec();
  return addLiteral(ctx, paths, opts);
};

const addLiteral = async (
  ctx: Context,
  paths: ReadonlyArray<string>,
  opts: AddOptions,
): Promise<AddResult> => {
  const validated = paths.map(validatePath);
  const lock = await acquireIndexLock(
    ctx,
    opts.breakStaleLockMs !== undefined ? { breakStaleLockMs: opts.breakStaleLockMs } : {},
  );
  try {
    const existing = await readExistingEntries(ctx);
    const newEntries = new Map<FilePath, IndexEntry>(existing);
    const added: FilePath[] = [];
    const modified: FilePath[] = [];
    for (const path of validated) {
      const result = await stageOne(ctx, path);
      if (result === 'missing') throw pathspecNoMatch(path);
      const previous = existing.get(path);
      newEntries.set(path, result);
      if (previous === undefined) added.push(path);
      else if (previous.id !== result.id || previous.mode !== result.mode) modified.push(path);
    }
    await lock.commit(Array.from(newEntries.values()));
    return { added, modified, removed: [] };
  } finally {
    await lock.release();
  }
};

/**
 * Bulk-mode `add --all`. Exposed for testability (custom `ignore` predicate).
 * Production callers go through `add({ all: true })`.
 */
export const addAll = async (
  ctx: Context,
  opts: AddOptions,
  ignore: IgnorePredicate = defaultIgnorePredicate,
): Promise<AddResult> => {
  const lock = await acquireIndexLock(
    ctx,
    opts.breakStaleLockMs !== undefined ? { breakStaleLockMs: opts.breakStaleLockMs } : {},
  );
  try {
    const existing = await readExistingEntries(ctx);
    const newEntries = new Map<FilePath, IndexEntry>(existing);
    const seen = new Set<FilePath>();
    const added: FilePath[] = [];
    const modified: FilePath[] = [];
    const removed: FilePath[] = [];

    for await (const entry of walkWorkingTree(ctx)) {
      const result = await processWalkEntry(ctx, entry, existing, ignore, seen);
      if (result === undefined) continue;
      newEntries.set(result.path, result.entry);
      if (result.kind === 'added') added.push(result.path);
      else if (result.kind === 'modified') modified.push(result.path);
    }
    for (const [path] of existing) {
      if (!seen.has(path)) {
        newEntries.delete(path);
        removed.push(path);
      }
    }
    added.sort();
    modified.sort();
    removed.sort();
    await lock.commit(Array.from(newEntries.values()));
    return { added, modified, removed };
  } finally {
    await lock.release();
  }
};

interface WalkOutcome {
  readonly kind: 'added' | 'modified' | 'unchanged';
  readonly path: FilePath;
  readonly entry: IndexEntry;
}

const processWalkEntry = async (
  ctx: Context,
  walkEntry: WalkWorkingTreeEntry,
  existing: ReadonlyMap<FilePath, IndexEntry>,
  ignore: IgnorePredicate,
  seen: Set<FilePath>,
): Promise<WalkOutcome | undefined> => {
  const { path, stat } = walkEntry;
  // Mark presence BEFORE the ignore filter so §14.3's tracked-but-ignored
  // files are not dropped via the not-seen → removed path.
  seen.add(path);
  if (ignore(path, stat.isDirectory)) return undefined;
  if (stat.size > MAX_WORKING_TREE_BLOB_BYTES) {
    throw workingTreeFileTooLarge(path, stat.size, MAX_WORKING_TREE_BLOB_BYTES);
  }
  const entry = await stageFromStat(ctx, path, stat);
  const previous = existing.get(path);
  if (previous === undefined) return { kind: 'added', path, entry };
  if (previous.id !== entry.id || previous.mode !== entry.mode) {
    return { kind: 'modified', path, entry };
  }
  return { kind: 'unchanged', path, entry };
};

const readExistingEntries = async (ctx: Context): Promise<ReadonlyMap<FilePath, IndexEntry>> => {
  try {
    const index = await readIndex(ctx);
    const out = new Map<FilePath, IndexEntry>();
    for (const entry of index.entries) out.set(entry.path, entry);
    return out;
  } catch (err) {
    // Missing-or-corrupt index = "no entries"; everything else propagates so
    // I/O failures and permission errors are not silently absorbed.
    if (err instanceof TsgitError && INDEX_MISSING_CODES.has(err.data.code)) {
      return new Map();
    }
    throw err;
  }
};

const stageOne = async (ctx: Context, path: FilePath): Promise<IndexEntry | 'missing'> => {
  const stat = await ctx.fs.lstat(`${ctx.layout.workDir}/${path}`).catch(() => undefined);
  if (stat === undefined) return 'missing';
  return stageFromStat(ctx, path, stat);
};

const stageFromStat = async (
  ctx: Context,
  path: FilePath,
  stat: Awaited<ReturnType<Context['fs']['lstat']>>,
): Promise<IndexEntry> => {
  const mode: FileMode = stat.isSymbolicLink
    ? '120000'
    : (stat.mode & 0o111) !== 0
      ? '100755'
      : '100644';
  const bytes = stat.isSymbolicLink
    ? new TextEncoder().encode(await ctx.fs.readlink(`${ctx.layout.workDir}/${path}`))
    : await readFile(ctx, path);
  const id = (await writeObject(ctx, {
    type: 'blob',
    id: '' as ObjectId,
    content: bytes,
  })) as ObjectId;
  return makeEntry(stat, mode, id, path);
};

const makeEntry = (
  stat: Awaited<ReturnType<Context['fs']['lstat']>>,
  mode: FileMode,
  id: ObjectId,
  path: FilePath,
): IndexEntry => ({
  ctimeSeconds: Math.floor(stat.ctimeMs / 1000),
  ctimeNanoseconds: 0,
  mtimeSeconds: Math.floor(stat.mtimeMs / 1000),
  mtimeNanoseconds: 0,
  dev: stat.dev,
  ino: stat.ino,
  mode,
  uid: stat.uid,
  gid: stat.gid,
  fileSize: stat.size,
  id,
  flags: { assumeValid: false, extended: false, stage: 0 },
  path,
});
