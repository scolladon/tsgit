/**
 * `.git/shallow` reader and writer.
 *
 * When the server emits `shallow <oid>` / `unshallow <oid>` pkt-lines in
 * response to a `deepen <N>` request, the client persists the resulting
 * cut-point set under `.git/shallow`. Commit traversals load this set
 * automatically (per-`Context`, via `internal/shallow-set.ts`) and mask a
 * boundary commit's parents; `readShallow` is the raw-file accessor for
 * callers that need the set itself.
 *
 * @writes
 *   surface: shallowFile
 *   kind:    byte-identical
 *   format:  git-shallow-file
 *
 * Format: one oid per line, LF-terminated, sorted lexicographically so a
 * re-read produces a deterministic file. Matches canonical git's
 * `.git/shallow` exactly. Empty resulting set ≡ delete the file.
 *
 * Atomicity: write to `${gitDir}/shallow.lock` via `fs.writeExclusive`
 * (rejects if a lock is held), then `fs.rename` onto `${gitDir}/shallow`.
 * Mirrors `atomicWriteRef`'s lock-rename pattern without taking a
 * RefName (the shallow file is not a ref).
 */
import { shallowFileMalformed, TsgitError } from '../../domain/error.js';
import type { ObjectId } from '../../domain/objects/object-id.js';
import type { Context } from '../../ports/context.js';
import { MAX_SHALLOW_ENTRIES, parseShallowFile } from './internal/parse-shallow.js';
import { invalidateShallowSet, isAbsentShallowFile } from './internal/shallow-set.js';
import { commonGitDir, shallowFilePath, shallowLockPath } from './path-layout.js';
import { REASON_SHALLOW_OID_WIDTH, REASON_SHALLOW_TOO_MANY_ENTRIES } from './validators.js';

const isFileNotFound = (error: unknown): boolean =>
  error instanceof TsgitError && error.data.code === 'FILE_NOT_FOUND';

/**
 * Read `.git/shallow`. Returns an empty set when the file is absent (same
 * absence predicate as the per-`Context` memo, so the two readers of this
 * file can never disagree). Parses each line with git's strict grammar
 * (`internal/parse-shallow.ts`) at the repository's oid hex length:
 * malformed content — a blank line, a short/non-hex oid prefix, or more
 * than `MAX_SHALLOW_ENTRIES` lines — throws `SHALLOW_FILE_MALFORMED` rather
 * than being silently skipped. A shallow set is trusted repository state;
 * reachability answers produced by a walk are relative to it.
 */
export const readShallow = async (ctx: Context): Promise<ReadonlySet<ObjectId>> => {
  let raw: string;
  try {
    raw = await ctx.fs.readUtf8(shallowFilePath(commonGitDir(ctx)));
  } catch (err) {
    if (isAbsentShallowFile(err)) return new Set();
    throw err;
  }
  return new Set(parseShallowFile(raw, ctx.hashConfig.hexLength));
};

interface ShallowUpdate {
  readonly shallow: ReadonlyArray<ObjectId>;
  readonly unshallow: ReadonlyArray<ObjectId>;
}

/**
 * Apply a set of shallow / unshallow updates to `.git/shallow`. Writes
 * atomically via lock-rename; deletes the file when the resulting set is
 * empty. Refuses (`SHALLOW_FILE_MALFORMED`) when the resulting set would
 * exceed `MAX_SHALLOW_ENTRIES`, or when an added oid's width does not match
 * the repository hash (the wire parser accepts either width, and persisting
 * a foreign-width oid would truncate on the next read into a never-matching
 * boundary): the write side enforces what the reader enforces, so a hostile
 * server cannot persist a file every later read would refuse or misread —
 * the refusal fires here, before repository state changes.
 */
export const updateShallow = async (ctx: Context, updates: ShallowUpdate): Promise<void> => {
  const current = new Set(await readShallow(ctx));
  let entry = 0;
  for (const id of updates.shallow) {
    entry += 1;
    if (id.length !== ctx.hashConfig.hexLength) {
      throw shallowFileMalformed(REASON_SHALLOW_OID_WIDTH, entry);
    }
  }
  for (const id of updates.shallow) current.add(id);
  for (const id of updates.unshallow) current.delete(id);
  if (current.size > MAX_SHALLOW_ENTRIES) {
    throw shallowFileMalformed(REASON_SHALLOW_TOO_MANY_ENTRIES, current.size);
  }

  const path = shallowFilePath(commonGitDir(ctx));
  if (current.size === 0) {
    await deleteIfPresent(ctx, path);
    invalidateShallowSet(ctx);
    return;
  }

  const sorted = [...current].sort();
  const content = new TextEncoder().encode(sorted.map((id) => `${id}\n`).join(''));
  await atomicWrite(ctx, path, content);
  invalidateShallowSet(ctx);
};

const atomicWrite = async (ctx: Context, path: string, content: Uint8Array): Promise<void> => {
  const lockPath = shallowLockPath(commonGitDir(ctx));
  // writeExclusive rejects with FILE_EXISTS if the lock is already held —
  // a concurrent fetch trying to update shallow surfaces as a real error.
  await ctx.fs.writeExclusive(lockPath, content);
  try {
    await ctx.fs.rename(lockPath, path);
  } catch (err) {
    // Best-effort lock cleanup. FILE_NOT_FOUND on rm is swallowed (the
    // rename may have partially succeeded on some filesystems); otherwise
    // propagate so a stuck lock surfaces instead of silently persisting.
    try {
      await ctx.fs.rm(lockPath);
    } catch (rmErr) {
      if (!isFileNotFound(rmErr)) throw rmErr;
    }
    throw err;
  }
};

const deleteIfPresent = async (ctx: Context, path: string): Promise<void> => {
  try {
    await ctx.fs.rm(path);
  } catch (err) {
    if (isFileNotFound(err)) return;
    throw err;
  }
};
