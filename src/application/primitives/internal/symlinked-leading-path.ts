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

export interface LeadingPathScanner {
  /** True when any leading component of `path` (its directories, never the leaf) is a symlink. */
  readonly hasSymlinkedLeadingPath: (path: FilePath) => Promise<boolean>;
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
}

type PrefixShape = 'symlink' | 'plain' | 'missing';

/**
 * Build a scanner whose per-directory memo lives for the scanner's lifetime
 * (one command invocation, like the working-tree stat map) — a repeated
 * prefix across a multi-literal pathspec set costs exactly one `lstat`.
 */
export const createLeadingPathScanner = (ctx: Context): LeadingPathScanner => {
  const memo = new Map<string, PrefixShape>();

  const classifyPrefix = async (prefix: string): Promise<PrefixShape> => {
    const cached = memo.get(prefix);
    if (cached !== undefined) return cached;
    const shape = await lstatPrefix(prefix);
    memo.set(prefix, shape);
    return shape;
  };

  const lstatPrefix = async (prefix: string): Promise<PrefixShape> => {
    try {
      const stat = await ctx.fs.lstat(joinPath(ctx.layout.workDir, prefix));
      return stat.isSymbolicLink ? 'symlink' : 'plain';
    } catch (err) {
      // A missing prefix is not a symlink. Never swallow anything else —
      // a genuine PERMISSION_DENIED (or similar) must propagate.
      if (err instanceof TsgitError && err.data.code === 'FILE_NOT_FOUND') return 'missing';
      throw err;
    }
  };

  const hasSymlinkedLeadingPath = async (path: FilePath): Promise<boolean> => {
    const segments = path.split('/');
    // Stryker disable next-line StringLiteral: equivalent — split() always returns at least one element, so the '' default can never activate.
    let prefix = segments[0] ?? '';
    for (let i = 1; i < segments.length; i += 1) {
      const shape = await classifyPrefix(prefix);
      // A missing prefix means no real filesystem could have a deeper entry
      // beneath it either — stop walking rather than trust a longer prefix.
      if (shape === 'missing') return false;
      if (shape === 'symlink') return true;
      prefix = `${prefix}/${segments[i]}`;
    }
    return false;
  };

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
        await ctx.fs.rm(joinPath(ctx.layout.workDir, prefix));
        // The prefix is no longer a symlink (or exists at all, until a
        // deeper write recreates it as a real directory) — a stale 'symlink'
        // verdict must not survive to serve a later lookup of this same
        // prefix, so drop it rather than guess its post-unlink shape.
        memo.delete(prefix);
        return;
      }
      prefix = `${prefix}/${segments[i]}`;
    }
  };

  const invalidate = (path: FilePath): void => {
    memo.delete(path);
  };

  return { hasSymlinkedLeadingPath, unlinkSymlinkedLeadingComponent, invalidate };
};
