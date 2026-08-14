/**
 * Primitive-layer working-tree file writers/remover. Writing creates parent
 * directories; removing is a no-op when the file is already absent. The
 * low-level `writeRegularFile` always unlinks an occupant before a regular
 * write; the mode-aware `writeWorkingTreeEntry` dispatches symlink / gitlink /
 * regular on top of it. Shared by checkout's changeset application and the
 * three-way merge → working-tree application.
 */
import { TsgitError } from '../../../domain/error.js';
import { FILE_MODE, type FileMode, type FilePath } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import { joinPath } from './join-working-tree-path.js';
import { createLeadingPathScanner, type LeadingPathScanner } from './symlinked-leading-path.js';

const decoder = new TextDecoder();

const MODE_REGULAR_PERM = 0o644;
const MODE_EXEC_PERM = 0o755;

/**
 * Remove a working-tree path if it exists, probing with `lstat` (no symlink
 * follow) so dangling symlinks are detected and removed. A missing path is a
 * no-op; any other `lstat` failure propagates instead of being swallowed.
 */
export const rmIfExists = async (ctx: Context, fullPath: string): Promise<void> => {
  let exists: boolean;
  try {
    await ctx.fs.lstat(fullPath);
    exists = true;
  } catch (err) {
    if (err instanceof TsgitError && err.data.code === 'FILE_NOT_FOUND') {
      exists = false;
    } else {
      throw err;
    }
  }
  if (exists) await ctx.fs.rm(fullPath);
};

/**
 * Resolve the scanner a write should consult for its leading-path unlink
 * check: the caller-supplied one when the caller wants its memo shared
 * across multiple writes in the same command invocation, or a fresh
 * single-use one otherwise — identical behaviour to scanning with no memo
 * at all, since it is discarded after this one call.
 */
const resolveScanner = (ctx: Context, scanner?: LeadingPathScanner): LeadingPathScanner =>
  scanner ?? createLeadingPathScanner(ctx);

/**
 * Low-level regular-file writer and the single owner of the
 * unlink-before-regular-write rule: it `rmIfExists` unconditionally before the
 * write so a kind change (symlink → file) self-heals and the memory adapter
 * never keeps a stale symlink entry. `chmod` runs only when a `mode` is given.
 */
export const writeRegularFile = async (
  ctx: Context,
  fullPath: string,
  content: Uint8Array,
  mode?: FileMode,
): Promise<void> => {
  await rmIfExists(ctx, fullPath);
  await ctx.fs.write(fullPath, content);
  if (mode !== undefined) {
    await ctx.fs.chmod(
      fullPath,
      mode === FILE_MODE.EXECUTABLE ? MODE_EXEC_PERM : MODE_REGULAR_PERM,
    );
  }
};

export const writeWorkingTreeFile = async (
  ctx: Context,
  path: FilePath,
  content: Uint8Array,
  scanner?: LeadingPathScanner,
): Promise<void> => {
  await resolveScanner(ctx, scanner).unlinkSymlinkedLeadingComponent(path);
  await writeRegularFile(ctx, joinPath(ctx.layout.workDir, path), content);
};

/**
 * Mode-aware working-tree write dispatching on `FileMode`: symlink (120000) →
 * create a symlink whose target is the blob content decoded as UTF-8 (rm-if-exists
 * first); gitlink (160000) → create the submodule directory (only checkout feeds
 * this arm); regular modes → delegate to `writeRegularFile`, which always unlinks
 * an occupant first so a kind change self-heals. Exported for the merge conflict
 * materialisation step and checkout's changeset application. An optional `scanner`
 * lets the caller share one leading-path memo across many writes in the same
 * command invocation; creating a symlink here invalidates `path`'s own memo
 * entry so a later write that scans `path` as one of ITS leading components
 * observes the fresh shape rather than a stale pre-write verdict.
 */
export const writeWorkingTreeEntry = async (
  ctx: Context,
  path: FilePath,
  content: Uint8Array,
  mode: FileMode,
  scanner?: LeadingPathScanner,
): Promise<void> => {
  const activeScanner = resolveScanner(ctx, scanner);
  await activeScanner.unlinkSymlinkedLeadingComponent(path);
  const fullPath = joinPath(ctx.layout.workDir, path);
  if (mode === FILE_MODE.SYMLINK) {
    await rmIfExists(ctx, fullPath);
    await ctx.fs.symlink(decoder.decode(content), fullPath);
    activeScanner.invalidate(path);
    return;
  }
  if (mode === FILE_MODE.GITLINK) {
    await ctx.fs.mkdir(fullPath);
    return;
  }
  await writeRegularFile(ctx, fullPath, content, mode);
};

/**
 * Streaming sibling of `writeRegularFile`. Preserves the exact
 * `rmIfExists` → `writeStream` → `chmod` order so symlink self-heal and
 * W1/W2 faithfulness hold. Writes straight into the final path (no temp/rename).
 * `chmod` runs only when a `mode` is given.
 */
export const writeRegularFileStream = async (
  ctx: Context,
  fullPath: string,
  source: AsyncIterable<Uint8Array>,
  mode?: FileMode,
): Promise<void> => {
  await rmIfExists(ctx, fullPath);
  await ctx.fs.writeStream(fullPath, source);
  if (mode !== undefined) {
    await ctx.fs.chmod(
      fullPath,
      mode === FILE_MODE.EXECUTABLE ? MODE_EXEC_PERM : MODE_REGULAR_PERM,
    );
  }
};

/**
 * Streaming façade over `writeRegularFileStream` — no mode, so regular perm
 * is applied if/when the adapter defaults it. Mirrors `writeWorkingTreeFile`.
 */
export const writeWorkingTreeFileStream = async (
  ctx: Context,
  path: FilePath,
  source: AsyncIterable<Uint8Array>,
  scanner?: LeadingPathScanner,
): Promise<void> => {
  await resolveScanner(ctx, scanner).unlinkSymlinkedLeadingComponent(path);
  await writeRegularFileStream(ctx, joinPath(ctx.layout.workDir, path), source);
};

/**
 * Regular-only streaming sibling of `writeWorkingTreeEntry`. The `mode`
 * parameter drives the chmod bit only (100644 → 0o644, 100755 → 0o755).
 * Symlink and gitlink modes are NOT dispatched here — site A routes them to
 * the buffered `writeWorkingTreeEntry` instead; a symlink/gitlink branch here
 * would be dead code.
 */
export const writeWorkingTreeEntryStream = async (
  ctx: Context,
  path: FilePath,
  source: AsyncIterable<Uint8Array>,
  mode: FileMode,
  scanner?: LeadingPathScanner,
): Promise<void> => {
  await resolveScanner(ctx, scanner).unlinkSymlinkedLeadingComponent(path);
  await writeRegularFileStream(ctx, joinPath(ctx.layout.workDir, path), source, mode);
};

export const removeWorkingTreeFile = async (ctx: Context, path: FilePath): Promise<void> => {
  const fullPath = joinPath(ctx.layout.workDir, path);
  await rmIfExists(ctx, fullPath);
};
