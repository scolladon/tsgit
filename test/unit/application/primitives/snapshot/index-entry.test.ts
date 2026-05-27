import { describe, expect, it } from 'vitest';

import { createIndexEntry } from '../../../../../src/application/primitives/snapshot/index-entry.js';
import { writeObject } from '../../../../../src/application/primitives/write-object.js';
import type {
  Blob,
  FileMode,
  FilePath,
  ObjectId,
} from '../../../../../src/domain/objects/index.js';
import type { IndexEntryRow, IndexFlags } from '../../../../../src/domain/snapshot/index.js';
import { buildSeededContext } from '../fixtures.js';

const STAGE0_FLAGS: IndexFlags = {
  assumeUnchanged: false,
  skipWorktree: false,
  intentToAdd: false,
};

describe('createIndexEntry', () => {
  describe('Given an IndexEntryRow with stage=0 and a real blob oid', () => {
    describe('When createIndexEntry wraps it', () => {
      it('Then the entry exposes the row fields unchanged', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const blob: Blob = { type: 'blob', content: new Uint8Array([7, 8]), id: '' as ObjectId };
        const id = await writeObject(ctx, blob);
        const row: IndexEntryRow = {
          source: 'index',
          path: 'src/a.ts' as FilePath,
          oid: id,
          mode: '100644' as FileMode,
          stage: 0,
          flags: STAGE0_FLAGS,
        };

        // Act
        const sut = createIndexEntry(ctx, row);

        // Assert
        expect(sut.source).toBe('index');
        expect(sut.stage).toBe(0);
        expect(sut.flags).toEqual(STAGE0_FLAGS);
        expect(sut.cachedStat).toBeUndefined();
      });

      it('Then read() returns the blob content', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const content = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
        const id = await writeObject(ctx, {
          type: 'blob',
          content,
          id: '' as ObjectId,
        });
        const row: IndexEntryRow = {
          source: 'index',
          path: 'bin.dat' as FilePath,
          oid: id,
          mode: '100644' as FileMode,
          stage: 0,
          flags: STAGE0_FLAGS,
        };
        const sut = createIndexEntry(ctx, row);

        // Act
        const bytes = await sut.read();

        // Assert
        expect(bytes).toEqual(content);
      });
    });
  });

  describe('Given an unmerged index row (stage=2, ours)', () => {
    describe('When createIndexEntry wraps it', () => {
      it('Then stage and flags are preserved verbatim', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const id = await writeObject(ctx, {
          type: 'blob',
          content: new Uint8Array([1]),
          id: '' as ObjectId,
        });
        const row: IndexEntryRow = {
          source: 'index',
          path: 'conflict.txt' as FilePath,
          oid: id,
          mode: '100644' as FileMode,
          stage: 2,
          flags: { ...STAGE0_FLAGS, skipWorktree: true },
        };

        // Act
        const sut = createIndexEntry(ctx, row);

        // Assert
        expect(sut.stage).toBe(2);
        expect(sut.flags.skipWorktree).toBe(true);
      });
    });
  });
});
