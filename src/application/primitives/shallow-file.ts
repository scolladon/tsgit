/**
 * `.git/shallow` reader and writer.
 *
 * When the server emits `shallow <oid>` / `unshallow <oid>` pkt-lines in
 * response to a `deepen <N>` request, the client persists the resulting
 * cut-point set under `.git/shallow`. A subsequent `walkCommits` with
 * `shallow: <readShallow result>` terminates parent traversal at every
 * boundary.
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
import { TsgitError } from '../../domain/error.js';
import type { ObjectId } from '../../domain/objects/object-id.js';
import type { Context } from '../../ports/context.js';
import { parseShallowFile } from './internal/parse-shallow.js';
import { invalidateShallowSet } from './internal/shallow-set.js';
import { commonGitDir, shallowFilePath, shallowLockPath } from './path-layout.js';

const isFileNotFound = (error: unknown): boolean =>
  error instanceof TsgitError && error.data.code === 'FILE_NOT_FOUND';

/**
 * Read `.git/shallow`. Returns an empty set when the file does not exist.
 * Parses each line with git's strict grammar (`internal/parse-shallow.ts`):
 * malformed content — a blank line, a short/non-hex 40-char prefix, or more
 * than `MAX_SHALLOW_ENTRIES` lines — throws `SHALLOW_FILE_MALFORMED` rather
 * than being silently skipped. A shallow set is trusted repository state;
 * reachability answers produced by a walk are relative to it.
 */
export const readShallow = async (ctx: Context): Promise<ReadonlySet<ObjectId>> => {
  let raw: string;
  try {
    raw = await ctx.fs.readUtf8(shallowFilePath(commonGitDir(ctx)));
  } catch (err) {
    if (isFileNotFound(err)) return new Set();
    throw err;
  }
  return new Set(parseShallowFile(raw));
};

interface ShallowUpdate {
  readonly shallow: ReadonlyArray<ObjectId>;
  readonly unshallow: ReadonlyArray<ObjectId>;
}

/**
 * Apply a set of shallow / unshallow updates to `.git/shallow`. Writes
 * atomically via lock-rename; deletes the file when the resulting set is
 * empty.
 */
export const updateShallow = async (ctx: Context, updates: ShallowUpdate): Promise<void> => {
  const current = new Set(await readShallow(ctx));
  for (const id of updates.shallow) current.add(id);
  for (const id of updates.unshallow) current.delete(id);

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
