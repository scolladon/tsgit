import type { FilePath } from '../../../domain/objects/index.js';
import { assertOrdered } from '../snapshot/path-merge.js';

export interface DirGroup<R> {
  readonly path: FilePath;
  readonly rows: ReadonlyArray<R>;
}

const dirOf = (path: FilePath): FilePath => {
  const slash = path.lastIndexOf('/');
  return (slash === -1 ? '' : path.slice(0, slash)) as FilePath;
};

/**
 * Groups consecutive rows by their parent directory. Because the row
 * stream is sorted by path (`assertOrdered` enforced upstream), entries
 * sharing a directory always arrive contiguously — no buffering of
 * unrelated rows is required.
 */
export const groupByDir = <R extends { readonly path: FilePath }>() =>
  async function* (source: AsyncIterable<R>): AsyncIterable<DirGroup<R>> {
    let currentDir: FilePath | null = null;
    let rows: R[] = [];
    for await (const row of assertOrdered(source)) {
      const dir = dirOf(row.path);
      // equivalent-mutant: replacing `currentDir === null` with `false` is
      // observably equivalent — `dir` is always a string (possibly `""`),
      // `currentDir` is either `null` or a string, so on the first iter
      // `dir !== currentDir` evaluates to `'something' !== null = true`
      // and the branch is entered anyway. The null check is defensive.
      if (currentDir === null || dir !== currentDir) {
        // equivalent-mutant: replacing `rows.length > 0` with `true` (or
        // `>= 0`) is observably equivalent — on every iter that reaches
        // this point with `currentDir !== null`, rows has at least one
        // entry (initialised to `[row]` on the previous new-group hit).
        if (currentDir !== null && rows.length > 0) {
          yield { path: currentDir, rows };
        }
        currentDir = dir;
        rows = [row];
      } else {
        rows.push(row);
      }
    }
    // equivalent-mutant: same reasoning as the in-loop yield gate above —
    // when `currentDir !== null` here, the loop ran at least once and
    // `rows` was last assigned `[row]`, so `rows.length > 0` is always true.
    if (currentDir !== null && rows.length > 0) {
      yield { path: currentDir, rows };
    }
  };
