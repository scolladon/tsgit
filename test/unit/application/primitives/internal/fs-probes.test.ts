import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import {
  lstatIfPresent,
  readUtf8IfPresent,
} from '../../../../../src/application/primitives/internal/fs-probes.js';
import { notADirectory, type TsgitError } from '../../../../../src/domain/error.js';
import type { FileSystem } from '../../../../../src/ports/file-system.js';

const withFsOverride = (fs: FileSystem, overrides: Partial<FileSystem>): FileSystem => ({
  ...fs,
  ...overrides,
});

/** Drops the two optional probes entirely — the shape an adapter that omits them has. */
const withoutProbes = (fs: FileSystem): FileSystem => {
  const { tryLstat: _tryLstat, tryReadUtf8: _tryReadUtf8, ...rest } = fs;
  return rest;
};

const unreachableTwin = (): never => {
  throw new Error('the throwing twin must not be called when the optional probe is present');
};

describe('lstatIfPresent', () => {
  describe('Given a file system that provides tryLstat', () => {
    describe('When the path is present', () => {
      it('Then it resolves through tryLstat and the throwing lstat twin is not called', async () => {
        // Arrange
        const base = createMemoryContext();
        await base.fs.writeUtf8('/repo/present.txt', 'hi');
        const expected = await base.fs.lstat('/repo/present.txt');
        const fs = withFsOverride(base.fs, { lstat: unreachableTwin });
        const sut = lstatIfPresent;

        // Act
        const result = await sut(fs, '/repo/present.txt');

        // Assert
        expect(result).toEqual(expected);
      });
    });
  });

  describe('Given a file system without tryLstat', () => {
    describe('When the throwing twin refuses FILE_NOT_FOUND', () => {
      it('Then it resolves undefined', async () => {
        // Arrange
        const base = createMemoryContext();
        const fs = withoutProbes(base.fs);
        const sut = lstatIfPresent;

        // Act
        const result = await sut(fs, '/repo/absent.txt');

        // Assert
        expect(result).toBeUndefined();
      });
    });

    describe('When the throwing twin refuses NOT_A_DIRECTORY', () => {
      it('Then it rethrows the refusal', async () => {
        // Arrange
        const base = createMemoryContext();
        const fs = withFsOverride(withoutProbes(base.fs), {
          lstat: async () => {
            throw notADirectory('/repo/blocked.txt');
          },
        });
        const sut = lstatIfPresent;

        // Act & Assert
        let caught: unknown;
        try {
          await sut(fs, '/repo/blocked.txt');
          expect.unreachable();
        } catch (error) {
          caught = error;
        }
        expect((caught as TsgitError).data.code).toBe('NOT_A_DIRECTORY');
      });
    });

    describe('When the throwing twin rejects with a foreign-module-graph FILE_NOT_FOUND shape', () => {
      it('Then it folds to undefined too', async () => {
        // Arrange
        const base = createMemoryContext();
        const foreignError = { data: { code: 'FILE_NOT_FOUND' } };
        const fs = withFsOverride(withoutProbes(base.fs), {
          lstat: async () => {
            throw foreignError;
          },
        });
        const sut = lstatIfPresent;

        // Act
        const result = await sut(fs, '/repo/absent.txt');

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });
});

describe('readUtf8IfPresent', () => {
  describe('Given a file system that provides tryReadUtf8', () => {
    describe('When the path is present', () => {
      it('Then it resolves through tryReadUtf8 and the throwing readUtf8 twin is not called', async () => {
        // Arrange
        const base = createMemoryContext();
        await base.fs.writeUtf8('/repo/present.txt', 'hello');
        const fs = withFsOverride(base.fs, { readUtf8: unreachableTwin });
        const sut = readUtf8IfPresent;

        // Act
        const result = await sut(fs, '/repo/present.txt');

        // Assert
        expect(result).toBe('hello');
      });
    });
  });

  describe('Given a file system without tryReadUtf8', () => {
    describe('When the throwing twin refuses FILE_NOT_FOUND', () => {
      it('Then it resolves undefined', async () => {
        // Arrange
        const base = createMemoryContext();
        const fs = withoutProbes(base.fs);
        const sut = readUtf8IfPresent;

        // Act
        const result = await sut(fs, '/repo/absent.txt');

        // Assert
        expect(result).toBeUndefined();
      });
    });

    describe('When the throwing twin refuses NOT_A_DIRECTORY', () => {
      it('Then it rethrows the refusal', async () => {
        // Arrange
        const base = createMemoryContext();
        const fs = withFsOverride(withoutProbes(base.fs), {
          readUtf8: async () => {
            throw notADirectory('/repo/blocked.txt');
          },
        });
        const sut = readUtf8IfPresent;

        // Act & Assert
        let caught: unknown;
        try {
          await sut(fs, '/repo/blocked.txt');
          expect.unreachable();
        } catch (error) {
          caught = error;
        }
        expect((caught as TsgitError).data.code).toBe('NOT_A_DIRECTORY');
      });
    });

    describe('When the throwing twin rejects with a foreign-module-graph FILE_NOT_FOUND shape', () => {
      it('Then it folds to undefined too', async () => {
        // Arrange
        const base = createMemoryContext();
        const foreignError = { data: { code: 'FILE_NOT_FOUND' } };
        const fs = withFsOverride(withoutProbes(base.fs), {
          readUtf8: async () => {
            throw foreignError;
          },
        });
        const sut = readUtf8IfPresent;

        // Act
        const result = await sut(fs, '/repo/absent.txt');

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });
});
