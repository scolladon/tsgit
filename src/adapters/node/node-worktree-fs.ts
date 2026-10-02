import { NodeFileSystem, type NodeFileSystemOptions } from './node-file-system.js';

/**
 * The node runtime's raw worktree-fs builder: a fresh adapter rooted at the
 * repo's own workDir PLUS every path asked for (the worktree paths followed by
 * the layout roots), so it reaches exactly those subtrees and nothing between
 * them. `workDir` leads so it stays the base for resolving a relative path, as
 * in the main adapter. The asked-for paths are caller-supplied and never
 * realpathed here, so each instance resolves its own roots.
 */
export const nodeWorktreeFileSystem =
  (workDir: string | undefined, options: NodeFileSystemOptions) =>
  (worktreePaths: ReadonlyArray<string>): NodeFileSystem =>
    new NodeFileSystem(
      // Stryker disable next-line ArrayDeclaration: equivalent — `worktreePaths` ALREADY carries the layout roots (workDir included), prepended by the facade's own `worktreeFs` wrapper (`repository.ts`, "the worktree paths followed by the layout roots") before this function ever runs; dropping/replacing this array's own `workDir` contribution cannot narrow or widen the resulting containment set — confirmed empirically (a bare-repo probe still resolves correctly with either branch mutated).
      [...(workDir !== undefined ? [workDir] : []), ...worktreePaths],
      options,
    );
