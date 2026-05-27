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
      if (currentDir === null || dir !== currentDir) {
        if (currentDir !== null && rows.length > 0) {
          yield { path: currentDir, rows };
        }
        currentDir = dir;
        rows = [row];
      } else {
        rows.push(row);
      }
    }
    if (currentDir !== null && rows.length > 0) {
      yield { path: currentDir, rows };
    }
  };
