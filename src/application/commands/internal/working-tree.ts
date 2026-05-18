import { checkoutOverwriteDirty, pathspecOutsideRepo } from '../../../domain/commands/error.js';
import { TsgitError } from '../../../domain/error.js';
import { unsupportedOperation } from '../../../domain/index.js';
import type { FileMode } from '../../../domain/objects/file-mode.js';
import type { FilePath } from '../../../domain/objects/object-id.js';
import type { Context } from '../../../ports/context.js';

const MAX_PATH_BYTES = 4096;
const MAX_COMPONENT_BYTES = 255;
const PATH_ENCODER = new TextEncoder();

// `.git` reject is enforced via the regex strip in isForbiddenGitComponent below;
// the explicit set carries only the canonical literal for clarity.
const GIT_FORBIDDEN: ReadonlySet<string> = new Set(['.git']);

/**
 * Validate a working-tree path. Throws `PATHSPEC_OUTSIDE_REPO` for any policy
 * violation. Returns the input as a `FilePath` brand on success.
 *
 * Rules (cross-platform safe; conservative):
 * - Non-empty.
 * - No leading `/` (absolute paths are forbidden).
 * - No `\` (use POSIX separators).
 * - No NUL bytes.
 * - Components allowed-char set: no control characters (0x00-0x1F, 0x7F).
 * - No `.` or `..` components, no empty components.
 * - No `.git` component (case-insensitive). Also rejects NTFS quirks
 *   `.git ` (trailing space), `.git.` (trailing dot), and other prefix-of-`.git`
 *   variants.
 * - Length caps: total path ≤ 4096 bytes; each component ≤ 255 bytes.
 */
export const validatePath = (input: string): FilePath => {
  if (input === '') reject(input);
  if (byteLength(input) > MAX_PATH_BYTES) reject(input);
  if (input.startsWith('/')) reject(input);
  if (input.includes('\\')) reject(input);
  if (input.includes('\0')) reject(input);
  const components = input.split('/');
  for (const component of components) {
    rejectComponent(component, input);
  }
  return input as FilePath;
};

const reject = (input: string): never => {
  throw pathspecOutsideRepo(input as FilePath);
};

const rejectComponent = (component: string, original: string): void => {
  if (component === '') reject(original); // empty component → trailing slash or // sequence.
  if (component === '.' || component === '..') reject(original);
  if (byteLength(component) > MAX_COMPONENT_BYTES) reject(original);
  if (isForbiddenGitComponent(component)) reject(original);
  // Reject `:` to block NTFS Alternate Data Streams (`.git:$DATA`) and
  // Windows drive-letter qualifiers (`C:relative`). POSIX paths never need `:`.
  if (component.includes(':')) reject(original);
  for (let i = 0; i < component.length; i += 1) {
    const code = component.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) reject(original);
  }
};

export const isForbiddenGitComponent = (component: string): boolean => {
  const lowered = component.toLowerCase();
  if (GIT_FORBIDDEN.has(lowered)) return true;
  // NTFS strips trailing spaces/dots — treat any `.git` followed only by
  // whitespace/dots as `.git` (defensive against future variants).
  const trimmed = lowered.replace(/[. ]+$/, '');
  return trimmed === '.git';
};

const byteLength = (s: string): number => PATH_ENCODER.encode(s).length;

const repoPath = (ctx: Context, path: FilePath): string => `${ctx.layout.workDir}/${path}`;

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
 * Read the working-tree file at `path`. Validates the path first.
 */
export const readFile = async (ctx: Context, rawPath: string): Promise<Uint8Array> => {
  const path = validatePath(rawPath);
  return ctx.fs.read(repoPath(ctx, path));
};

/**
 * Remove the working-tree file at `path`. Refuses to remove a directory or a
 * missing file (both treated as a divergence from what we expected to be there).
 * Throws `CHECKOUT_OVERWRITE_DIRTY` rather than blindly mutating.
 */
export const removeFile = async (ctx: Context, rawPath: string): Promise<void> => {
  const path = validatePath(rawPath);
  const full = repoPath(ctx, path);
  let stat: Awaited<ReturnType<Context['fs']['lstat']>>;
  try {
    stat = await ctx.fs.lstat(full);
  } catch {
    throw checkoutOverwriteDirty([path]);
  }
  if (!stat.isFile && !stat.isSymbolicLink) {
    throw checkoutOverwriteDirty([path]);
  }
  await ctx.fs.rm(full);
};
