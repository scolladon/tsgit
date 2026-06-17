/**
 * Join a working-tree path onto the work directory, collapsing a trailing
 * slash so the result is byte-identical regardless of how `workDir` is
 * configured. The single definition shared by every working-tree-write join
 * site (the file writers/remover, changeset application, sparse-checkout).
 */
export const joinPath = (workDir: string, path: string): string =>
  workDir.endsWith('/') ? `${workDir}${path}` : `${workDir}/${path}`;
