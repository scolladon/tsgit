/**
 * Primitive-layer working-tree file writers/remover. Writing creates parent
 * directories; removing is a no-op when the file is already absent. The
 * low-level `writeRegularFile` always unlinks an occupant before a regular
 * write; the mode-aware `writeWorkingTreeEntry` dispatches symlink / gitlink /
 * regular on top of it. Shared by checkout's changeset application and the
 * three-way merge → working-tree application.
 */
import type { ChunkTransform } from '../../../domain/eol/chunk-transform.js';
import { TsgitError } from '../../../domain/error.js';
import { hasEscapedBytes } from '../../../domain/objects/encoding.js';
import { objectNotFound, unexpectedObjectType } from '../../../domain/objects/error.js';
import {
  FILE_MODE,
  type FileMode,
  type FilePath,
  type ObjectId,
} from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import { type BlobSource, locateBlob, NEVER_BUFFER, serveLocatedBlob } from './blob-source.js';
import { joinPath } from './join-working-tree-path.js';
import { requireWorkTree } from './repo-state.js';
import { createLeadingPathScanner, type LeadingPathScanner } from './symlinked-leading-path.js';

const decoder = new TextDecoder();

const MODE_REGULAR_PERM = 0o644;
const MODE_EXEC_PERM = 0o755;
const EMPTY_CONTENT = new Uint8Array();

const permFor = (mode: FileMode): number =>
  mode === FILE_MODE.EXECUTABLE ? MODE_EXEC_PERM : MODE_REGULAR_PERM;

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
  await writeRegularFile(
    ctx,
    joinPath(requireWorkTree(ctx, 'writeWorkingTreeFile'), path),
    content,
  );
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
  const fullPath = joinPath(requireWorkTree(ctx, 'writeWorkingTreeFile'), path);
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

const isOperationAborted = (failure: unknown): boolean =>
  failure instanceof TsgitError && failure.data.code === 'OPERATION_ABORTED';

const chunksOf = async function* (source: BlobSource): AsyncIterable<Uint8Array> {
  if (source.kind === 'stream') {
    yield* source.stream;
    return;
  }
  if (source.content.length > 0) yield source.content;
};

const transformedChunks = async function* (
  chunks: AsyncIterable<Uint8Array>,
  transform: ChunkTransform,
): AsyncIterable<Uint8Array> {
  for await (const chunk of chunks) yield* transform.push(chunk);
  yield* transform.flush();
};

/**
 * What git leaves when a streamed checkout write is refused: the file exists
 * and is empty. If creating it fails too, that failure is the one reported,
 * with the refusal kept as its `cause`.
 */
const createEmptyOutput = async (
  ctx: Context,
  fullPath: string,
  refusal: unknown,
  mode?: FileMode,
): Promise<void> => {
  try {
    await ctx.fs.write(fullPath, EMPTY_CONTENT);
    if (mode !== undefined) await ctx.fs.chmod(fullPath, permFor(mode));
  } catch (createFailure) {
    const error = createFailure instanceof Error ? createFailure : new Error(String(createFailure));
    error.cause = refusal;
    throw error;
  }
};

/** git's `odb_read_stream_open` dies on a loose object whose header does not
 *  unpack, after the output file was created and before any unlink: the empty
 *  file stays. Any other arm declines to git's in-core read, which leaves no file. */
const openServedBlob = async (
  ctx: Context,
  fullPath: string,
  located: Parameters<typeof serveLocatedBlob>[1],
  mode?: FileMode,
): Promise<BlobSource> => {
  try {
    return await serveLocatedBlob(ctx, located, NEVER_BUFFER, { order: 'stream' });
  } catch (refusal) {
    if (located.arm !== 'loose' || isOperationAborted(refusal)) throw refusal;
    await createEmptyOutput(ctx, fullPath, refusal, mode);
    throw refusal;
  }
};

const writeServedBlob = async (
  ctx: Context,
  fullPath: string,
  located: Parameters<typeof serveLocatedBlob>[1],
  mode?: FileMode,
  transform?: ChunkTransform,
): Promise<void> => {
  const source = await openServedBlob(ctx, fullPath, located, mode);
  try {
    if (source.type !== 'blob') {
      if (source.kind === 'stream') await source.release();
      throw unexpectedObjectType('blob', source.type, located.id);
    }
    const chunks = chunksOf(source);
    await ctx.fs.writeStream(
      fullPath,
      transform === undefined ? chunks : transformedChunks(chunks, transform),
    );
    if (mode !== undefined) await ctx.fs.chmod(fullPath, permFor(mode));
  } catch (failure) {
    await rmIfExists(ctx, fullPath);
    throw failure;
  }
};

/**
 * Writes blob `id` to `fullPath` the way git's streaming checkout does: the
 * occupant is unlinked first, a refused locate leaves an empty file, a failure
 * while serving leaves nothing. The empty file is created only on refusal so
 * the success path costs no extra syscall.
 */
export const writeStreamedBlob = async (
  ctx: Context,
  fullPath: string,
  id: ObjectId,
  mode?: FileMode,
  transform?: ChunkTransform,
): Promise<void> => {
  await rmIfExists(ctx, fullPath);
  let located: Awaited<ReturnType<typeof locateBlob>>;
  try {
    located = await locateBlob(ctx, id, { order: 'stream' });
  } catch (refusal) {
    if (isOperationAborted(refusal)) throw refusal;
    await createEmptyOutput(ctx, fullPath, refusal, mode);
    throw refusal;
  }
  if (located === undefined) throw objectNotFound(id);
  await writeServedBlob(ctx, fullPath, located, mode, transform);
};

/**
 * Streaming façade over `writeStreamedBlob` — no mode, so the adapter's
 * default permissions apply. Mirrors `writeWorkingTreeFile`.
 */
export const writeWorkingTreeFileStream = async (
  ctx: Context,
  path: FilePath,
  id: ObjectId,
  scanner?: LeadingPathScanner,
  transform?: ChunkTransform,
): Promise<void> => {
  await resolveScanner(ctx, scanner).unlinkSymlinkedLeadingComponent(path);
  await writeStreamedBlob(
    ctx,
    joinPath(requireWorkTree(ctx, 'writeWorkingTreeFile'), path),
    id,
    undefined,
    transform,
  );
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
  id: ObjectId,
  mode: FileMode,
  scanner?: LeadingPathScanner,
  transform?: ChunkTransform,
): Promise<void> => {
  await resolveScanner(ctx, scanner).unlinkSymlinkedLeadingComponent(path);
  await writeStreamedBlob(
    ctx,
    joinPath(requireWorkTree(ctx, 'writeWorkingTreeFile'), path),
    id,
    mode,
    transform,
  );
};

export const removeWorkingTreeFile = async (ctx: Context, path: FilePath): Promise<void> => {
  if (hasEscapedBytes(path)) return;
  const fullPath = joinPath(requireWorkTree(ctx, 'writeWorkingTreeFile'), path);
  await rmIfExists(ctx, fullPath);
};
