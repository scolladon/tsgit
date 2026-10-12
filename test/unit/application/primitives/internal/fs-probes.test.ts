import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import {
  isAbsent,
  lstatIfPresent,
  lstatIfReachable,
  readUtf8IfPresent,
  removeIfPresent,
} from '../../../../../src/application/primitives/internal/fs-probes.js';
import {
  fileNotFound,
  notADirectory,
  permissionDenied,
  type TsgitError,
} from '../../../../../src/domain/error.js';
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

/** Drops the cause-blind probe only — the shape an adapter with `tryLstat` alone has. */
const withoutReachProbe = (fs: FileSystem): FileSystem => {
  const { lstatIfReachable: _lstatIfReachable, ...rest } = fs;
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

describe('lstatIfReachable', () => {
  describe('Given a file system that provides lstatIfReachable', () => {
    describe('When the path is present', () => {
      it('Then it resolves through lstatIfReachable and neither lstat twin is called', async () => {
        // Arrange
        const base = createMemoryContext();
        await base.fs.writeUtf8('/repo/present.txt', 'hi');
        const expected = await base.fs.lstat('/repo/present.txt');
        const fs = withFsOverride(base.fs, { lstat: unreachableTwin, tryLstat: unreachableTwin });
        const sut = lstatIfReachable;

        // Act
        const result = await sut(fs, '/repo/present.txt');

        // Assert
        expect(result).toEqual(expected);
      });
    });
  });

  describe.each([
    { shape: 'with tryLstat only', strip: withoutReachProbe },
    {
      shape: 'without any lstat probe',
      strip: (fs: FileSystem) => withoutProbes(withoutReachProbe(fs)),
    },
  ])('Given a file system $shape', ({ strip }) => {
    describe.each([
      { miss: 'no entry', path: '/repo/absent.txt' },
      { miss: 'a regular file in the path', path: '/repo/file.txt/x' },
    ])('When the path holds $miss', ({ path }) => {
      it('Then it resolves undefined', async () => {
        // Arrange
        const base = createMemoryContext();
        await base.fs.writeUtf8('/repo/file.txt', 'hi');
        const fs = strip(base.fs);
        const sut = lstatIfReachable;

        // Act
        const result = await sut(fs, path);

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe('Given a file system with tryLstat only, whose probe refuses PERMISSION_DENIED', () => {
    describe('When the path is probed', () => {
      it('Then it rethrows the refusal', async () => {
        // Arrange
        const base = createMemoryContext();
        const refusal = permissionDenied('/repo/x');
        const fs = withFsOverride(withoutReachProbe(base.fs), {
          tryLstat: async () => Promise.reject(refusal),
        });
        const sut = lstatIfReachable;

        // Act
        const result = await sut(fs, '/repo/x').catch((error: unknown) => error);

        // Assert
        expect(result).toBe(refusal);
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

describe('isAbsent', () => {
  describe.each([
    { refusal: 'FILE_NOT_FOUND', error: fileNotFound('/repo/x'), expected: true },
    { refusal: 'NOT_A_DIRECTORY', error: notADirectory('/repo/x'), expected: true },
    { refusal: 'PERMISSION_DENIED', error: permissionDenied('/repo/x'), expected: false },
    { refusal: 'no code', error: new Error('boom'), expected: false },
  ])('Given a refusal carrying $refusal', ({ error, expected }) => {
    describe('When classified', () => {
      it(`Then it is ${expected ? 'absent' : 'not absent'}`, () => {
        // Arrange
        const sut = isAbsent;

        // Act
        const result = sut(error);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });
});

describe('removeIfPresent', () => {
  describe('Given a present file', () => {
    describe('When removed', () => {
      it('Then the file is gone', async () => {
        // Arrange
        const { fs } = createMemoryContext();
        await fs.writeUtf8('/repo/present.txt', 'hi');
        const sut = removeIfPresent;

        // Act
        await sut(fs, '/repo/present.txt');

        // Assert
        expect(await fs.exists('/repo/present.txt')).toBe(false);
      });
    });
  });

  describe('Given an absent file', () => {
    describe('When removed', () => {
      it('Then it resolves without a refusal', async () => {
        // Arrange
        const { fs } = createMemoryContext();
        const sut = removeIfPresent;

        // Act
        const result = sut(fs, '/repo/absent.txt');

        // Assert
        await expect(result).resolves.toBeUndefined();
      });
    });
  });

  describe('Given an rm refused for another reason', () => {
    describe('When removed', () => {
      it('Then the refusal propagates', async () => {
        // Arrange
        const base = createMemoryContext();
        const denied = permissionDenied('/repo/locked.txt');
        const fs = withFsOverride(base.fs, { rm: () => Promise.reject(denied) });
        const sut = removeIfPresent;

        // Act
        const result = sut(fs, '/repo/locked.txt');

        // Assert
        await expect(result).rejects.toBe(denied);
      });
    });
  });
});
