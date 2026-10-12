/**
 * git's startup prefix: the caller's directory within the worktree,
 * `/`-terminated and empty at its root; `undefined` outside the worktree.
 */
export const startupPrefix = (cwd: string, workDir: string | undefined): string | undefined => {
  if (workDir === undefined) return undefined;
  if (cwd === workDir) return '';
  const root = `${workDir}/`;
  return cwd.startsWith(root) ? `${cwd.slice(root.length)}/` : undefined;
};
