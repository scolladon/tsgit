import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { synthesizeTreeFromIndex } from '../../../../src/application/primitives/synthesize-tree-from-index.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { writeTree } from '../../../../src/application/primitives/write-tree.js';
import type { IndexEntry } from '../../../../src/domain/git-index/index.js';
import { STAGE0_FLAGS } from '../../../../src/domain/git-index/index.js';
import { FILE_MODE } from '../../../../src/domain/objects/file-mode.js';
import type {
  FileMode,
  FilePath,
  ObjectId,
  TreeEntry,
} from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';
import { type FlatPathEntrySpec, flatPathEntrySpecsArb } from './arbitraries.js';
import { buildSeededContext } from './fixtures.js';

/**
 * Pre-rewrite recursive oracle for `synthesizeTreeFromIndex`, copied
 * verbatim from the implementation before this change's explicit-stack
 * rewrite landed — never re-implemented, never paraphrased, and never the
 * production code under test.
 */
interface PendingEntryOracle {
  readonly path: string;
  readonly id: ObjectId;
  readonly mode: FileMode;
}

const groupByPrefixOracle = (
  entries: ReadonlyArray<PendingEntryOracle>,
): {
  readonly files: PendingEntryOracle[];
  readonly subdirs: Map<string, PendingEntryOracle[]>;
} => {
  const files: PendingEntryOracle[] = [];
  const subdirs = new Map<string, PendingEntryOracle[]>();
  for (const entry of entries) {
    const slashIndex = entry.path.indexOf('/');
    if (slashIndex === -1) {
      files.push(entry);
      continue;
    }
    const prefix = entry.path.slice(0, slashIndex);
    const rest = entry.path.slice(slashIndex + 1);
    const bucket = subdirs.get(prefix);
    const sub: PendingEntryOracle = { path: rest, id: entry.id, mode: entry.mode };
    if (bucket === undefined) subdirs.set(prefix, [sub]);
    else bucket.push(sub);
  }
  return { files, subdirs };
};

const synthesizeLevelOracle = async (
  ctx: Context,
  entries: ReadonlyArray<PendingEntryOracle>,
): Promise<ObjectId> => {
  const { files, subdirs } = groupByPrefixOracle(entries);
  const treeEntries: TreeEntry[] = [];
  for (const file of files) {
    treeEntries.push({ name: file.path as FilePath, id: file.id, mode: file.mode });
  }
  for (const [prefix, subEntries] of subdirs) {
    const subId = await synthesizeLevelOracle(ctx, subEntries);
    treeEntries.push({ name: prefix as FilePath, id: subId, mode: FILE_MODE.DIRECTORY });
  }
  return writeTree(ctx, treeEntries);
};

const materializeIndexEntries = async (
  ctx: Context,
  specs: ReadonlyArray<FlatPathEntrySpec>,
): Promise<IndexEntry[]> => {
  const entries: IndexEntry[] = [];
  for (const spec of specs) {
    const id = await writeObject(ctx, {
      type: 'blob',
      content: new TextEncoder().encode(spec.content),
      id: '' as ObjectId,
    });
    entries.push({
      ctimeSeconds: 0,
      ctimeNanoseconds: 0,
      mtimeSeconds: 0,
      mtimeNanoseconds: 0,
      dev: 0,
      ino: 0,
      mode: FILE_MODE.REGULAR,
      uid: 0,
      gid: 0,
      fileSize: 0,
      id,
      flags: { ...STAGE0_FLAGS },
      path: spec.path as FilePath,
    });
  }
  return entries;
};

describe('synthesizeTreeFromIndex properties', () => {
  describe('Given an arbitrary set of non-conflicting flat index paths', () => {
    describe('When synthesised by the production (iterative) implementation', () => {
      it('Then it matches the pre-rewrite recursive oracle', async () => {
        // Arrange + Act + Assert
        await fc.assert(
          fc.asyncProperty(flatPathEntrySpecsArb(), async (specs) => {
            const ctx = await buildSeededContext();
            const entries = await materializeIndexEntries(ctx, specs);
            const oracleEntries: PendingEntryOracle[] = entries.map((e) => ({
              path: e.path as string,
              id: e.id,
              mode: e.mode,
            }));

            const iterative = await synthesizeTreeFromIndex(ctx, entries);
            const recursive = await synthesizeLevelOracle(ctx, oracleEntries);

            expect(iterative).toBe(recursive);
          }),
          { numRuns: 100 },
        );
      });
    });
  });
});
