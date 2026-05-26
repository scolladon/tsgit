import { describe, expect, it } from 'vitest';

import { computeChangeset } from '../../../../src/application/primitives/compute-changeset.js';
import type { GitIndex, IndexEntry } from '../../../../src/domain/git-index/index.js';
import { STAGE0_FLAGS } from '../../../../src/domain/git-index/index.js';
import { FILE_MODE } from '../../../../src/domain/objects/file-mode.js';
import type { FileMode, FilePath, ObjectId } from '../../../../src/domain/objects/index.js';

const OID_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as ObjectId;
const OID_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as ObjectId;
const OID_C = 'cccccccccccccccccccccccccccccccccccccccc' as ObjectId;

const makeEntry = (path: string, id: ObjectId, mode: FileMode = FILE_MODE.REGULAR): IndexEntry => ({
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
  flags: STAGE0_FLAGS,
  path: path as FilePath,
});

const makeIndex = (entries: IndexEntry[]): GitIndex => ({
  version: 2,
  entries,
  extensions: [],
  trailerSha: new Uint8Array(0),
});

const makeTreeEntry = (
  path: string,
  id: ObjectId,
  mode: FileMode = FILE_MODE.REGULAR,
): { path: FilePath; id: ObjectId; mode: FileMode } => ({
  path: path as FilePath,
  id,
  mode,
});

describe('computeChangeset', () => {
  describe('Given an empty index and empty target tree', () => {
    describe('When computeChangeset runs', () => {
      it('Then returns no entries', () => {
        // Arrange
        const sut = computeChangeset;

        // Act
        const result = sut(makeIndex([]), []);

        // Assert
        expect(result.entries).toEqual([]);
        expect(result.stats).toEqual({ add: 0, update: 0, delete: 0, noop: 0 });
      });
    });
  });

  describe('Given an empty index and a tree with one blob', () => {
    describe('When computeChangeset runs', () => {
      it('Then emits one add', () => {
        // Arrange
        const sut = computeChangeset;

        // Act
        const result = sut(makeIndex([]), [makeTreeEntry('foo.txt', OID_A)]);

        // Assert
        expect(result.entries).toHaveLength(1);
        expect(result.entries[0]).toEqual({
          kind: 'add',
          path: 'foo.txt',
          mode: FILE_MODE.REGULAR,
          id: OID_A,
          previousId: undefined,
          previousMode: undefined,
        });
        expect(result.stats).toEqual({ add: 1, update: 0, delete: 0, noop: 0 });
      });
    });
  });

  describe('Given an index with one entry and empty target tree', () => {
    describe('When computeChangeset runs', () => {
      it('Then emits one delete', () => {
        // Arrange
        const sut = computeChangeset;

        // Act
        const result = sut(makeIndex([makeEntry('foo.txt', OID_A)]), []);

        // Assert
        expect(result.entries).toHaveLength(1);
        expect(result.entries[0]).toEqual({
          kind: 'delete',
          path: 'foo.txt',
          mode: FILE_MODE.REGULAR,
          id: undefined,
          previousId: OID_A,
          previousMode: FILE_MODE.REGULAR,
        });
        expect(result.stats).toEqual({ add: 0, update: 0, delete: 1, noop: 0 });
      });
    });
  });

  describe('Given an index entry and target entry with the same oid and mode', () => {
    describe('When computeChangeset runs', () => {
      it('Then emits one noop', () => {
        // Arrange
        const sut = computeChangeset;

        // Act
        const result = sut(makeIndex([makeEntry('foo.txt', OID_A)]), [
          makeTreeEntry('foo.txt', OID_A),
        ]);

        // Assert
        expect(result.entries).toHaveLength(1);
        expect(result.entries[0]?.kind).toBe('noop');
        expect(result.stats.noop).toBe(1);
      });
    });
  });

  describe('Given an index entry and a target entry with a different oid', () => {
    describe('When computeChangeset runs', () => {
      it('Then emits one update', () => {
        // Arrange
        const sut = computeChangeset;

        // Act
        const result = sut(makeIndex([makeEntry('foo.txt', OID_A)]), [
          makeTreeEntry('foo.txt', OID_B),
        ]);

        // Assert
        expect(result.entries[0]).toEqual({
          kind: 'update',
          path: 'foo.txt',
          mode: FILE_MODE.REGULAR,
          id: OID_B,
          previousId: OID_A,
          previousMode: FILE_MODE.REGULAR,
        });
        expect(result.stats.update).toBe(1);
      });
    });
  });

  describe('Given an index entry and a target entry with same oid but different mode', () => {
    describe('When computeChangeset runs', () => {
      it('Then emits one update', () => {
        // Arrange
        const sut = computeChangeset;

        // Act — mode-only flip (regular → executable)
        const result = sut(makeIndex([makeEntry('foo.sh', OID_A, FILE_MODE.REGULAR)]), [
          makeTreeEntry('foo.sh', OID_A, FILE_MODE.EXECUTABLE),
        ]);

        // Assert
        expect(result.entries[0]?.kind).toBe('update');
        expect(result.entries[0]?.mode).toBe(FILE_MODE.EXECUTABLE);
        expect(result.entries[0]?.previousMode).toBe(FILE_MODE.REGULAR);
        expect(result.stats.update).toBe(1);
      });
    });
  });

  describe('Given mixed paths across index and target tree', () => {
    describe('When computeChangeset runs', () => {
      it('Then result entries are sorted by path', () => {
        // Arrange
        const sut = computeChangeset;
        const index = makeIndex([
          makeEntry('b.txt', OID_A),
          makeEntry('a.txt', OID_A),
          makeEntry('c.txt', OID_A),
        ]);
        const tree = [
          makeTreeEntry('c.txt', OID_B),
          makeTreeEntry('a.txt', OID_A),
          makeTreeEntry('d.txt', OID_C),
        ];

        // Act
        const result = sut(index, tree);

        // Assert — sorted paths regardless of input order
        expect(result.entries.map((e) => e.path)).toEqual(['a.txt', 'b.txt', 'c.txt', 'd.txt']);
        expect(result.stats).toEqual({ add: 1, update: 1, delete: 1, noop: 1 });
      });
    });
  });

  describe('Given an index with a non-stage-0 entry', () => {
    describe('When computeChangeset runs', () => {
      it('Then ignores the non-stage-0 entry', () => {
        // Arrange
        const sut = computeChangeset;
        const stagedConflict: IndexEntry = {
          ...makeEntry('conflict.txt', OID_A),
          flags: { ...STAGE0_FLAGS, stage: 2 },
        };

        // Act
        const result = sut(makeIndex([stagedConflict]), [makeTreeEntry('conflict.txt', OID_A)]);

        // Assert — the non-stage-0 entry is invisible to the changeset; the target tree entry becomes an `add`
        expect(result.entries).toHaveLength(1);
        expect(result.entries[0]?.kind).toBe('add');
      });
    });
  });

  describe('Given symlinks and gitlinks in the target tree', () => {
    describe('When computeChangeset runs', () => {
      it('Then preserves the mode through entries', () => {
        // Arrange
        const sut = computeChangeset;

        // Act
        const result = sut(makeIndex([]), [
          makeTreeEntry('link', OID_A, FILE_MODE.SYMLINK),
          makeTreeEntry('submodule', OID_B, FILE_MODE.GITLINK),
        ]);

        // Assert
        expect(result.entries).toHaveLength(2);
        const link = result.entries.find((e) => e.path === 'link');
        const sub = result.entries.find((e) => e.path === 'submodule');
        expect(link?.mode).toBe(FILE_MODE.SYMLINK);
        expect(sub?.mode).toBe(FILE_MODE.GITLINK);
      });
    });
  });
});
