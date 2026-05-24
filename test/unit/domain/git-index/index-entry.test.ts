import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { IndexEntry, StatData } from '../../../../src/domain/git-index/index-entry.js';
import {
  isStatClean,
  STAGE0_FLAGS,
  skipWorktreeEntry,
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
        const sut = isStatClean(BASE_ENTRY, BASE_STAT);

        // Assert
        expect(sut).toBe(true);
      });
    });
  });

  describe('Given different mtimeSeconds', () => {
    describe('When comparing', () => {
      it('Then returns false', () => {
        // Arrange
        const stat: StatData = { ...BASE_STAT, mtimeSeconds: 9999 };

        // Act
        const sut = isStatClean(BASE_ENTRY, stat);

        // Assert
        expect(sut).toBe(false);
      });
    });
  });

  describe('Given different mtimeNanoseconds', () => {
    describe('When comparing', () => {
      it('Then returns false', () => {
        // Arrange
        const stat: StatData = { ...BASE_STAT, mtimeNanoseconds: 9999 };

        // Act
        const sut = isStatClean(BASE_ENTRY, stat);

        // Assert
        expect(sut).toBe(false);
      });
    });
  });

  describe('Given different ctimeSeconds', () => {
    describe('When comparing', () => {
      it('Then returns false', () => {
        // Arrange
        const stat: StatData = { ...BASE_STAT, ctimeSeconds: 9999 };

        // Act
        const sut = isStatClean(BASE_ENTRY, stat);

        // Assert
        expect(sut).toBe(false);
      });
    });
  });

  describe('Given different ctimeNanoseconds', () => {
    describe('When comparing', () => {
      it('Then returns false', () => {
        // Arrange
        const stat: StatData = { ...BASE_STAT, ctimeNanoseconds: 9999 };

        // Act
        const sut = isStatClean(BASE_ENTRY, stat);

        // Assert
        expect(sut).toBe(false);
      });
    });
  });

  describe('Given different dev', () => {
    describe('When comparing', () => {
      it('Then returns false', () => {
        // Arrange
        const stat: StatData = { ...BASE_STAT, dev: 9999 };

        // Act
        const sut = isStatClean(BASE_ENTRY, stat);

        // Assert
        expect(sut).toBe(false);
      });
    });
  });

  describe('Given different ino', () => {
    describe('When comparing', () => {
      it('Then returns false', () => {
        // Arrange
        const stat: StatData = { ...BASE_STAT, ino: 9999 };

        // Act
        const sut = isStatClean(BASE_ENTRY, stat);

        // Assert
        expect(sut).toBe(false);
      });
    });
  });

  describe('Given different mode', () => {
    describe('When comparing', () => {
      it('Then returns false', () => {
        // Arrange
        const stat: StatData = { ...BASE_STAT, mode: FILE_MODE.EXECUTABLE };

        // Act
        const sut = isStatClean(BASE_ENTRY, stat);

        // Assert
        expect(sut).toBe(false);
      });
    });
  });

  describe('Given different uid', () => {
    describe('When comparing', () => {
      it('Then returns false', () => {
        // Arrange
        const stat: StatData = { ...BASE_STAT, uid: 9999 };

        // Act
        const sut = isStatClean(BASE_ENTRY, stat);

        // Assert
        expect(sut).toBe(false);
      });
    });
  });

  describe('Given different gid', () => {
    describe('When comparing', () => {
      it('Then returns false', () => {
        // Arrange
        const stat: StatData = { ...BASE_STAT, gid: 9999 };

        // Act
        const sut = isStatClean(BASE_ENTRY, stat);

        // Assert
        expect(sut).toBe(false);
      });
    });
  });

  describe('Given different fileSize', () => {
    describe('When comparing', () => {
      it('Then returns false', () => {
        // Arrange
        const stat: StatData = { ...BASE_STAT, fileSize: 9999 };

        // Act
        const sut = isStatClean(BASE_ENTRY, stat);

        // Assert
        expect(sut).toBe(false);
      });
    });
  });

  describe('property-based tests', () => {
    describe('Given any IndexEntry', () => {
      describe('When extracting stat and comparing', () => {
        it('Then isStatClean returns true', () => {
          // Arrange + Assert
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
              expect(isStatClean(entry, stat)).toBe(true);
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

          // Assert
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
              expect(isStatClean(entry, stat)).toBe(false);
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
        const sut = STAGE0_FLAGS;

        // Assert — every field is pinned so a BooleanLiteral or stage mutant
        // flipping any of them is caught.
        expect(sut).toEqual({
          assumeValid: false,
          stage: 0,
          skipWorktree: false,
          intentToAdd: false,
        });
      });
    });
    describe('When reading assumeValid', () => {
      it('Then it is exactly false', () => {
        // Arrange & Act & Assert
        expect(STAGE0_FLAGS.assumeValid).toBe(false);
      });
    });
    describe('When reading stage', () => {
      it('Then it is exactly 0', () => {
        // Arrange & Act & Assert
        expect(STAGE0_FLAGS.stage).toBe(0);
      });
    });
    describe('When reading skipWorktree', () => {
      it('Then it is exactly false', () => {
        // Arrange & Act & Assert
        expect(STAGE0_FLAGS.skipWorktree).toBe(false);
      });
    });
    describe('When reading intentToAdd', () => {
      it('Then it is exactly false', () => {
        // Arrange & Act & Assert
        expect(STAGE0_FLAGS.intentToAdd).toBe(false);
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
        const sut = skipWorktreeEntry(input);

        // Assert
        expect(sut.ctimeSeconds).toBe(0);
        expect(sut.ctimeNanoseconds).toBe(0);
        expect(sut.mtimeSeconds).toBe(0);
        expect(sut.mtimeNanoseconds).toBe(0);
        expect(sut.dev).toBe(0);
        expect(sut.ino).toBe(0);
        expect(sut.uid).toBe(0);
        expect(sut.gid).toBe(0);
        expect(sut.fileSize).toBe(0);
      });
      it('Then id/mode/path are copied verbatim', () => {
        // Arrange — a non-default mode so a `mode:` literal mutant cannot survive.
        const input = {
          path: FilePath.from('scripts/run'),
          id: 'c'.repeat(40) as ObjectId,
          mode: FILE_MODE.EXECUTABLE,
        };

        // Act
        const sut = skipWorktreeEntry(input);

        // Assert
        expect(sut.path).toBe(input.path);
        expect(sut.id).toBe(input.id);
        expect(sut.mode).toBe(FILE_MODE.EXECUTABLE);
      });
      it('Then flags are stage-0 with skipWorktree set', () => {
        // Arrange
        const input = {
          path: FilePath.from('docs/readme.md'),
          id: 'd'.repeat(40) as ObjectId,
          mode: FILE_MODE.REGULAR,
        };

        // Act
        const sut = skipWorktreeEntry(input);

        // Assert — skipWorktree true, every other flag the stage-0 default.
        expect(sut.flags).toEqual({
          assumeValid: false,
          stage: 0,
          skipWorktree: true,
          intentToAdd: false,
        });
      });
    });
  });
});
