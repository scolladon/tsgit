import { describe, expect, it } from 'vitest';

import {
  commonDirectoryPrefix,
  presentPaths,
  presentPathsSync,
} from '../../../../src/domain/sparse/missing-directory.js';

const probeOver = (existing: ReadonlyArray<string>) => {
  const calls: string[] = [];
  const probe = async (path: string): Promise<boolean> => {
    calls.push(path);
    return existing.includes(path);
  };
  return { probe, calls };
};

describe('presentPaths', () => {
  const sut = presentPaths;

  describe('Given an absent top-level directory', () => {
    describe('When later siblings sit under it', () => {
      it('Then they are skipped without a probe', async () => {
        // Arrange
        const { probe, calls } = probeOver([]);

        // Act
        const result = await sut(['d/a', 'd/b', 'd/c'], probe);

        // Assert
        expect([...result]).toEqual([]);
        expect(calls).toEqual(['d/a', 'd/']);
      });
    });
  });

  describe('Given a nested absent directory under a present parent', () => {
    describe('When the leaf and its sibling are probed', () => {
      it('Then the missing directory is cached', async () => {
        // Arrange
        const { probe, calls } = probeOver(['a/']);

        // Act
        const result = await sut(['a/b/x', 'a/b/y'], probe);

        // Assert
        expect([...result]).toEqual([]);
        expect(calls).toEqual(['a/b/x', 'a/', 'a/b/']);
      });
    });
  });

  describe('Given a present parent with an absent leaf', () => {
    describe('When the leaf is probed', () => {
      it('Then leaf plus a slash is cached', async () => {
        // Arrange
        const { probe, calls } = probeOver(['a/', 'a/b/']);

        // Act
        const result = await sut(['a/b/leaf', 'a/b/leaf/inner'], probe);

        // Assert
        expect([...result]).toEqual([]);
        expect(calls).toEqual(['a/b/leaf', 'a/', 'a/b/']);
      });
    });
  });

  describe('Given a sibling after a cached miss', () => {
    describe('When it lies outside the cached directory', () => {
      it('Then it is probed again', async () => {
        // Arrange
        const { probe, calls } = probeOver(['a/', 'a/ok']);

        // Act
        const result = await sut(['a/m/x', 'a/ok', 'a/n/y'], probe);

        // Assert
        expect([...result]).toEqual(['a/ok']);
        expect(calls).toEqual(['a/m/x', 'a/', 'a/m/', 'a/ok', 'a/n/y', 'a/n/']);
      });
    });
  });

  describe('Given a path equal to the cached directory minus its slash', () => {
    describe('When it follows the cached miss', () => {
      it('Then it is probed, not skipped', async () => {
        // Arrange
        const { probe, calls } = probeOver(['d']);

        // Act
        const result = await sut(['d/a', 'd'], probe);

        // Assert
        expect([...result]).toEqual(['d']);
        expect(calls).toEqual(['d/a', 'd/', 'd']);
      });
    });
  });

  describe('Given a present path', () => {
    describe('When it follows another present path', () => {
      it('Then the cache is untouched and each is probed once', async () => {
        // Arrange
        const { probe, calls } = probeOver(['a/x', 'a/y']);

        // Act
        const result = await sut(['a/x', 'a/y'], probe);

        // Assert
        expect([...result]).toEqual(['a/x', 'a/y']);
        expect(calls).toEqual(['a/x', 'a/y']);
      });
    });
  });

  describe('Given every parent directory exists but the leaf is absent', () => {
    describe('When the leaf name is later used as a directory prefix', () => {
      it('Then the path plus a slash is the cached directory', async () => {
        // Arrange
        const { probe, calls } = probeOver(['a/']);

        // Act
        const result = await sut(['a/f', 'a/f/z'], probe);

        // Assert
        expect([...result]).toEqual([]);
        expect(calls).toEqual(['a/f', 'a/']);
      });
    });
  });

  describe('Given no paths', () => {
    describe('When probing', () => {
      it('Then nothing is present and nothing is probed', async () => {
        // Arrange
        const { probe, calls } = probeOver([]);

        // Act
        const result = await sut([], probe);

        // Assert
        expect(result.size).toBe(0);
        expect(calls).toEqual([]);
      });
    });
  });
});

describe('presentPaths with a path spelled like a placeholder', () => {
  const sut = presentPaths;

  describe('Given nothing is known missing and the path exists', () => {
    describe('When probing', () => {
      it('Then it is found', async () => {
        // Arrange
        const { probe } = probeOver(['Stryker was here!x']);

        // Act
        const result = await sut(['Stryker was here!x'], probe);

        // Assert
        expect([...result]).toEqual(['Stryker was here!x']);
      });
    });
  });
});

describe('presentPathsSync', () => {
  const sut = presentPathsSync;

  describe('Given no missing directory to resume from and the path exists', () => {
    describe('When probing a path spelled like a placeholder', () => {
      it('Then it is found and the missing directory stays empty', () => {
        // Arrange
        const probe = (path: string): boolean => path === 'Stryker was here!x';

        // Act
        const result = sut(['Stryker was here!x'], probe);

        // Assert
        expect([...result.present]).toEqual(['Stryker was here!x']);
        expect(result.missing).toBe('');
      });
    });
  });
});

describe('commonDirectoryPrefix', () => {
  const sut = commonDirectoryPrefix;

  describe.each([
    ['a/b/c', 'a/b/d', 4],
    ['a/x', 'b/x', 0],
    ['abc', 'abd', 0],
    ['a/b/', 'a/b/c', 4],
    ['', 'a/', 0],
    ['a/', 'a/', 2],
  ])('Given %s and %s', (a, b, expected) => {
    describe('When computing the prefix', () => {
      it(`Then it is ${expected}`, () => {
        // Arrange / Act
        const result = sut(a, b);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });
});
