import { describe, expect, it } from 'vitest';
import { readObject } from '../../../../src/application/primitives/read-object.js';
import { synthesizeTreeFromIndex } from '../../../../src/application/primitives/synthesize-tree-from-index.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { writeTree } from '../../../../src/application/primitives/write-tree.js';
import type { GitIndex, IndexEntry } from '../../../../src/domain/git-index/index.js';
import { STAGE0_FLAGS } from '../../../../src/domain/git-index/index.js';
import { NO_PARSER_OFFSET } from '../../../../src/domain/git-index/path-validator.js';
import { FILE_MODE } from '../../../../src/domain/objects/file-mode.js';
import type { FileMode, FilePath, ObjectId, Tree } from '../../../../src/domain/objects/index.js';
import { buildSeededContext } from './fixtures.js';

const EMPTY_INDEX: GitIndex = { version: 2, entries: [], extensions: [] };

const writeBlob = async (
  ctx: Awaited<ReturnType<typeof buildSeededContext>>,
  content: string,
): Promise<ObjectId> =>
  writeObject(ctx, {
    type: 'blob',
    content: new TextEncoder().encode(content),
    id: '' as ObjectId,
  });

const makeIndexEntry = (
  path: string,
  id: ObjectId,
  mode: FileMode = FILE_MODE.REGULAR,
  stage: 0 | 1 | 2 | 3 = 0,
): IndexEntry => ({
  ctimeSeconds: 0,
  ctimeNanoseconds: 0,
  mtimeSeconds: 0,
  mtimeNanoseconds: 0,
  dev: 0,
  ino: 0,
  mode,
  uid: 0,
  gid: 0,
  fileSize: 0,
  id,
  flags: { ...STAGE0_FLAGS, stage },
  path: path as FilePath,
});

describe('synthesizeTreeFromIndex', () => {
  describe('Given an empty index', () => {
    describe('When synthesise', () => {
      it('Then returns the canonical empty-tree ObjectId', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const emptyTreeId = await writeTree(ctx, []);
        const sut = synthesizeTreeFromIndex;

        // Act
        const result = await sut(ctx, EMPTY_INDEX.entries);

        // Assert
        expect(result).toBe(emptyTreeId);
      });
    });
  });

  describe('Given an index with one root-level file', () => {
    describe('When synthesise', () => {
      it('Then root tree has one regular entry', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const blobId = await writeBlob(ctx, 'hello');
        const index: GitIndex = {
          ...EMPTY_INDEX,
          entries: [makeIndexEntry('a.txt', blobId)],
        };
        const sut = synthesizeTreeFromIndex;

        // Act
        const treeId = await sut(ctx, index.entries);

        // Assert — read the tree back and verify its single entry.
        const tree = (await readObject(ctx, treeId)) as Tree;
        expect(tree.type).toBe('tree');
        expect(tree.entries).toHaveLength(1);
        expect(tree.entries[0]?.name).toBe('a.txt');
        expect(tree.entries[0]?.id).toBe(blobId);
        expect(tree.entries[0]?.mode).toBe(FILE_MODE.REGULAR);
      });
    });
  });

  describe('Given an index with nested paths', () => {
    describe('When synthesise', () => {
      it('Then produces correctly-nested trees', async () => {
        // Arrange — paths: 'a.txt', 'dir/b.txt', 'dir/sub/c.txt'.
        const ctx = await buildSeededContext();
        const idA = await writeBlob(ctx, 'A');
        const idB = await writeBlob(ctx, 'B');
        const idC = await writeBlob(ctx, 'C');
        const index: GitIndex = {
          ...EMPTY_INDEX,
          entries: [
            makeIndexEntry('a.txt', idA),
            makeIndexEntry('dir/b.txt', idB),
            makeIndexEntry('dir/sub/c.txt', idC),
          ],
        };
        const sut = synthesizeTreeFromIndex;

        // Act
        const rootId = await sut(ctx, index.entries);

        // Assert — walk the structure: root → { a.txt, dir }; dir → { b.txt, sub }; sub → { c.txt }.
        // Length assertions at every level pin against a mutation that would leak
        // an entry into both the files-at-level list AND the subdir map.
        const root = (await readObject(ctx, rootId)) as Tree;
        expect(root.entries).toHaveLength(2);
        const aEntry = root.entries.find((e) => e.name === 'a.txt');
        const dirEntry = root.entries.find((e) => e.name === 'dir');
        expect(aEntry?.id).toBe(idA);
        expect(aEntry?.mode).toBe(FILE_MODE.REGULAR);
        expect(dirEntry?.mode).toBe(FILE_MODE.DIRECTORY);

        const dirTree = (await readObject(ctx, dirEntry?.id as ObjectId)) as Tree;
        expect(dirTree.entries).toHaveLength(2);
        const bEntry = dirTree.entries.find((e) => e.name === 'b.txt');
        const subEntry = dirTree.entries.find((e) => e.name === 'sub');
        expect(bEntry?.id).toBe(idB);
        expect(subEntry?.mode).toBe(FILE_MODE.DIRECTORY);

        const subTree = (await readObject(ctx, subEntry?.id as ObjectId)) as Tree;
        expect(subTree.entries).toHaveLength(1);
        expect(subTree.entries[0]?.name).toBe('c.txt');
        expect(subTree.entries[0]?.id).toBe(idC);
      });
    });
  });

  describe('Given an index with stage-2 (unmerged) entries', () => {
    describe('When synthesise', () => {
      it('Then the unmerged entries are filtered out', async () => {
        // Arrange — only stage-0 entries should reach the tree; stage-2 means
        // "unresolved merge" and is invisible to the synthesis (consistent with
        // computeChangeset + buildIndexFromTree).
        const ctx = await buildSeededContext();
        const stagedId = await writeBlob(ctx, 'staged');
        const unmergedId = await writeBlob(ctx, 'theirs-version');
        const index: GitIndex = {
          ...EMPTY_INDEX,
          entries: [
            makeIndexEntry('a.txt', stagedId, FILE_MODE.REGULAR, 0),
            makeIndexEntry('conflict.txt', unmergedId, FILE_MODE.REGULAR, 2),
          ],
        };
        const sut = synthesizeTreeFromIndex;

        // Act
        const treeId = await sut(ctx, index.entries);

        // Assert — only a.txt appears. Asserting the full name list (rather than
        // just length) pins what was filtered: a mutation that allows stage-2
        // entries through would surface `conflict.txt` in the output.
        const tree = (await readObject(ctx, treeId)) as Tree;
        expect(tree.entries.map((e) => e.name)).toEqual(['a.txt']);
      });
    });
  });

  describe('Given an index round-tripped from a known commit', () => {
    describe('When synthesise', () => {
      it("Then returns the commit's tree id", async () => {
        // Arrange — write a tree explicitly, then build an index that mirrors
        // that tree exactly. The synthesis must round-trip to the same id.
        const ctx = await buildSeededContext();
        const idA = await writeBlob(ctx, 'A');
        const idB = await writeBlob(ctx, 'B');
        // Build a nested tree manually so we have a canonical reference.
        const subId = await writeTree(ctx, [
          { name: 'inner.txt' as FilePath, id: idB, mode: FILE_MODE.REGULAR },
        ]);
        const expectedRootId = await writeTree(ctx, [
          { name: 'a.txt' as FilePath, id: idA, mode: FILE_MODE.REGULAR },
          { name: 'dir' as FilePath, id: subId, mode: FILE_MODE.DIRECTORY },
        ]);

        // The index that this tree corresponds to (flat, stage-0).
        const index: GitIndex = {
          ...EMPTY_INDEX,
          entries: [makeIndexEntry('a.txt', idA), makeIndexEntry('dir/inner.txt', idB)],
        };
        const sut = synthesizeTreeFromIndex;

        // Act
        const synthesised = await sut(ctx, index.entries);

        // Assert — IDENTITY: synthesis matches the canonical tree byte-for-byte.
        expect(synthesised).toBe(expectedRootId);
      });
    });
  });

  describe('Given an index with multiple files in the same subdirectory', () => {
    describe('When synthesise', () => {
      it('Then the subdirectory has all its files', async () => {
        // Arrange — pins that group-by-prefix doesn't lose siblings.
        const ctx = await buildSeededContext();
        const id1 = await writeBlob(ctx, 'one');
        const id2 = await writeBlob(ctx, 'two');
        const id3 = await writeBlob(ctx, 'three');
        const index: GitIndex = {
          ...EMPTY_INDEX,
          entries: [
            makeIndexEntry('src/a.ts', id1),
            makeIndexEntry('src/b.ts', id2),
            makeIndexEntry('src/c.ts', id3),
          ],
        };
        const sut = synthesizeTreeFromIndex;

        // Act
        const rootId = await sut(ctx, index.entries);

        // Assert
        const root = (await readObject(ctx, rootId)) as Tree;
        expect(root.entries).toHaveLength(1);
        expect(root.entries[0]?.name).toBe('src');
        const srcTree = (await readObject(ctx, root.entries[0]?.id as ObjectId)) as Tree;
        const names = srcTree.entries.map((e) => e.name).sort();
        expect(names).toEqual(['a.ts', 'b.ts', 'c.ts']);
      });
    });
  });

  describe('Given a round-trip with three root siblings', () => {
    describe('When synthesise', () => {
      it('Then ordering matches the canonical tree', async () => {
        // Arrange — three root-level siblings; if the synthesis emits them in a
        // permuted order, the resulting tree SHA would diverge from the canonical
        // one. A mutation that reverses the entries list would surface here.
        const ctx = await buildSeededContext();
        const idA = await writeBlob(ctx, 'A');
        const idM = await writeBlob(ctx, 'M');
        const idZ = await writeBlob(ctx, 'Z');
        const expectedRootId = await writeTree(ctx, [
          { name: 'a.txt' as FilePath, id: idA, mode: FILE_MODE.REGULAR },
          { name: 'm.txt' as FilePath, id: idM, mode: FILE_MODE.REGULAR },
          { name: 'z.txt' as FilePath, id: idZ, mode: FILE_MODE.REGULAR },
        ]);
        const index: GitIndex = {
          ...EMPTY_INDEX,
          entries: [
            makeIndexEntry('a.txt', idA),
            makeIndexEntry('m.txt', idM),
            makeIndexEntry('z.txt', idZ),
          ],
        };
        const sut = synthesizeTreeFromIndex;

        // Act
        const synthesised = await sut(ctx, index.entries);

        // Assert
        expect(synthesised).toBe(expectedRootId);
      });
    });
  });

  // hoisted unsafe-path rejection (`..`, `.`, empty segments,
  // leading-slash) into `parseIndex` itself; see
  // `test/unit/domain/git-index/index-parser.test.ts` for the full grid
  // of cases. One defence-in-depth case stays HERE to prove the
  // primitive ALSO rejects unsafe paths when callers construct
  // IndexEntry records outside the parser (test fixtures, in-memory
  // builders, future synthesisers).

  describe('Given an IndexEntry constructed outside parseIndex with a `..` path', () => {
    describe('When synthesise', () => {
      it('Then still throws INVALID_INDEX_ENTRY (defence-in-depth)', async () => {
        // Arrange — bypass parseIndex by building the entry directly via the
        // test helper. The primitive must re-validate.
        const ctx = await buildSeededContext();
        const blobId = await writeBlob(ctx, 'malicious');
        const index: GitIndex = {
          ...EMPTY_INDEX,
          entries: [makeIndexEntry('../etc/passwd', blobId)],
        };
        const sut = synthesizeTreeFromIndex;

        // Act
        let caught: unknown;
        try {
          await sut(ctx, index.entries);
        } catch (err) {
          caught = err;
        }

        // Assert — code + reason + the NO_PARSER_OFFSET sentinel (proves the
        // primitive uses the documented sentinel rather than misleadingly
        // claiming the failure was at byte 0 of some index file). Importing
        // the symbol (not the literal -1) catches a mutation that flips the
        // sentinel value at the definition site.
        const data = (caught as { data?: { code?: string; reason?: string; offset?: number } })
          ?.data;
        expect(data?.code).toBe('INVALID_INDEX_ENTRY');
        expect(data?.reason).toBe("'..' segment rejected");
        expect(data?.offset).toBe(NO_PARSER_OFFSET);
      });
    });
  });

  describe('Given an index path with depth exceeding MAX_TREE_DEPTH', () => {
    describe('When synthesise', () => {
      it('Then throws TREE_DEPTH_EXCEEDED carrying the exact slash count', async () => {
        // Arrange — a path with 4098 segments has 4097 slashes, one over the
        // cap (4096). The error's `depth` is the slash count: asserting its
        // exact value pins the slash-counting loop. A mutation that empties
        // the loop body, flips `+= 1` to `-= 1`, or counts non-slash chars
        // would produce a different `depth` (or skip the throw entirely).
        const ctx = await buildSeededContext();
        const blobId = await writeBlob(ctx, 'deep');
        const segments = Array.from({ length: 4098 }, (_, i) => `d${i}`);
        const deepPath = segments.join('/');
        const index: GitIndex = {
          ...EMPTY_INDEX,
          entries: [makeIndexEntry(deepPath, blobId)],
        };
        const sut = synthesizeTreeFromIndex;

        // Act
        let caught: unknown;
        try {
          await sut(ctx, index.entries);
        } catch (err) {
          caught = err;
        }

        // Assert — code AND the exact slash count (4097).
        const data = (caught as { data?: { code?: string; depth?: number } })?.data;
        expect(data?.code).toBe('TREE_DEPTH_EXCEEDED');
        expect(data?.depth).toBe(4097);
      });
    });
  });

  describe('Given an index path with exactly MAX_TREE_DEPTH slashes', () => {
    describe('When synthesise', () => {
      it('Then the depth cap does NOT reject it (boundary)', async () => {
        // Arrange — 4097 segments => exactly 4096 slashes, which equals the
        // cap. The guard is `slashCount > MAX_TREE_DEPTH`, so 4096 must NOT
        // raise TREE_DEPTH_EXCEEDED. This pins `>` against `>=` (which would
        // reject this path with a TREE_DEPTH_EXCEEDED carrying depth 4096)
        // and against `<` (which rejects every shallower path too).
        //
        // Synthesis itself recurses 4096 frames deep and overflows the JS
        // call stack with a plain RangeError — exactly the behaviour the
        // module doc predicts (the cap is enforced at the input boundary
        // because the stack overflows before recursion could re-check it).
        // We therefore assert the *kind* of failure: NOT a tsgit depth
        // error, proving `assertDepthBounded` accepted the boundary path.
        const ctx = await buildSeededContext();
        const blobId = await writeBlob(ctx, 'edge');
        const segments = Array.from({ length: 4097 }, (_, i) => `d${i}`);
        const boundaryPath = segments.join('/');
        const index: GitIndex = {
          ...EMPTY_INDEX,
          entries: [makeIndexEntry(boundaryPath, blobId)],
        };
        const sut = synthesizeTreeFromIndex;

        // Act
        let caught: unknown;
        try {
          await sut(ctx, index.entries);
        } catch (err) {
          caught = err;
        }

        // Assert — the boundary path is NOT rejected by the depth cap.
        const data = (caught as { data?: { code?: string } })?.data;
        expect(data?.code).not.toBe('TREE_DEPTH_EXCEEDED');
      });
    });
  });

  describe('Given an index entry with an executable mode', () => {
    describe('When synthesise', () => {
      it('Then the executable mode is preserved', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const blobId = await writeBlob(ctx, '#!/bin/sh');
        const index: GitIndex = {
          ...EMPTY_INDEX,
          entries: [makeIndexEntry('run.sh', blobId, FILE_MODE.EXECUTABLE)],
        };
        const sut = synthesizeTreeFromIndex;

        // Act
        const treeId = await sut(ctx, index.entries);

        // Assert
        const tree = (await readObject(ctx, treeId)) as Tree;
        expect(tree.entries[0]?.mode).toBe(FILE_MODE.EXECUTABLE);
      });
    });
  });
});
