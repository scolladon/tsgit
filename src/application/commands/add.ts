/**
 * `add` porcelain — stage working-tree paths into the index, faithful to
 * `git add`. The resulting index + tree read back (via `git ls-files --stage`
 * / `git write-tree`) match canonical git; raw index bytes differ only by
 * per-host stat-cache fields.
 *
 * @writes
 *   surface: add
 *   kind:    equivalent-under-readback
 *   format:  git-index-tree-state
 */
import { invalidOption, workingTreeFileTooLarge } from '../../domain/commands/error.js';
import { operationAborted, TsgitError } from '../../domain/error.js';
import { type IndexEntry, STAGE0_FLAGS } from '../../domain/git-index/index.js';
import { emptyPathspec, pathspecNoMatch } from '../../domain/index.js';
import { deriveWorkingMode, type FileMode, type ObjectId } from '../../domain/objects/index.js';
import type { FilePath } from '../../domain/objects/object-id.js';
import { matchesPathspec, type Pathspec } from '../../domain/pathspec/index.js';
import type { Context } from '../../ports/context.js';
import { readIndex } from '../primitives/read-index.js';
import { MAX_WORKING_TREE_BLOB_BYTES, type WalkWorkingTreeEntry } from '../primitives/types.js';
import { walkWorkingTree } from '../primitives/walk-working-tree.js';
import { writeObject } from '../primitives/write-object.js';
import type { IgnorePredicate } from './internal/add-ignore.js';
import { buildRepoIgnorePredicate } from './internal/build-ignore-evaluator.js';
import { acquireIndexLock } from './internal/index-update.js';
import {
  assertNoPendingOperation,
  assertNotBare,
  assertRepository,
} from './internal/repo-state.js';
import { enforceLiteralMustMatch, resolvePathspec } from './internal/resolve-pathspec.js';
import { readFile } from './internal/working-tree.js';

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
 *  validated, read, hashed, and staged. Missing paths reject the whole call.
 * - **Bulk mode** (`paths` empty, `all === true`): walk the working tree,
 *  stage every modified/new tracked file plus every untracked, non-ignored
 *  file. Files missing from disk but present in the prior index land in
 *  `removed`. `.git` and embedded repositories are skipped.
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
  // path forward — same for staging a cherry-pick resolution. Rebase / revert
  // still block until their commands land.
  await assertNoPendingOperation(ctx, { except: ['merge', 'cherry-pick'] });
  if (opts.all === true) {
    if (paths.length !== 0) {
      throw invalidOption('all', 'pathspec must be empty when all=true');
    }
    return addAll(ctx, opts);
  }
  if (paths.length === 0) throw emptyPathspec();
  return dispatchPathspec(ctx, paths, opts);
};

// Branch on the resolved pathspec: pure literals that each name an
// existing file route through the byte-identical per-path stage flow
// from; anything else (globs, literal directories, negations)
// walks the working tree and filters with the matcher.
const dispatchPathspec = async (
  ctx: Context,
  paths: ReadonlyArray<string>,
  opts: AddOptions,
): Promise<AddResult> => {
  const { matcher, literalMustMatch, hasGlob } = resolvePathspec(paths);
  if (!hasGlob && (await allLiteralsAreFiles(ctx, literalMustMatch))) {
    return addLiteralOnly(ctx, literalMustMatch, opts);
  }
  return addByPathspec(ctx, matcher, literalMustMatch, opts);
};

const addLiteralOnly = async (
  ctx: Context,
  validated: ReadonlyArray<FilePath>,
  opts: AddOptions,
): Promise<AddResult> => {
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

const allLiteralsAreFiles = async (
  ctx: Context,
  literals: ReadonlyArray<FilePath>,
): Promise<boolean> => {
  if (literals.length === 0) return false;
  for (const path of literals) {
    const stat = await ctx.fs.lstat(`${ctx.layout.workDir}/${path}`).catch(() => undefined);
    if (stat === undefined) return false;
    if (stat.isDirectory && !stat.isSymbolicLink) return false;
  }
  return true;
};

// Walk-and-filter add: applies `.gitignore` (so build artefacts stay
// out) and the user's pathspec on top. Directories are NOT pruned by
// the pathspec (a pattern like `*.ts` matches leaves, not dirs); only
// leaves are filtered by it. `.gitignore` directory pruning still
// applies via `buildRepoIgnorePredicate`.
const addByPathspec = async (
  ctx: Context,
  matcher: Pathspec,
  literalMustMatch: ReadonlyArray<FilePath>,
  opts: AddOptions,
): Promise<AddResult> => {
  const ignore = await buildRepoIgnorePredicate(ctx);
  const combinedIgnore: IgnorePredicate = async (path, isDirectory) => {
    if (await ignore(path, isDirectory)) return true;
    if (isDirectory) return false;
    return !matchesPathspec(matcher, path);
  };
  const lock = await acquireIndexLock(
    ctx,
    opts.breakStaleLockMs !== undefined ? { breakStaleLockMs: opts.breakStaleLockMs } : {},
  );
  try {
    const existing = await readExistingEntries(ctx);
    const newEntries = new Map<FilePath, IndexEntry>(existing);
    const matched: FilePath[] = [];
    const added: FilePath[] = [];
    const modified: FilePath[] = [];
    const seen = new Set<FilePath>();
    for await (const walkEntry of walkWorkingTree(ctx, { ignore: combinedIgnore })) {
      const result = await processWalkEntry(ctx, walkEntry, existing, seen);
      if (result === undefined) continue;
      matched.push(result.path);
      newEntries.set(result.path, result.entry);
      if (result.kind === 'added') added.push(result.path);
      else if (result.kind === 'modified') modified.push(result.path);
    }
    enforceLiteralMustMatch(literalMustMatch, matched);
    added.sort();
    modified.sort();
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
  ignoreOverride?: IgnorePredicate,
): Promise<AddResult> => {
  const ignore = ignoreOverride ?? (await buildRepoIgnorePredicate(ctx));
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

    // Walk-time pruning: the walker calls `ignore` on every directory
    // (skipping ignored subtrees) and every leaf. By the time we see a
    // leaf here, the ignore filter has already passed.
    for await (const walkEntry of walkWorkingTree(ctx, { ignore })) {
      const result = await processWalkEntry(ctx, walkEntry, existing, seen);
      if (result === undefined) continue;
      newEntries.set(result.path, result.entry);
      if (result.kind === 'added') added.push(result.path);
      else if (result.kind === 'modified') modified.push(result.path);
    }
    const removed = await collectRemovedPaths(existing, seen, ignore);
    for (const path of removed) newEntries.delete(path);
    added.sort();
    modified.sort();
    // Stryker disable next-line MethodExpression: equivalent — `removed` is built by iterating `existing`, a Map populated from the always-byte-sorted index (serializeIndex sorts on every write), so it is already in ascending path order; the sort is a defensive no-op.
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

/**
 * The post-walk removal pass: every prior index entry the walk did not see on
 * disk is a candidate removal. Two entries are preserved (NOT removed):
 *
 * - **skip-worktree** — a sparse-excluded entry is legitimately absent;
 *   staging its removal would silently un-sparse it into a deletion.
 * - **tracked-but-ignored** — a tracked file under a pruned subtree
 *   (directory-level ignore) the walker skipped. Git's invariant: ignore
 *   rules don't auto-untrack.
 */
const collectRemovedPaths = async (
  existing: ReadonlyMap<FilePath, IndexEntry>,
  seen: ReadonlySet<FilePath>,
  ignore: IgnorePredicate,
): Promise<FilePath[]> => {
  const removed: FilePath[] = [];
  for (const [path, entry] of existing) {
    if (seen.has(path)) continue;
    if (entry.flags.skipWorktree) continue;
    if (await isPathOrAncestorIgnored(path, ignore)) continue;
    removed.push(path);
  }
  return removed;
};

/**
 * True if `path` or any ancestor directory is reported ignored by the
 * predicate. Git's directory-level ignore rules (`build/`) match the
 * directory entry, NOT the files under it; the walker handles this by
 * pruning at descent, but the post-walk re-check must mirror it.
 */
const isPathOrAncestorIgnored = async (
  path: FilePath,
  ignore: IgnorePredicate,
): Promise<boolean> => {
  if (await ignore(path, false)) return true;
  const segments = path.split('/');
  for (let i = 1; i < segments.length; i += 1) {
    const ancestor = segments.slice(0, i).join('/') as FilePath;
    if (await ignore(ancestor, true)) return true;
  }
  return false;
};

const processWalkEntry = async (
  ctx: Context,
  walkEntry: WalkWorkingTreeEntry,
  existing: ReadonlyMap<FilePath, IndexEntry>,
  seen: Set<FilePath>,
): Promise<WalkOutcome | undefined> => {
  const { path, stat } = walkEntry;
  // Mark presence BEFORE any further filter so the post-walk
  // "missing from disk → removed" pass is exact. Ignore filtering
  // already happened at walk-time in; this function only sees
  // leaves the walker chose to yield.
  seen.add(path);
  // Pre-filter using the walk-time stat as an early reject; the authoritative
  // size check fires inside stageFromStat against the re-lstat'd value so a
  // grow-between-walk-and-stage race can't bypass the cap.
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
  // Re-lstat under the index lock to close the walk→stage TOCTOU window:
  // an attacker swapping the inode (regular ↔ symlink, file ↔ directory)
  // between the walk's lstat and our read would otherwise re-route the
  // read through `ctx.fs.read` (which follows symlinks), break the mode
  // classification, or trip an opaque adapter error. Abort the whole add
  // on any type flip.
  const fresh = await ctx.fs.lstat(`${ctx.layout.workDir}/${path}`);
  if (
    fresh.isSymbolicLink !== stat.isSymbolicLink ||
    fresh.isDirectory !== stat.isDirectory ||
    fresh.isFile !== stat.isFile
  ) {
    throw operationAborted();
  }
  // Authoritative size cap — uses the fresh stat so a grow-between-walk-and-
  // stage race cannot smuggle an oversize blob past the pre-filter.
  if (fresh.size > MAX_WORKING_TREE_BLOB_BYTES) {
    throw workingTreeFileTooLarge(path, fresh.size, MAX_WORKING_TREE_BLOB_BYTES);
  }
  const mode: FileMode = deriveWorkingMode(fresh);
  const bytes = await readContent(ctx, path, fresh);
  const id = (await writeObject(ctx, {
    type: 'blob',
    id: '' as ObjectId,
    content: bytes,
  })) as ObjectId;
  return makeEntry(fresh, mode, id, path);
};

const readContent = async (
  ctx: Context,
  path: FilePath,
  stat: Awaited<ReturnType<Context['fs']['lstat']>>,
): Promise<Uint8Array> => {
  if (stat.isSymbolicLink) {
    const bytes = new TextEncoder().encode(await ctx.fs.readlink(`${ctx.layout.workDir}/${path}`));
    // Defence against an FS adapter that mis-reports symlink target length:
    // lstat reports the target byte length as `stat.size`, but a hostile
    // adapter could return an arbitrarily long string from readlink.
    if (bytes.byteLength > MAX_WORKING_TREE_BLOB_BYTES) {
      throw workingTreeFileTooLarge(path, bytes.byteLength, MAX_WORKING_TREE_BLOB_BYTES);
    }
    return bytes;
  }
  return readFile(ctx, path);
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
  flags: STAGE0_FLAGS,
  path,
});
