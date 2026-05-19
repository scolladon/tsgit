/**
 * Injectable surface for the Node `fs/promises` calls that `NodeFileSystem`
 * needs. Production code uses `realFsOps`; tests inject a partial fake.
 *
 * Why this exists:
 * - `vi.mock('node:fs/promises')` is file-scoped and patches the module
 *  system. It dumps every test that "needs to mock fs" into one bucket
 *  (the previous `node-file-system-containment.test.ts` smell).
 * - Dependency injection at the adapter constructor makes the dependency
 *  explicit, scoped per-instance, and cross-platform by construction —
 *  tests don't depend on Vitest's mock machinery to swap the fs surface.
 * - The interface is a `Pick` of `fsPromises` so production code can just
 *  pass the real module without writing any glue. Tests pass a fake
 *  object that satisfies the subset they exercise.
 *
 * @internal — not re-exported from `src/adapters/node/index.ts`.
 */

import * as fsPromises from 'node:fs/promises';

export type FsOperations = Pick<
  typeof fsPromises,
  | 'chmod'
  | 'lstat'
  | 'mkdir'
  | 'open'
  | 'readdir'
  | 'readFile'
  | 'readlink'
  | 'realpath'
  | 'rename'
  | 'rm'
  | 'rmdir'
  | 'stat'
  | 'symlink'
  | 'writeFile'
>;

/** Production FS operations: the real `node:fs/promises` module. */
export const realFsOps: FsOperations = fsPromises;
