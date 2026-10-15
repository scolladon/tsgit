import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { synthesizeTreeFromIndex } from '../../../../src/application/primitives/synthesize-tree-from-index.js';
import { walkTree } from '../../../../src/application/primitives/walk-tree.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { writeTree } from '../../../../src/application/primitives/write-tree.js';
import type { IndexEntry } from '../../../../src/domain/git-index/index.js';
import { STAGE0_FLAGS } from '../../../../src/domain/git-index/index.js';
import { indexPathKey, pathBytesOf } from '../../../../src/domain/git-index/index-path-key.js';
import { bytesToHex } from '../../../../src/domain/objects/encoding.js';
import { FILE_MODE } from '../../../../src/domain/objects/file-mode.js';
import type {
  FileMode,
  FilePath,
  ObjectId,
  TreeEntry,
} from '../../../../src/domain/objects/index.js';
import { treeEntry } from '../../../../src/domain/objects/tree.js';
import type { Context } from '../../../../src/ports/context.js';
import { arbIndexEntryWithPathBytes } from '../../domain/git-index/arbitraries.js';
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
    treeEntries.push(treeEntry(file.mode, file.path as FilePath, file.id));
  }
  for (const [prefix, subEntries] of subdirs) {
    const subId = await synthesizeLevelOracle(ctx, subEntries);
    treeEntries.push(treeEntry(FILE_MODE.DIRECTORY, prefix as FilePath, subId));
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

  describe('Given arbitrary stage-0 entries with raw path bytes and no file/directory clash', () => {
    describe('When synthesized and walked with path bytes', () => {
      it('Then the leaf path bytes are exactly the entries path bytes', async () => {
        // Arrange
        const SLASH = 0x2f;
        const isPrefixOf = (a: Uint8Array, b: Uint8Array): boolean =>
          b.length > a.length && b[a.length] === SLASH && a.every((byte, i) => b[i] === byte);
        const clashFree = fc
          .array(arbIndexEntryWithPathBytes(), { minLength: 1, maxLength: 8 })
          .filter((entries) => {
            const keys = new Set(entries.map(indexPathKey));
            if (keys.size !== entries.length) return false;
            return !entries.some((a) =>
              entries.some((b) => isPrefixOf(pathBytesOf(a), pathBytesOf(b))),
            );
          });

        // Act + Assert
        await fc.assert(
          fc.asyncProperty(clashFree, async (entries) => {
            const ctx = await buildSeededContext();
            const regular = entries.map((e) => ({
              ...e,
              mode: FILE_MODE.REGULAR,
              flags: { ...e.flags, stage: 0 as const },
            }));
            const sut = await synthesizeTreeFromIndex(ctx, regular);
            const leaves: string[] = [];
            for await (const leaf of walkTree(ctx, sut, { recursive: true, pathBytes: true })) {
              if (leaf.mode !== FILE_MODE.DIRECTORY)
                leaves.push(bytesToHex(leaf.pathBytes as Uint8Array));
            }
            const expected = regular.map((e) => bytesToHex(pathBytesOf(e)));
            expect(leaves.sort()).toEqual(expected.sort());
          }),
          { numRuns: 50 },
        );
      });
    });
  });
});
