/**
 * Injectable surfaces for the Node `fs` calls that `NodeFileSystem` needs:
 * the async `fs/promises` surface, and its synchronous twin for the
 * per-turn sync fast path. Production code uses `realFsOps` /
 * `realSyncFsOps`; tests inject a partial fake of either.
 *
 * Why this exists:
 * - `vi.mock('node:fs/promises')` is file-scoped and patches the module
 *  system. It dumps every test that "needs to mock fs" into one bucket
 *  (the previous `node-file-system-containment.test.ts` smell).
 * - Dependency injection at the adapter constructor makes the dependency
 *  explicit, scoped per-instance, and cross-platform by construction —
 *  tests don't depend on Vitest's mock machinery to swap the fs surface.
 * - Each interface is a `Pick` of the underlying module so production code
 *  can just pass the real module without writing any glue. Tests pass a
 *  fake object that satisfies the subset they exercise.
 *
 * @internal — not re-exported from `src/adapters/node/index.ts`.
 */

import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';

export type FsOperations = Pick<
  typeof fsPromises,
  | 'appendFile'
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

export type SyncFsOperations = Pick<
  typeof fs,
  'statSync' | 'lstatSync' | 'readlinkSync' | 'openSync' | 'fstatSync' | 'readSync' | 'closeSync'
> & {
  readonly realpathSync: { readonly native: typeof fs.realpathSync.native };
  /**
   * Async read on an already-open descriptor — the over-the-sync-gate
   * handoff's own read, so a large file's async completion reuses the sync
   * probe's `openSync`'d fd instead of paying a second `open`.
   */
  readonly readAsync: (
    fd: number,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ) => Promise<number>;
};

/** Promisified `fs.read` on a raw descriptor — `fs/promises` has no fd-based read. */
const readAsync: SyncFsOperations['readAsync'] = (fd, buffer, offset, length, position) =>
  new Promise((resolve, reject) => {
    fs.read(fd, buffer, offset, length, position, (err, bytesRead) => {
      if (err) reject(err);
      else resolve(bytesRead);
    });
  });

/** Production sync FS operations: the real `node:fs` module. */
export const realSyncFsOps: SyncFsOperations = { ...fs, readAsync };
