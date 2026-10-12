import type { FileSystem } from '../ports/file-system.js';

/** The `Context.worktreeFs` capability: a filesystem reaching the given worktree path(s). */
export type WorktreeFs = (worktreePath: string | ReadonlyArray<string>) => FileSystem;

/**
 * Builds the worktree-fs capability: each request reaches exactly the worktree
 * path(s) asked for plus the layout roots, through `confine`, which receives
 * that root set — a linked worktree lives outside `workDir`, so the confined
 * filesystem must widen to reach it without opening anything beyond it.
 * Memoised by root set — `listWorktrees` asks once per worktree, and a fresh
 * adapter per call for the same worktree is pure waste.
 */
export const createWorktreeFs = (
  layoutRoots: ReadonlyArray<string>,
  confine: (roots: ReadonlyArray<string>) => FileSystem,
): WorktreeFs => {
  const cache = new Map<string, FileSystem>();
  return (worktreePath) => {
    const paths = typeof worktreePath === 'string' ? [worktreePath] : worktreePath;
    const roots = [...paths, ...layoutRoots];
    const cacheKey = roots.join('\0');
    const cached = cache.get(cacheKey);
    if (cached !== undefined) return cached;
    const built = confine(roots);
    cache.set(cacheKey, built);
    return built;
  };
};
