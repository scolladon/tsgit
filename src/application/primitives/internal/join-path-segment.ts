/**
 * Join a repo-relative path segment onto a repo-relative prefix, guarding the
 * empty prefix so a root-level segment yields the bare leaf (never a leading
 * `/`). The single definition shared by the tree walkers and `mv`'s into-dir
 * target build. NOT the same join as the working-tree-write `joinPath`.
 */
export const joinPathSegment = (prefix: string, leaf: string): string =>
  prefix === '' ? leaf : `${prefix}/${leaf}`;
