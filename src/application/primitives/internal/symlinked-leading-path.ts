/**
 * Detect (and, on request, unlink) a symlinked leading directory component of
 * a working-tree-relative path — git's `has_symlinked_leading_path` +
 * `lstat_cache` equivalent, plus checkout's leading-component unlink-before-write
 * step built on the SAME per-directory memo. Shape-based: fires identically
 * whether the link points inside or outside the repository, and regardless of
 * whether anything exists beyond it. The leaf component itself is never
 * scanned — git stages a symlinked leaf as a regular `120000` entry.
 */
import { TsgitError } from '../../../domain/error.js';
import type { FilePath } from '../../../domain/objects/object-id.js';
import type { Context } from '../../../ports/context.js';
import { joinPath } from './join-working-tree-path.js';
import { createPromiseMemo, type PromiseMemo } from './promise-memo.js';
import { requireWorkTree } from './repo-state.js';

export interface LeadingPathScanner {
  /** True when any leading component of `path` (its directories, never the leaf) is a symlink. */
  readonly hasSymlinkedLeadingPath: (path: FilePath) => Promise<boolean>;
  /** The first leading component of `path` (its directories, never the leaf) that is a symlink — the path git names for it. */
  readonly symlinkedLeadingComponent: (path: FilePath) => Promise<FilePath | undefined>;
  /**
   * Unlink the first symlinked leading directory component of `path`, if
   * any — git's checkout materialisation: a leading directory that is a
   * symlink, whether it resolves outside the repository or at an intra-repo
   * sibling, is unlinked and replaced by a real directory. A missing
   * ancestor means there is nothing to unlink.
   */
  readonly unlinkSymlinkedLeadingComponent: (path: FilePath) => Promise<void>;
  /**
   * Drop `path`'s memo entry, forcing the next scan of it to re-`lstat`.
   * Required after any write that changes what lives AT `path` and could
   * later be scanned as an ancestor of a deeper path: creating a symlink
   * there (was 'plain'/'missing', now 'symlink') or unlinking a symlink
   * there (handled internally by `unlinkSymlinkedLeadingComponent`).
   */
  readonly invalidate: (path: FilePath) => void;
  /**
   * git's `create_directories`: make every leading directory of `path` a real
   * directory, one component at a time and never recursively. A missing
   * component is created; a symlink or a regular file standing in the way is
   * removed first, so a later write can never be routed through a link.
   */
  readonly ensureLeadingDirectories: (path: FilePath) => Promise<void>;
  /** Forget every verdict. Memo keys are spellings, so a case-folding disk can outdate any of them. */
  readonly invalidateAll: () => void;
}

type PrefixShape = 'symlink' | 'directory' | 'other' | 'missing';

/**
 * Build a scanner whose per-directory memo lives for the scanner's lifetime
 * (one command invocation, like the working-tree stat map) — a repeated
 * prefix across a multi-literal pathspec set costs exactly one `lstat`.
 */
export const createLeadingPathScanner = (ctx: Context): LeadingPathScanner => {
  // One single-flight memo per prefix, not a plain settled-value cache: two
  // concurrent scans of the SAME prefix (delete wave + write wave running
  // through the same pool) would otherwise both miss the cache before
  // either write lands, doubling the `lstat`. `createPromiseMemo` caches the
  // IN-FLIGHT promise itself, so the second caller joins the first's flight.
  const memo = new Map<string, PromiseMemo<PrefixShape>>();
  // Single-flights the UNLINK step itself, separate from `memo` above: two
  // concurrent `unlinkSymlinkedLeadingComponent` calls for the SAME prefix
  // both join the same classifyPrefix flight and can therefore both observe
  // 'symlink' before either has unlinked it — without this, both would call
  // `ctx.fs.rm` and the loser throws FILE_NOT_FOUND on an already-removed
  // path (`rm` is not idempotent). Keyed and cleared independently of
  // `memo` so a later, unrelated scan of the same prefix still re-lstats.
  const unlinkMemo = new Map<string, PromiseMemo<void>>();
  const workDir = requireWorkTree(ctx, 'createLeadingPathScanner');

  const classifyPrefix = (prefix: string): Promise<PrefixShape> => {
    let entry = memo.get(prefix);
    if (entry === undefined) {
      entry = createPromiseMemo(() => lstatPrefix(prefix));
      memo.set(prefix, entry);
    }
    return entry.get();
  };

  const unlinkPrefixOnce = (prefix: string): Promise<void> => {
    let entry = unlinkMemo.get(prefix);
    if (entry === undefined) {
      entry = createPromiseMemo(async () => {
        await ctx.fs.rm(joinPath(workDir, prefix));
        // The prefix is no longer a symlink (or exists at all, until a
        // deeper write recreates it as a real directory) — a stale 'symlink'
        // verdict must not survive to serve a later lookup of this same
        // prefix, so drop it rather than guess its post-unlink shape.
        memo.delete(prefix);
      });
      unlinkMemo.set(prefix, entry);
    }
    return entry.get();
  };

  const lstatPrefix = async (prefix: string): Promise<PrefixShape> => {
    try {
      const stat = await ctx.fs.lstat(joinPath(workDir, prefix));
      if (stat.isSymbolicLink) return 'symlink';
      return stat.isDirectory ? 'directory' : 'other';
    } catch (err) {
      // A missing prefix is not a symlink. Never swallow anything else —
      // a genuine PERMISSION_DENIED (or similar) must propagate.
      if (err instanceof TsgitError && err.data.code === 'FILE_NOT_FOUND') return 'missing';
      throw err;
    }
  };

  const symlinkedLeadingComponent = async (path: FilePath): Promise<FilePath | undefined> => {
    const segments = path.split('/');
    // Stryker disable next-line StringLiteral: equivalent — split() always returns at least one element, so the '' default can never activate.
    let prefix = segments[0] ?? '';
    for (let i = 1; i < segments.length; i += 1) {
      const shape = await classifyPrefix(prefix);
      // Nothing can sit beneath a missing prefix or a regular file, and a real
      // filesystem refuses to stat there — stop walking rather than ask.
      if (shape === 'missing' || shape === 'other') return undefined;
      if (shape === 'symlink') return prefix as FilePath;
      prefix = `${prefix}/${segments[i]}`;
    }
    return undefined;
  };

  const hasSymlinkedLeadingPath = async (path: FilePath): Promise<boolean> =>
    (await symlinkedLeadingComponent(path)) !== undefined;

  const unlinkSymlinkedLeadingComponent = async (path: FilePath): Promise<void> => {
    const segments = path.split('/');
    // Stryker disable next-line StringLiteral: equivalent — split() always returns at least one element, so the '' default can never activate.
    let prefix = segments[0] ?? '';
    for (let i = 1; i < segments.length; i += 1) {
      const shape = await classifyPrefix(prefix);
      if (shape === 'missing') {
        // Every call site (write-working-tree-file.ts) writes to `path`
        // immediately after this returns, and that write auto-creates any
        // missing ancestor directory (the FileSystem port's `write`/`symlink`
        // contract) — so `prefix` is very likely about to stop being
        // missing. Drop the memo rather than let a stale 'missing' verdict
        // survive to short-circuit a LATER scan (via this method or
        // `hasSymlinkedLeadingPath`) before it ever reaches a symlink
        // deeper under this now-materialised prefix.
        memo.delete(prefix);
        return;
      }
      if (shape === 'symlink') {
        await unlinkPrefixOnce(prefix);
        return;
      }
      prefix = `${prefix}/${segments[i]}`;
    }
  };

  const invalidate = (path: FilePath): void => {
    memo.delete(path);
  };

  const makeDirectory = async (prefix: string): Promise<void> => {
    await ctx.fs.mkdir(joinPath(workDir, prefix));
    memo.set(
      prefix,
      createPromiseMemo<PrefixShape>(async () => 'directory'),
    );
  };

  const ensureDirectory = async (prefix: string): Promise<void> => {
    const shape = await classifyPrefix(prefix);
    if (shape === 'directory') return;
    if (shape !== 'missing') await ctx.fs.rm(joinPath(workDir, prefix));
    await makeDirectory(prefix);
  };

  const ensureLeadingDirectories = async (path: FilePath): Promise<void> => {
    const segments = path.split('/');
    let prefix = '';
    for (const segment of segments.slice(0, -1)) {
      prefix = prefix === '' ? segment : `${prefix}/${segment}`;
      await ensureDirectory(prefix);
    }
  };

  const invalidateAll = (): void => {
    memo.clear();
  };

  return {
    hasSymlinkedLeadingPath,
    symlinkedLeadingComponent,
    unlinkSymlinkedLeadingComponent,
    invalidate,
    ensureLeadingDirectories,
    invalidateAll,
  };
};
