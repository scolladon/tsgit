/**
 * Detect whether any leading directory component of a working-tree-relative
 * path is a symbolic link — git's `has_symlinked_leading_path` +
 * `lstat_cache` equivalent. Shape-based: fires identically whether the link
 * points inside or outside the repository, and regardless of whether
 * anything exists beyond it. The leaf component itself is never scanned —
 * git stages a symlinked leaf as a regular `120000` entry.
 */
import { TsgitError } from '../../../domain/error.js';
import type { FilePath } from '../../../domain/objects/object-id.js';
import type { Context } from '../../../ports/context.js';
import { joinPath } from './join-working-tree-path.js';

export interface LeadingPathScanner {
  /** True when any leading component of `path` (its directories, never the leaf) is a symlink. */
  readonly hasSymlinkedLeadingPath: (path: FilePath) => Promise<boolean>;
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
    for (let i = 1; i < segments.length; i += 1) {
      const prefix = segments.slice(0, i).join('/');
      const shape = await classifyPrefix(prefix);
      // A missing prefix means no real filesystem could have a deeper entry
      // beneath it either — stop walking rather than trust a longer prefix.
      if (shape === 'missing') return false;
      if (shape === 'symlink') return true;
    }
    return false;
  };

  return { hasSymlinkedLeadingPath };
};
