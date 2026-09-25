/**
 * Wiring coverage for `createNodeContext`'s own sync-I/O forwarding
 * (`node-adapter.ts`): proves the resolved `SyncIoPolicy` actually reaches
 * the constructed `NodeFileSystem` — kills the ObjectLiteral mutant that
 * would swap `{ syncIo }` for `{}` and silently disable the sync fast path
 * for every default-`io` context.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const NodeFileSystemSpy = vi.fn();

vi.mock('../../../../src/adapters/node/node-file-system.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../../src/adapters/node/node-file-system.js')>();
  class SpiedNodeFileSystem extends actual.NodeFileSystem {
    constructor(...args: ConstructorParameters<typeof actual.NodeFileSystem>) {
      super(...args);
      NodeFileSystemSpy(...args);
    }
  }
  return { ...actual, NodeFileSystem: SpiedNodeFileSystem };
});

const { createNodeContext } = await import('../../../../src/adapters/node/node-adapter.js');

const capturedOptions = (): { syncIo?: unknown } =>
  NodeFileSystemSpy.mock.calls.at(-1)?.[1] as { syncIo?: unknown };

afterEach(() => {
  NodeFileSystemSpy.mockClear();
});

describe('Given default io options', () => {
  describe('When creating a node context', () => {
    it('Then NodeFileSystem receives a syncIo policy', () => {
      // Arrange
      const sut = createNodeContext;

      // Act
      sut({ workDir: '/tmp/tsgit-adapter-sync-io-default' });

      // Assert — a syncIo-less options object here is exactly what the
      // `{ syncIo } → {}` ObjectLiteral mutant would produce.
      expect(NodeFileSystemSpy).toHaveBeenCalledTimes(1);
      expect(capturedOptions().syncIo).toBeDefined();
    });
  });
});

describe("Given io: 'sync-fast-path'", () => {
  describe('When creating a node context', () => {
    it('Then NodeFileSystem receives a syncIo policy', () => {
      // Arrange
      const sut = createNodeContext;

      // Act
      sut({ workDir: '/tmp/tsgit-adapter-sync-io-explicit', io: 'sync-fast-path' });

      // Assert
      expect(NodeFileSystemSpy).toHaveBeenCalledTimes(1);
      expect(capturedOptions().syncIo).toBeDefined();
    });
  });
});

describe("Given io: 'threadpool'", () => {
  describe('When creating a node context', () => {
    it('Then NodeFileSystem receives no syncIo policy', () => {
      // Arrange
      const sut = createNodeContext;

      // Act
      sut({ workDir: '/tmp/tsgit-adapter-sync-io-threadpool', io: 'threadpool' });

      // Assert
      expect(NodeFileSystemSpy).toHaveBeenCalledTimes(1);
      expect(capturedOptions().syncIo).toBeUndefined();
    });
  });
});
