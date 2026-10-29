import { TsgitError } from '../../../domain/error.js';
import { errorDataCode } from '../../../domain/error-data-code.js';
import type { FilePath, ObjectId } from '../../../domain/objects/object-id.js';
import {
  gitfileNotARepository,
  gitfileTooLarge,
  notARepository,
} from '../../../domain/repository/error.js';
import { parseCommondir, parseGitfilePointer } from '../../../domain/worktree/gitfile.js';
import { resolveWorktreePath } from '../../../domain/worktree/resolve-path.js';
import type { Context } from '../../../ports/context.js';
import type { FileStat, FileSystem } from '../../../ports/file-system.js';
import type { AlternatePathProbe } from '../../../ports/object-source-access.js';
import { narrowAlternatePathProbe } from '../object-store.js';
import { resolveRefOrMissing } from '../resolve-ref.js';
import { refStorageOf } from './gitlink-ref-storage.js';
import { type HeadFile, seedHeadFile } from './head-file.js';
import { joinPath } from './join-working-tree-path.js';
import { isUsableHead, requireWorkTree } from './repo-state.js';
import { deriveGitlinkContext } from './submodule-context.js';
import { worktreeScopedFs } from './worktree-context.js';

const DOT_GIT = '.git';
const COMMONDIR_FILE = 'commondir';
const SEPARATOR = '/';
// Mirrors git's cap on a gitfile (`read_gitfile_gently`): a larger `.git` file is refused unread.
const MAX_GITFILE_SIZE = 1 << 20;
// git reads a repository's HEAD into a 256-byte buffer, one of which terminates the string.
const HEAD_PREFIX_BYTES = 255;
// git reads a commondir whole and resolves it as a path, so only a file past the gitfile cap is left unnamed.
const COMMONDIR_MAX_BYTES = MAX_GITFILE_SIZE;
// Resolving HEAD reads the whole file, which a ref line cannot outgrow: PATH_MAX for the name plus `ref: `.
const HEAD_REF_LINE_MAX_BYTES = 4096 + 'ref: '.length;
const NUL = 0;
const TEXT_DECODER = new TextDecoder();
const UNFOLLOWED_LINK_CODES: ReadonlySet<string> = new Set(['FILE_NOT_FOUND', 'PERMISSION_DENIED']);
const NOT_A_DIRECTORY_CODES: ReadonlySet<string> = new Set([
  ...UNFOLLOWED_LINK_CODES,
  'NOT_A_DIRECTORY',
]);

/** How `<path>/.git` reaches the repository: as the directory itself (a link to one included), or as a gitfile git reads. */
export type CheckoutVia = 'directory' | 'gitfile';

/** Why a checkout is broken: its `.git` is a directory, a gitfile that names no valid repository, or a gitfile git cannot parse. */
export type BrokenVia = CheckoutVia | 'unparsed-gitfile';

/** Where a checkout's repository lies on disk, how `.git` reaches it, the path git names it by when it is broken, and the filesystem that reaches it. */
interface Located {
  readonly kind: 'located';
  readonly via: CheckoutVia;
  readonly gitDir: string;
  readonly shown: FilePath;
  readonly fs: FileSystem;
}

/** What <path>/.git leads to: nothing, a repository git refuses to read (named as git names it), a gitfile too large for git to read, or one whose HEAD is read on demand. */
export type GitlinkCheckout =
  | { readonly kind: 'none' }
  | { readonly kind: 'oversized'; readonly shown: FilePath }
  | { readonly kind: 'broken'; readonly via: BrokenVia; readonly shown: FilePath }
  | {
      readonly kind: 'repository';
      readonly via: CheckoutVia;
      readonly head: () => Promise<ObjectId | undefined>;
      readonly context: () => Promise<Context>;
    };

export type Broken = Extract<GitlinkCheckout, { readonly kind: 'broken' }>;
type Oversized = Extract<GitlinkCheckout, { readonly kind: 'oversized' }>;

const broken = (shown: FilePath, via: BrokenVia): Broken => ({ kind: 'broken', via, shown });

/** git names a gitfile that leads to no valid repository apart from a `.git` it cannot recognise as one. */
export const brokenCheckoutRefusal = (checkout: Broken): TsgitError =>
  checkout.via === 'gitfile'
    ? gitfileNotARepository(checkout.shown)
    : notARepository(checkout.shown);

/**
 * The commit checked out at a gitlink, read as git's `resolve_gitlink_ref` does:
 * through `<path>/.git`, a directory, a symlink to one, or a gitfile whose target
 * may lie anywhere (it is only read, never written). `undefined` when nothing is
 * checked out there or the checkout has no commit; a `.git` that leads to no
 * repository refuses, as git dies on it.
 */
export const gitlinkHeadOf = async (
  ctx: Context,
  path: FilePath,
): Promise<ObjectId | undefined> => {
  const checkout = await probeGitlinkCheckout(ctx, path);
  if (checkout.kind === 'broken') throw brokenCheckoutRefusal(checkout);
  if (checkout.kind === 'oversized') throw gitfileTooLarge(checkout.shown);
  if (checkout.kind === 'none') return undefined;
  return checkout.head();
};

/** Classifies `<path>/.git` as data, so a caller decides whether a broken checkout refuses. */
export const probeGitlinkCheckout = async (
  ctx: Context,
  path: FilePath,
): Promise<GitlinkCheckout> => {
  const checkout = joinPath(requireWorkTree(ctx, 'add'), path);
  const located = await locateCheckout(ctx, checkout, path);
  if (located === undefined) return { kind: 'none' };
  if (located.kind === 'broken' || located.kind === 'oversized') return located;
  const { gitDir } = located;
  // HEAD is a plain file under either ref backend, so it is judged before the config is read.
  const { judged, resolved } = await boundedHeadFile(located.fs, gitDir);
  if (!isUsableHead(judged)) return broken(located.shown, located.via);
  const reached = await reaching(ctx, located);
  if (reached.kind === 'broken') return reached;
  const { commonDir, fs } = reached;
  if (!(await holdsObjectsAndRefs(fs, commonDir))) return broken(located.shown, located.via);
  return repositoryCheckout(ctx, path, { gitDir, via: located.via, commonDir, fs, resolved });
};

interface ReachedRepository {
  readonly gitDir: string;
  readonly via: CheckoutVia;
  readonly commonDir: string;
  readonly fs: FileSystem;
  readonly resolved: HeadFile;
}

/** The repository variant: its context and HEAD are derived on demand, the HEAD from the bytes already read. */
const repositoryCheckout = (
  ctx: Context,
  path: FilePath,
  { gitDir, via, commonDir, fs, resolved }: ReachedRepository,
): GitlinkCheckout => {
  const context = async (): Promise<Context> =>
    deriveGitlinkContext(ctx, gitDir, path, {
      fs,
      commonDir,
      refStorage: await refStorageOf(fs, commonDir),
    });
  const head = async (): Promise<ObjectId | undefined> => {
    const child = await context();
    seedHeadFile(child, resolved);
    return resolveGitlinkHead(child);
  };
  return { kind: 'repository', via, head, context };
};

/**
 * git's `resolve_gitlink_ref` reports a HEAD it cannot read as a plain failure and
 * `add` then keeps the recorded commit; only a `.git` that leads to no repository, or
 * a malformed repository format, dies. Every failure of the resolution itself is
 * therefore "no resolvable HEAD", while anything that is not a tsgit refusal is a bug.
 */
const resolveGitlinkHead = async (child: Context): Promise<ObjectId | undefined> => {
  try {
    return await resolveRefOrMissing(child, 'HEAD');
  } catch (err) {
    if (err instanceof TsgitError) return undefined;
    throw err;
  }
};

/**
 * A linked worktree's admin dir names its common dir — where shared refs and config
 * live — in `commondir`, relative to the admin dir or absolute; the filesystem is
 * widened to reach it.
 */
const reaching = async (
  ctx: Context,
  { gitDir, fs, shown, via }: Located,
): Promise<
  Broken | { readonly kind: 'reached'; readonly commonDir: string; readonly fs: FileSystem }
> => {
  const declared = await commondirBytes(fs, `${gitDir}${SEPARATOR}${COMMONDIR_FILE}`);
  // git reads the file into a buffer and fails on a zero-byte one, unlike a bare newline.
  if (declared?.length === 0) return broken(shown, via);
  const value = declared === undefined ? undefined : commondirValue(declared);
  if (value === 'unnameable') return broken(shown, via);
  if (value?.kind !== 'ok') return { kind: 'reached', commonDir: gitDir, fs };
  const commonDir = resolveWorktreePath(gitDir, value.path);
  return { kind: 'reached', commonDir, fs: worktreeScopedFs(ctx, [gitDir, commonDir]) };
};

/** One byte past the bound tells a path that fits from one that does not, without reading the rest. */
const commondirBytes = async (fs: FileSystem, path: string): Promise<Uint8Array | undefined> => {
  try {
    return await fs.readSlice(path, 0, COMMONDIR_MAX_BYTES + 1);
  } catch (err) {
    if (errorDataCode(err) === 'FILE_NOT_FOUND') return undefined;
    throw err;
  }
};

/**
 * git takes the file as a C string: it ends at the first NUL, and only a newline ending
 * the whole file is trimmed, so one before a NUL stays part of the name. A name emptied
 * by a leading NUL resolves to the admin dir itself, as git's realpath of `<gitdir>/` does.
 */
const commondirValue = (bytes: Uint8Array): ReturnType<typeof parseCommondir> | 'unnameable' => {
  const nul = bytes.indexOf(NUL);
  if (nul !== -1) return { kind: 'ok', path: TEXT_DECODER.decode(bytes.subarray(0, nul)) };
  if (bytes.length > COMMONDIR_MAX_BYTES) return 'unnameable';
  return parseCommondir(TEXT_DECODER.decode(bytes));
};

interface BoundedHead {
  readonly judged: HeadFile;
  readonly resolved: HeadFile;
}

/**
 * git's `validate_headref` looks at a symlink's text or at the first bytes of the file, never
 * at the rest, yet resolves the ref from the whole file; a file that fills the read bound
 * is too long to name a ref, so it resolves to no commit rather than from the judged prefix.
 */
const boundedHeadFile = async (fs: FileSystem, gitDir: string): Promise<BoundedHead> => {
  const head = `${gitDir}${SEPARATOR}HEAD`;
  try {
    const stat = await fs.lstat(head);
    if (stat.isSymbolicLink) {
      const link: HeadFile = { kind: 'symlink', linkText: await fs.readlink(head) };
      return { judged: link, resolved: link };
    }
    const bytes = await fs.readSlice(head, 0, HEAD_REF_LINE_MAX_BYTES);
    const judged = fileOf(bytes.subarray(0, HEAD_PREFIX_BYTES));
    return { judged, resolved: bytes.length < HEAD_REF_LINE_MAX_BYTES ? fileOf(bytes) : NO_REF };
  } catch (cause) {
    if (cause instanceof TsgitError) {
      const unusable: HeadFile = { kind: 'unusable', cause };
      return { judged: unusable, resolved: unusable };
    }
    throw cause;
  }
};

// An empty HEAD names no ref, so resolving it ends in no commit.
const NO_REF: HeadFile = { kind: 'file', content: '' };

const fileOf = (bytes: Uint8Array): HeadFile => ({
  kind: 'file',
  content: TEXT_DECODER.decode(bytes),
});

/** git's `is_git_directory`: `objects` and `refs` directories beside a HEAD it can validate. */
export const isGitDirectory = async (fs: FileSystem, directory: string): Promise<boolean> =>
  (await holdsObjectsAndRefs(fs, directory)) &&
  isUsableHead((await boundedHeadFile(fs, directory)).judged);

/** The `objects` and `refs` directories git's `is_git_directory` looks for. */
const holdsObjectsAndRefs = async (fs: FileSystem, commonDir: string): Promise<boolean> =>
  (await isDirectory(fs, `${commonDir}${SEPARATOR}objects`)) &&
  (await isDirectory(fs, `${commonDir}${SEPARATOR}refs`));

const isDirectory = async (fs: FileSystem, absolute: string): Promise<boolean> => {
  try {
    return (await fs.stat(absolute)).isDirectory;
  } catch (err) {
    if (err instanceof TsgitError && NOT_A_DIRECTORY_CODES.has(err.data.code)) return false;
    throw err;
  }
};

const locateCheckout = async (
  ctx: Context,
  checkout: string,
  path: FilePath,
): Promise<Located | Broken | Oversized | undefined> => {
  const dotGit = `${checkout}${SEPARATOR}${DOT_GIT}`;
  const stat = await lstatOrMissing(ctx, dotGit);
  if (stat === undefined) return undefined;
  if (stat.isDirectory) return directoryCheckout(ctx, checkout, path);
  if (stat.isSymbolicLink) return symlinkCheckout(ctx, checkout, path);
  return gitfileOfSize(ctx, checkout, path, stat);
};

/** git reads a `.git` only when its followed stat is a regular file, and refuses one past its cap without reading it. */
const gitfileOfSize = async (
  ctx: Context,
  checkout: string,
  path: FilePath,
  stat: FileStat,
): Promise<Located | Broken | Oversized | undefined> => {
  if (!stat.isFile) return undefined;
  if (stat.size > MAX_GITFILE_SIZE) return { kind: 'oversized', shown: dotGitShown(path) };
  return gitfileCheckout(ctx, checkout, path);
};

const dotGitShown = (path: FilePath): FilePath => `${path}${SEPARATOR}${DOT_GIT}` as FilePath;

const directoryCheckout = (ctx: Context, checkout: string, path: FilePath): Located => ({
  kind: 'located',
  via: 'directory',
  gitDir: `${checkout}${SEPARATOR}${DOT_GIT}`,
  shown: dotGitShown(path),
  fs: ctx.fs,
});

/**
 * git `stat`s `.git`, so a link to a repository directory is that directory, wherever it
 * lies, and a link to nothing, or one that loops, is no checkout at all; a link to a file is a gitfile.
 */
const symlinkCheckout = async (
  ctx: Context,
  checkout: string,
  path: FilePath,
): Promise<Located | Broken | Oversized | undefined> => {
  const dotGit = `${checkout}${SEPARATOR}${DOT_GIT}`;
  const target = await statOrUnreachable(ctx, dotGit);
  if (target === undefined) return undefined;
  if (target.isDirectory) return linkedCheckout(ctx, checkout, path);
  return gitfileOfSize(ctx, checkout, path, target);
};

/**
 * A `.git` link that cannot be followed leaves nothing checked out: a dangling link, or a
 * loop or unsearchable target, which the adapters report alike as PERMISSION_DENIED.
 */
export const statOrUnreachable = async (ctx: Context, dotGit: string) => {
  try {
    return await metadataOf(ctx, dotGit).stat(dotGit);
  } catch (err) {
    if (err instanceof TsgitError && UNFOLLOWED_LINK_CODES.has(err.data.code)) return undefined;
    throw err;
  }
};

const metadataOf = (ctx: Context, path: string): AlternatePathProbe =>
  ctx.alternatePathProbe?.(path) ?? narrowAlternatePathProbe(ctx.fs);

const linkedCheckout = async (ctx: Context, checkout: string, path: FilePath): Promise<Located> => {
  const dotGit = `${checkout}${SEPARATOR}${DOT_GIT}`;
  const gitDir = resolveWorktreePath(checkout, await metadataOf(ctx, dotGit).readlink(dotGit));
  return {
    kind: 'located',
    via: 'directory',
    gitDir,
    shown: dotGitShown(path),
    fs: worktreeScopedFs(ctx, gitDir),
  };
};

const gitfileCheckout = async (
  ctx: Context,
  checkout: string,
  path: FilePath,
): Promise<Located | Broken> => {
  const dotGit = dotGitShown(path);
  const pointer = parseGitfilePointer(await ctx.fs.readUtf8(`${checkout}${SEPARATOR}${DOT_GIT}`));
  if (pointer.kind !== 'ok') return broken(dotGit, 'unparsed-gitfile');
  const gitDir = resolveWorktreePath(checkout, pointer.path);
  return {
    kind: 'located',
    via: 'gitfile',
    gitDir,
    shown: dotGit,
    fs: worktreeScopedFs(ctx, gitDir),
  };
};

const lstatOrMissing = async (ctx: Context, absolute: string) => {
  try {
    return await ctx.fs.lstat(absolute);
  } catch (err) {
    if (err instanceof TsgitError && err.data.code === 'FILE_NOT_FOUND') return undefined;
    throw err;
  }
};
