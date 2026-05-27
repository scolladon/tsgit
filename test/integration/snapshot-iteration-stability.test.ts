/**
 * Snapshot iteration-stability invariant (design §8.0): once an
 * IndexSnapshot's `.entries()` has been entered, mutations to the
 * underlying index file do not disturb the in-flight iteration. A
 * fresh snapshot opened after the mutation sees post-mutation rows.
 *
 * @proves
 *   surface:        snapshot
 *   bucket:         coverage-gap
 *   unique:         iteration-stability across in-flight mutation
 */
import { describe, expect, it } from 'vitest';

import {
  MemoryCompressor,
  MemoryFileSystem,
  MemoryHashService,
  MemoryHttpTransport,
} from '../../src/adapters/memory/index.js';
import type {
  IndexEntry as DomainIndexEntry,
  GitIndex,
} from '../../src/domain/git-index/index-entry.js';
import { STAGE0_FLAGS } from '../../src/domain/git-index/index-entry.js';
import { SHA1_CONFIG } from '../../src/domain/objects/hash-config.js';
import { FILE_MODE, FilePath, type ObjectId } from '../../src/domain/objects/index.js';
import { createLruCache } from '../../src/domain/storage/lru-cache.js';
import { openRepository, type Repository, type RuntimeFallback } from '../../src/repository.js';

const ZERO_OID = '0000000000000000000000000000000000000001' as ObjectId;

const entry = (path: string): DomainIndexEntry => ({
  ctimeSeconds: 0,
  ctimeNanoseconds: 0,
  mtimeSeconds: 0,
  mtimeNanoseconds: 0,
  dev: 0,
  ino: 0,
  mode: FILE_MODE.REGULAR,
  uid: 0,
  gid: 0,
  fileSize: 0,
  id: ZERO_OID,
  flags: STAGE0_FLAGS,
  path: FilePath.from(path),
});

const writeIndexFile = async (repo: Repository, index: GitIndex): Promise<void> => {
  const { serializeIndex } = await import('../../src/domain/git-index/index-writer.js');
  const body = serializeIndex(index);
  const hashHex = await repo.ctx.hash.hashHex(body);
  const trailer = new Uint8Array(20);
  for (let i = 0; i < 20; i += 1) trailer[i] = Number.parseInt(hashHex.slice(i * 2, i * 2 + 2), 16);
  const buffer = new Uint8Array(body.length + 20);
  buffer.set(body, 0);
  buffer.set(trailer, body.length);
  await repo.ctx.fs.write(`${repo.ctx.layout.gitDir}/index`, buffer);
};

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

describe('Given a repository whose .git/index has 3 entries', () => {
  describe('When an IndexSnapshot iteration is started and the index file is rewritten mid-loop', () => {
    it('Then the in-flight iteration continues yielding pre-mutation rows', async () => {
      // Arrange
      const repo = await openRepository({ cwd: '/repo' }, makeFallback());
      try {
        await writeIndexFile(repo, {
          version: 2,
          entries: [entry('a.txt'), entry('b.txt'), entry('c.txt')],
          extensions: [],
          trailerSha: new Uint8Array(0),
        });
        const snapshot = repo.snapshot.index();

        // Act
        const iter = snapshot.entries()[Symbol.asyncIterator]();
        const first = await iter.next();
        await writeIndexFile(repo, {
          version: 2,
          entries: [entry('zzz.txt')],
          extensions: [],
          trailerSha: new Uint8Array(0),
        });
        const second = await iter.next();
        const third = await iter.next();
        const end = await iter.next();

        // Assert
        expect(first.value?.path).toBe('a.txt');
        expect(second.value?.path).toBe('b.txt');
        expect(third.value?.path).toBe('c.txt');
        expect(end.done).toBe(true);
      } finally {
        await repo.dispose();
      }
    });
  });

  describe('When a fresh snapshot uses bypassCache after an external write', () => {
    it('Then it yields the post-mutation rows (bypassCache forces re-parse)', async () => {
      // Arrange — design §10.4 + ADR-150: external writes (no emit) are caught
      // lazily on the next generation bump or via bypassCache=true.
      const repo = await openRepository({ cwd: '/repo' }, makeFallback());
      try {
        await writeIndexFile(repo, {
          version: 2,
          entries: [entry('a.txt'), entry('b.txt')],
          extensions: [],
          trailerSha: new Uint8Array(0),
        });
        const first = repo.snapshot.index();
        const firstRows: string[] = [];
        for await (const e of first.entries()) firstRows.push(e.path);

        // Act — external write replaces the index; new snapshot iterated
        // with bypassCache forces a fresh resolve.
        await writeIndexFile(repo, {
          version: 2,
          entries: [entry('z.txt')],
          extensions: [],
          trailerSha: new Uint8Array(0),
        });
        const second = repo.snapshot.index();
        const secondRows: string[] = [];
        for await (const e of second.entries({ bypassCache: true })) secondRows.push(e.path);

        // Assert
        expect(firstRows).toEqual(['a.txt', 'b.txt']);
        expect(secondRows).toEqual(['z.txt']);
      } finally {
        await repo.dispose();
      }
    });
  });
});
