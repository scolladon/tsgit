import { checkoutOverwriteDirty } from '../../../domain/commands/error.js';
import { dirname, pathTooLong, TsgitError } from '../../../domain/error.js';
import { errorDataCode } from '../../../domain/error-data-code.js';
import { unsupportedOperation } from '../../../domain/index.js';
import type { FileMode } from '../../../domain/objects/file-mode.js';
import type { FilePath } from '../../../domain/objects/object-id.js';
import {
  validateWorkingTreePath,
  validateWorkingTreePathOn,
} from '../../../domain/working-tree-path.js';
import type { Context } from '../../../ports/context.js';
import { removeEmptyDirectoryTree } from '../../primitives/internal/empty-directories.js';
import { isPathTooLong, lstatIfPresent } from '../../primitives/internal/fs-probes.js';
import { joinPath } from '../../primitives/internal/join-working-tree-path.js';
import { requireWorkTree } from '../../primitives/internal/repo-state.js';

/**
 * Validate a working-tree path. Throws `PATHSPEC_OUTSIDE_REPO` for any policy
 * violation. Returns the input as a `FilePath` brand on success.
 *
 * Delegated to `src/domain/working-tree-path.ts` so primitives can share the
 * exact same policy without depending on `application/commands/` (see
 * `.dependency-cruiser.cjs` rule `primitives-cannot-import-commands`).
 */
export const validatePath = validateWorkingTreePath;

/**
 * Every caller (`checkout`, `mv`, `rm`) has already proved a work tree exists
 * via its own top-level gate; this re-check is what lets the compiler — not a
 * reviewer — confirm `ctx.layout.workDir` is safe to dereference here.
 */
const repoPath = (ctx: Context, path: FilePath): string =>
  joinPath(requireWorkTree(ctx, 'workingTree'), path);

/**
 * Materialize a blob into the working tree at `path` with the given mode.
 *
 * - `100644` (regular): write file.
 * - `100755` (executable): write file then `chmod 0o755` where supported.
 * - `120000` (symlink): on platforms without symlink support (memory/OPFS),
 *   writes the link target as the file's bytes — byte-exact, no newline added.
 * - `160000` (gitlink/submodule): throws `UNSUPPORTED_OPERATION` (v1).
 */
export const materializeFile = async (
  ctx: Context,
  rawPath: string,
  blob: Uint8Array,
  mode: FileMode,
): Promise<void> => {
  const path = validatePath(rawPath);
  if (mode === '160000') {
    throw unsupportedOperation('materializeFile', 'gitlink (submodule) not supported in v1');
  }
  if (mode === '40000') {
    // Tree mode is not a leaf; callers should never reach here.
    throw unsupportedOperation('materializeFile', 'directory mode is not a leaf');
  }
  const dst = repoPath(ctx, path);
  // Symlink-safe write: ensure the file exists, then open with O_NOFOLLOW so
  // a TOCTOU symlink swap of the leaf is detected and rejected. On adapters
  // without O_NOFOLLOW (browser OPFS) the openWithNoFollow throws
  // UNSUPPORTED_OPERATION; we fall back to plain write since OPFS has no
  // symlinks to begin with.
  await ctx.fs.write(dst, new Uint8Array());
  let handle: Awaited<ReturnType<Context['fs']['openWithNoFollow']>> | undefined;
  try {
    handle = await ctx.fs.openWithNoFollow(dst, 'write');
    await handle.write(blob);
  } catch (err) {
    if (err instanceof TsgitError && err.data.code === 'UNSUPPORTED_OPERATION') {
      await ctx.fs.write(dst, blob);
    } else {
      throw err;
    }
  } finally {
    await handle?.close();
  }
  if (mode === '100755') {
    await ctx.fs.chmod(dst, 0o755);
  } else if (mode === '100644') {
    await ctx.fs.chmod(dst, 0o644);
  }
};

/**
 * Remove the working-tree file at `path`. Refuses to remove a directory
 * (a divergence from what we expected to be there) with `CHECKOUT_OVERWRITE_DIRTY`
 * rather than blindly mutating. A missing path surfaces as `FILE_NOT_FOUND` so the
 * caller can tolerate it, as git does for a file the user already deleted.
 */
export const removeFile = async (ctx: Context, rawPath: string): Promise<void> => {
  const path = validateWorkingTreePathOn(rawPath, ctx);
  const full = repoPath(ctx, path);
  let stat: Awaited<ReturnType<Context['fs']['lstat']>>;
  try {
    stat = await ctx.fs.lstat(full);
  } catch (err) {
    if (errorDataCode(err) === 'FILE_NOT_FOUND') throw err;
    throw checkoutOverwriteDirty({ localChanges: [path], untracked: [] });
  }
  if (!stat.isFile && !stat.isSymbolicLink) {
    throw checkoutOverwriteDirty({ localChanges: [path], untracked: [] });
  }
  await ctx.fs.rm(full);
};

/**
 * Remove the working-tree directory at `path` with everything beneath it. Refuses
 * anything that is not a directory (missing included) like `removeFile` does.
 */
export const removeDirectory = async (ctx: Context, rawPath: string): Promise<void> => {
  const path = validateWorkingTreePathOn(rawPath, ctx);
  const full = repoPath(ctx, path);
  const stat = await lstatIfPresent(ctx.fs, full);
  if (stat === undefined || !stat.isDirectory) {
    throw checkoutOverwriteDirty({ localChanges: [path], untracked: [] });
  }
  await ctx.fs.rmRecursive(full);
};

/**
 * Delete the working-tree path with everything beneath it, untracked content
 * included — the caller has judged the tree abandoned. A missing path is not an
 * error, so no existence check races the removal.
 */
export const discardDirectory = async (ctx: Context, rawPath: string): Promise<void> => {
  await ctx.fs.rmRecursive(repoPath(ctx, validateWorkingTreePathOn(rawPath, ctx)));
};

/**
 * Move a working-tree path. Validates both ends (rejecting `..`, `.git`,
 * absolute paths, etc.) then relocates the node — carrying any untracked
 * contents along, faithful to `git mv`.
 *
 * A directory is renamed in one step where the port can (`renameDirectory`).
 * Otherwise the whole subtree is read first, every directory is recreated, each
 * leaf is moved, and only the empty source directories are removed. A fault
 * after the first move leaves a partial move, like the browser's own `rename`.
 * The destination parent is created first (a rename does not create parents).
 */
export const renameInWorkingTree = async (
  ctx: Context,
  rawFrom: string,
  rawTo: string,
): Promise<void> => {
  const from = moveEnd(ctx, validatePath(rawFrom));
  const to = moveEnd(ctx, validatePath(rawTo));
  const stat = await ctx.fs.lstat(from.abs);
  if (!isPlainDirectory(stat)) return renameNamingDestination(ctx, ctx.fs.rename, from, to);
  const renameDirectory = ctx.fs.renameDirectory;
  if (renameDirectory !== undefined) return renameNamingDestination(ctx, renameDirectory, from, to);
  return moveTreeEntryByEntry(ctx, from, to);
};

const moveEnd = (ctx: Context, rel: FilePath): MoveEnd => ({ abs: repoPath(ctx, rel), rel });

const isPlainDirectory = (stat: { isDirectory: boolean; isSymbolicLink: boolean }): boolean =>
  stat.isDirectory && !stat.isSymbolicLink;

/** One end of a move: its absolute path and the repository-relative path an error names. */
interface MoveEnd {
  readonly abs: string;
  readonly rel: FilePath;
}

const childOf = (end: MoveEnd, name: string): MoveEnd => ({
  abs: `${end.abs}/${name}`,
  rel: `${end.rel}/${name}` as FilePath,
});

/** The directories (pre-order, the root first) and leaves found beneath a directory. */
interface Collected {
  readonly dirs: readonly MoveEnd[];
  readonly leaves: readonly MoveEnd[];
}

const collect = async (ctx: Context, dir: MoveEnd): Promise<Collected> => {
  const dirs: MoveEnd[] = [dir];
  const leaves: MoveEnd[] = [];
  for (const entry of await ctx.fs.readdir(dir.abs)) {
    const child = childOf(dir, entry.name);
    if (!isPlainDirectory(await ctx.fs.lstat(child.abs))) {
      leaves.push(child);
      continue;
    }
    const nested = await collect(ctx, child);
    dirs.push(...nested.dirs);
    leaves.push(...nested.leaves);
  }
  return { dirs, leaves };
};

const mapTo = (end: MoveEnd, from: MoveEnd, to: MoveEnd): MoveEnd => ({
  abs: to.abs + end.abs.slice(from.abs.length),
  rel: (to.rel + end.rel.slice(from.rel.length)) as FilePath,
});

const moveTreeEntryByEntry = async (ctx: Context, from: MoveEnd, to: MoveEnd): Promise<void> => {
  const { dirs, leaves } = await collect(ctx, from);
  for (const dir of dirs) await ctx.fs.mkdir(mapTo(dir, from, to).abs);
  for (const leaf of leaves) {
    await renameNamingDestination(ctx, ctx.fs.rename, leaf, mapTo(leaf, from, to));
  }
  // What remains is exactly what the renames left behind, so a `false` needs no handling.
  await removeEmptyDirectoryTree(ctx, from.abs);
};

type RenameOp = (from: string, to: string) => Promise<void>;

// The source was just read, so a name-too-long refusal from here can only mean the destination.
const renameNamingDestination = async (
  ctx: Context,
  op: RenameOp,
  from: MoveEnd,
  to: MoveEnd,
): Promise<void> => {
  try {
    const parentDir = dirname(to.abs);
    if (parentDir !== '') await ctx.fs.mkdir(parentDir);
    await op.call(ctx.fs, from.abs, to.abs);
  } catch (err) {
    if (isPathTooLong(err)) throw pathTooLong(to.rel);
    throw relativeTo(err, [from, to]);
  }
};

// The adapter names the absolute path it was handed; a caller only knows the repository-relative one.
const relativeTo = (err: unknown, ends: ReadonlyArray<MoveEnd>): unknown => {
  if (!(err instanceof TsgitError) || !('path' in err.data)) return err;
  const { path } = err.data;
  const end = ends.find(({ abs }) => abs === path);
  if (end === undefined) return err;
  return new TsgitError({ ...err.data, path: end.rel });
};
