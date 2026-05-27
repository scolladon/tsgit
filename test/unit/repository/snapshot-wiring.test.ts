import { describe, expect, it } from 'vitest';

import {
  MemoryCompressor,
  MemoryFileSystem,
  MemoryHashService,
  MemoryHttpTransport,
} from '../../../src/adapters/memory/index.js';
import { SHA1_CONFIG } from '../../../src/domain/objects/hash-config.js';
import { createLruCache } from '../../../src/domain/storage/lru-cache.js';
import { openRepository, type RuntimeFallback } from '../../../src/repository.js';

const makeFallback = (): RuntimeFallback => ({
  fs: new MemoryFileSystem({ rootDir: '/repo' }),
  hash: new MemoryHashService('sha1'),
  compressor: new MemoryCompressor(),
  transport: new MemoryHttpTransport(),
  runtime: 'memory',
  layout: { workDir: '/repo', gitDir: '/repo/.git', bare: false },
  hashConfig: SHA1_CONFIG,
  deltaCache: createLruCache<Uint8Array>(1024),
});

const open = () => openRepository({ cwd: '/repo' }, makeFallback());

const collect = async <T>(it: AsyncIterable<T>): Promise<T[]> => {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
};

describe('repository.snapshot wiring', () => {
  describe('Given an opened repository', () => {
    describe('When repo.snapshot is accessed', () => {
      it('Then it exposes every SnapshotFactory method', async () => {
        // Arrange
        const sut = await open();

        // Act + Assert
        try {
          expect(typeof sut.snapshot.head).toBe('function');
          expect(typeof sut.snapshot.commit).toBe('function');
          expect(typeof sut.snapshot.tree).toBe('function');
          expect(typeof sut.snapshot.index).toBe('function');
          expect(typeof sut.snapshot.workdir).toBe('function');
          expect(typeof sut.snapshot.mergeHead).toBe('function');
          expect(typeof sut.snapshot.cherryPickHead).toBe('function');
          expect(typeof sut.snapshot.revertHead).toBe('function');
          expect(typeof sut.snapshot.fetchHead).toBe('function');
          expect(typeof sut.snapshot.stashEntry).toBe('function');
        } finally {
          await sut.dispose();
        }
      });
    });

    describe('When repo.snapshot.index() is iterated on a fresh repo', () => {
      it('Then it yields no rows (empty index)', async () => {
        // Arrange
        const sut = await open();

        // Act
        try {
          const rows = await collect(sut.snapshot.index().entries());

          // Assert
          expect(rows).toEqual([]);
        } finally {
          await sut.dispose();
        }
      });
    });

    describe('When repo.snapshot.mergeHead() is awaited on a repo with no merge in progress', () => {
      it('Then it resolves to null', async () => {
        // Arrange
        const sut = await open();

        // Act
        try {
          const result = await sut.snapshot.mergeHead();

          // Assert
          expect(result).toBeNull();
        } finally {
          await sut.dispose();
        }
      });
    });
  });
});
