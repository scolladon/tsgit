import type { FilePath } from '../../../domain/objects/index.js';

/**
 * Join a working-tree-relative path onto the work directory, collapsing a
 * trailing slash so the result is byte-identical regardless of how `workDir`
 * is configured. The single definition shared by every working-tree-write
 * join site (the file writers/remover, changeset application, sparse-checkout).
 */
export const joinPath = (workDir: string, path: FilePath): string =>
  workDir.endsWith('/') ? `${workDir}${path}` : `${workDir}/${path}`;
