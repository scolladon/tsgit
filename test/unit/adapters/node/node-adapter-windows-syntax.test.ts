import { describe, expect, it, vi } from 'vitest';
import { createNodeContext } from '../../../../src/adapters/node/node-adapter.js';
import { gitPathSyntaxOf } from '../../../../src/application/primitives/internal/git-path-syntax.js';

vi.mock('../../../../src/adapters/node/path-policy.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../../src/adapters/node/path-policy.js')>();
  return { ...actual, nativePolicy: actual.windowsPolicy };
});

describe('createNodeContext', () => {
  describe('Given a host whose native path policy reads Windows syntax', () => {
    describe('When the context is built', () => {
      it('Then a drive-letter alternate path reads as absolute', () => {
        // Arrange
        const sut = createNodeContext;

        // Act
        const result = sut({ workDir: '/tmp/tsgit-ctx-test' });

        // Assert
        expect(result.windowsPathSyntax).toBe(true);
        expect(gitPathSyntaxOf(result).isAbsolute('C:\\x\\objects')).toBe(true);
      });
    });

    describe('When two alternate paths on one drive are probed', () => {
      it('Then the drive root probe is built once', () => {
        // Arrange
        const ctx = createNodeContext({ workDir: '/tmp/tsgit-ctx-test' });
        const sut = ctx.alternatePathProbe;

        // Act
        const first = sut?.('C:\\x\\objects');
        const result = sut?.('C:\\y\\objects');

        // Assert
        expect(result).toBeDefined();
        expect(result).toBe(first);
      });
    });

    describe('When alternate paths on two drives are probed', () => {
      it('Then each drive gets its own root probe', () => {
        // Arrange
        const ctx = createNodeContext({ workDir: '/tmp/tsgit-ctx-test' });
        const sut = ctx.alternatePathProbe;

        // Act
        const first = sut?.('C:\\x\\objects');
        const result = sut?.('D:\\x\\objects');

        // Assert
        expect(result).toBeDefined();
        expect(result).not.toBe(first);
      });
    });
  });
});
