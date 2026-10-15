import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { IndexEntry, StatData } from '../../../../src/domain/git-index/index-entry.js';
import {
  isStatClean,
  STAGE0_FLAGS,
  skipWorktreeEntry,
  withPath,
} from '../../../../src/domain/git-index/index-entry.js';
import type { ObjectId } from '../../../../src/domain/objects/index.js';
import { FILE_MODE, FilePath } from '../../../../src/domain/objects/index.js';
import { arbIndexEntry } from './arbitraries.js';

const BASE_ENTRY: IndexEntry = {
  ctimeSeconds: 1000,
  ctimeNanoseconds: 500,
  mtimeSeconds: 2000,
  mtimeNanoseconds: 600,
  dev: 10,
  ino: 20,
  mode: FILE_MODE.REGULAR,
  uid: 100,
  gid: 200,
  fileSize: 4096,
  id: 'a'.repeat(40) as ObjectId,
  flags: STAGE0_FLAGS,
  path: FilePath.from('file.txt'),
};

const BASE_STAT: StatData = {
  ctimeSeconds: 1000,
  ctimeNanoseconds: 500,
  mtimeSeconds: 2000,
  mtimeNanoseconds: 600,
  dev: 10,
  ino: 20,
  mode: FILE_MODE.REGULAR,
  uid: 100,
  gid: 200,
  fileSize: 4096,
};

describe('isStatClean', () => {
  describe('Given identical IndexEntry and StatData', () => {
    describe('When comparing', () => {
      it('Then returns true', () => {
        // Arrange & Act
        const result = isStatClean(BASE_ENTRY, BASE_STAT);

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given a StatData that differs from the IndexEntry in one field', () => {
    describe('When comparing', () => {
      it.each([
        { label: 'mtimeSeconds', overrides: { mtimeSeconds: 9999 } },
        { label: 'mtimeNanoseconds', overrides: { mtimeNanoseconds: 9999 } },
        { label: 'ctimeSeconds', overrides: { ctimeSeconds: 9999 } },
        { label: 'ctimeNanoseconds', overrides: { ctimeNanoseconds: 9999 } },
        { label: 'dev', overrides: { dev: 9999 } },
        { label: 'ino', overrides: { ino: 9999 } },
        { label: 'mode', overrides: { mode: FILE_MODE.EXECUTABLE } },
        { label: 'uid', overrides: { uid: 9999 } },
        { label: 'gid', overrides: { gid: 9999 } },
        { label: 'fileSize', overrides: { fileSize: 9999 } },
      ] satisfies ReadonlyArray<{ label: string; overrides: Partial<StatData> }>)(
        'Then returns false ($label differs)',
        ({ overrides }) => {
          // Arrange
          const stat: StatData = { ...BASE_STAT, ...overrides };

          // Act
          const result = isStatClean(BASE_ENTRY, stat);

          // Assert
          expect(result).toBe(false);
        },
      );
    });
  });

  describe('property-based tests', () => {
    describe('Given any IndexEntry', () => {
      describe('When extracting stat and comparing', () => {
        it('Then isStatClean returns true', () => {
          // Arrange
          fc.assert(
            fc.property(arbIndexEntry(), (entry) => {
              const stat: StatData = {
                ctimeSeconds: entry.ctimeSeconds,
                ctimeNanoseconds: entry.ctimeNanoseconds,
                mtimeSeconds: entry.mtimeSeconds,
                mtimeNanoseconds: entry.mtimeNanoseconds,
                dev: entry.dev,
                ino: entry.ino,
                mode: entry.mode,
                uid: entry.uid,
                gid: entry.gid,
                fileSize: entry.fileSize,
              };

              // Act
              const result = isStatClean(entry, stat);

              // Assert
              expect(result).toBe(true);
            }),
          );
        });
      });
    });

    describe('Given any IndexEntry with one numeric field mutated', () => {
      describe('When comparing', () => {
        it('Then isStatClean returns false', () => {
          // Arrange
          const numericFields = [
            'ctimeSeconds',
            'ctimeNanoseconds',
            'mtimeSeconds',
            'mtimeNanoseconds',
            'dev',
            'ino',
            'uid',
            'gid',
            'fileSize',
          ] as const;

          // Act & Assert
          fc.assert(
            fc.property(arbIndexEntry(), fc.constantFrom(...numericFields), (entry, field) => {
              const stat: StatData = {
                ctimeSeconds: entry.ctimeSeconds,
                ctimeNanoseconds: entry.ctimeNanoseconds,
                mtimeSeconds: entry.mtimeSeconds,
                mtimeNanoseconds: entry.mtimeNanoseconds,
                dev: entry.dev,
                ino: entry.ino,
                mode: entry.mode,
                uid: entry.uid,
                gid: entry.gid,
                fileSize: entry.fileSize,
                [field]: entry[field] + 1,
              };

              // Act
              const result = isStatClean(entry, stat);

              // Assert
              expect(result).toBe(false);
            }),
          );
        });
      });
    });
  });
});

describe('STAGE0_FLAGS', () => {
  describe('Given the STAGE0_FLAGS constant', () => {
    describe('When inspecting its shape', () => {
      it('Then it is the default stage-0 flag record', () => {
        // Arrange & Act
        const result = STAGE0_FLAGS;

        // Assert — every field is pinned so a BooleanLiteral or stage mutant
        // flipping any of them is caught.
        expect(result).toEqual({
          assumeValid: false,
          stage: 0,
          skipWorktree: false,
          intentToAdd: false,
        });
      });
    });
    describe('When reading a flag field', () => {
      it.each([
        { field: 'assumeValid', expected: false },
        { field: 'stage', expected: 0 },
        { field: 'skipWorktree', expected: false },
        { field: 'intentToAdd', expected: false },
      ] as const)('Then $field is exactly $expected', ({ field, expected }) => {
        // Arrange & Act & Assert
        expect(STAGE0_FLAGS[field]).toBe(expected);
      });
    });
  });
});

describe('skipWorktreeEntry', () => {
  describe('Given a tree path', () => {
    describe('When skipWorktreeEntry', () => {
      it('Then every stat field is zero', () => {
        // Arrange
        const input = {
          path: FilePath.from('vendor/lib.js'),
          id: 'b'.repeat(40) as ObjectId,
          mode: FILE_MODE.REGULAR,
        };

        // Act
        const result = skipWorktreeEntry(input);

        // Assert
        expect(result.ctimeSeconds).toBe(0);
        expect(result.ctimeNanoseconds).toBe(0);
        expect(result.mtimeSeconds).toBe(0);
        expect(result.mtimeNanoseconds).toBe(0);
        expect(result.dev).toBe(0);
        expect(result.ino).toBe(0);
        expect(result.uid).toBe(0);
        expect(result.gid).toBe(0);
        expect(result.fileSize).toBe(0);
      });
      it('Then id/mode/path are copied verbatim', () => {
        // Arrange — a non-default mode so a `mode:` literal mutant cannot survive.
        const input = {
          path: FilePath.from('scripts/run'),
          id: 'c'.repeat(40) as ObjectId,
          mode: FILE_MODE.EXECUTABLE,
        };

        // Act
        const result = skipWorktreeEntry(input);

        // Assert
        expect(result.path).toBe(input.path);
        expect(result.id).toBe(input.id);
        expect(result.mode).toBe(FILE_MODE.EXECUTABLE);
      });
      it('Then flags are stage-0 with skipWorktree set', () => {
        // Arrange
        const input = {
          path: FilePath.from('docs/readme.md'),
          id: 'd'.repeat(40) as ObjectId,
          mode: FILE_MODE.REGULAR,
        };

        // Act
        const result = skipWorktreeEntry(input);

        // Assert — skipWorktree true, every other flag the stage-0 default.
        expect(result.flags).toEqual({
          assumeValid: false,
          stage: 0,
          skipWorktree: true,
          intentToAdd: false,
        });
      });
    });
  });
});

const LOSSY_BYTES = Uint8Array.of(0xff, 0x2e, 0x74, 0x78, 0x74);
const LOSSY_ENTRY: IndexEntry = {
  ...BASE_ENTRY,
  mode: FILE_MODE.EXECUTABLE,
  flags: { ...STAGE0_FLAGS, skipWorktree: true },
  path: FilePath.from('\uFFFD.txt'),
  pathBytes: LOSSY_BYTES,
};

describe('withPath', () => {
  describe('Given a lossy entry', () => {
    describe('When moved to a UTF-8 path', () => {
      it('Then the result has no pathBytes key and keeps every other field', () => {
        // Arrange
        const to = { path: FilePath.from('e/x') };

        // Act
        const result = withPath(LOSSY_ENTRY, to);

        // Assert
        const { pathBytes: _dropped, ...expected } = LOSSY_ENTRY;
        expect(result).toEqual({ ...expected, path: 'e/x' });
        expect('pathBytes' in result).toBe(false);
      });
    });
  });

  describe('Given a UTF-8 entry', () => {
    describe('When moved to a lossy path', () => {
      it('Then the result carries the destination bytes', () => {
        // Arrange
        const to = { path: LOSSY_ENTRY.path, pathBytes: LOSSY_BYTES };

        // Act
        const result = withPath(BASE_ENTRY, to);

        // Assert
        expect(result).toEqual({ ...BASE_ENTRY, path: LOSSY_ENTRY.path, pathBytes: LOSSY_BYTES });
      });
    });
  });
});

describe('skipWorktreeEntry with raw path bytes', () => {
  describe('Given a tree path carrying raw bytes', () => {
    describe('When skipWorktreeEntry', () => {
      it('Then the bytes are kept', () => {
        // Arrange
        const input = {
          path: LOSSY_ENTRY.path,
          pathBytes: LOSSY_BYTES,
          id: 'b'.repeat(40) as ObjectId,
          mode: FILE_MODE.REGULAR,
        };

        // Act
        const result = skipWorktreeEntry(input);

        // Assert
        expect(result.pathBytes).toEqual(LOSSY_BYTES);
      });
    });
  });

  describe('Given a tree path without raw bytes', () => {
    describe('When skipWorktreeEntry', () => {
      it('Then the pathBytes key is absent', () => {
        // Arrange
        const input = {
          path: FilePath.from('a'),
          id: 'b'.repeat(40) as ObjectId,
          mode: FILE_MODE.REGULAR,
        };

        // Act
        const result = skipWorktreeEntry(input);

        // Assert
        expect('pathBytes' in result).toBe(false);
      });
    });
  });
});
