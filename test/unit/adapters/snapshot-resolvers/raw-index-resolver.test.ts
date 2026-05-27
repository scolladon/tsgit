import { describe, expect, it } from 'vitest';

import { createRawIndexResolver } from '../../../../src/adapters/snapshot-resolvers/raw-index-resolver.js';
import type { GitIndex, IndexEntry } from '../../../../src/domain/git-index/index-entry.js';
import { STAGE0_FLAGS } from '../../../../src/domain/git-index/index-entry.js';
import { FILE_MODE, FilePath, type ObjectId } from '../../../../src/domain/objects/index.js';
import { buildSeededContext } from '../../application/primitives/fixtures.js';

const ZERO_OID = '0000000000000000000000000000000000000001' as ObjectId;

const sampleEntry = (path: string): IndexEntry => ({
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

const sampleIndex = (entries: ReadonlyArray<IndexEntry>): GitIndex => ({
  version: 2,
  entries,
  extensions: [],
  trailerSha: new Uint8Array(0),
});

describe('createRawIndexResolver', () => {
  describe('Given a repository whose .git/index contains a one-entry index', () => {
    describe('When resolve(ctx) is called', () => {
      it('Then it returns a GitIndex with that entry round-tripped intact', async () => {
        // Arrange
        const ctx = await buildSeededContext({
          index: sampleIndex([sampleEntry('a.txt')]),
        });
        const sut = createRawIndexResolver();

        // Act
        const result = await sut.resolve(ctx);

        // Assert
        expect(result.version).toBe(2);
        expect(result.entries).toHaveLength(1);
        expect(result.entries[0]?.path).toBe('a.txt');
        expect(result.entries[0]?.id).toBe(ZERO_OID);
      });

      it('Then the returned GitIndex carries a non-empty trailerSha (20 bytes)', async () => {
        // Arrange
        const ctx = await buildSeededContext({
          index: sampleIndex([sampleEntry('b.txt')]),
        });
        const sut = createRawIndexResolver();

        // Act
        const result = await sut.resolve(ctx);

        // Assert
        expect(result.trailerSha).toBeInstanceOf(Uint8Array);
        expect(result.trailerSha.length).toBe(20);
      });
    });
  });

  describe('Given a repository with no .git/index file', () => {
    describe('When resolve(ctx) is called', () => {
      it('Then it returns an empty GitIndex (entries=[])', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const sut = createRawIndexResolver();

        // Act
        const result = await sut.resolve(ctx);

        // Assert
        expect(result.entries).toEqual([]);
        expect(result.extensions).toEqual([]);
      });
    });
  });

  describe('Given the same .git/index parsed twice', () => {
    describe('When bypassCache is true on the second call', () => {
      it('Then the result is structurally identical (raw resolver ignores options)', async () => {
        // Arrange
        const ctx = await buildSeededContext({
          index: sampleIndex([sampleEntry('x.ts'), sampleEntry('y.ts')]),
        });
        const sut = createRawIndexResolver();

        // Act
        const first = await sut.resolve(ctx);
        const second = await sut.resolve(ctx, { bypassCache: true });

        // Assert
        expect(second.entries.map((e) => e.path)).toEqual(first.entries.map((e) => e.path));
        expect(second.trailerSha).toEqual(first.trailerSha);
      });
    });
  });
});
