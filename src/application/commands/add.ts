import { TsgitError } from '../../domain/error.js';
import type { IndexEntry } from '../../domain/git-index/index.js';
import { emptyPathspec, pathspecNoMatch } from '../../domain/index.js';
import type { FileMode, ObjectId } from '../../domain/objects/index.js';
import type { FilePath } from '../../domain/objects/object-id.js';
import type { Context } from '../../ports/context.js';
import { readIndex } from '../primitives/read-index.js';
import { writeObject } from '../primitives/write-object.js';
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
 * Add the given pathspecs to the index. Performs:
 * 1. Repo + bare + pending-op preflight checks.
 * 2. Path validation for every input (no I/O on rejection).
 * 3. Read working-tree contents → write blob → produce IndexEntry.
 * 4. Atomically replace `.git/index` under the index lock.
 *
 * Bulk mode (`all: true`) is not yet implemented — this is the literal-paths
 * happy path used by `init`/`commit` integration tests.
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
  if (paths.length === 0) throw emptyPathspec();
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
