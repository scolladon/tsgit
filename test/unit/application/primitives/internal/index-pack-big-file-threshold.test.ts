/**
 * A malformed `core.bigFileThreshold` (last entry wins) while indexing a
 * received pack: git's index-pack and unpack-objects read it on the first
 * non-delta blob entry they inflate, never for a pack of commits and trees
 * alone — and `bundle verify`, which never indexes, never reads it.
 */
import { describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { invalidateConfigCache } from '../../../../../src/application/primitives/config-read.js';
import {
  indexQuarantinedPack,
  walkPackEntries,
} from '../../../../../src/application/primitives/internal/index-pack.js';
import * as repoSettingsGate from '../../../../../src/application/primitives/internal/repo-settings-gate.js';
import type { Context } from '../../../../../src/ports/context.js';
import { buildSyntheticPack, type EntrySpec } from '../pack-fixture.js';

vi.mock(
  '../../../../../src/application/primitives/internal/repo-settings-gate.js',
  async (importOriginal) => {
    const actual = await importOriginal<typeof repoSettingsGate>();
    return { ...actual, assertBigFileThresholdValid: vi.fn(actual.assertBigFileThresholdValid) };
  },
);

const ENCODER = new TextEncoder();
const REFUSAL = { code: 'CONFIG_BAD_NUMERIC_VALUE', key: 'core.bigfilethreshold', value: 'x' };
const EMPTY_TREE: EntrySpec = { kind: 'base', type: 'tree', content: new Uint8Array() };
const BLOB: EntrySpec = { kind: 'base', type: 'blob', content: ENCODER.encode('content\n') };

const malformedRepo = async (): Promise<Context> => {
  const ctx = createMemoryContext();
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[core]\n\tbigFileThreshold = x\n');
  invalidateConfigCache(ctx);
  return ctx;
};

const quarantined = async (
  ctx: Context,
  entries: ReadonlyArray<EntrySpec>,
): Promise<{ readonly tmpPath: string; readonly totalBytes: number }> => {
  const { packBytes } = await buildSyntheticPack(ctx, [...entries]);
  const tmpPath = `${ctx.layout.gitDir}/objects/pack/tmp_pack_threshold`;
  await ctx.fs.write(tmpPath, packBytes);
  return { tmpPath, totalBytes: packBytes.length };
};

describe('Given a malformed core.bigFileThreshold and a received pack holding a blob', () => {
  describe('When indexing the quarantined pack', () => {
    it('Then it refuses with the key and cleans the quarantine up', async () => {
      // Arrange
      const ctx = await malformedRepo();
      const { tmpPath, totalBytes } = await quarantined(ctx, [EMPTY_TREE, BLOB]);
      const cleaned: string[] = [];
      const sut = indexQuarantinedPack;

      // Act
      const result = await sut(ctx, tmpPath, totalBytes, async (path) => {
        cleaned.push(path);
      }).then(
        () => undefined,
        (err: { data: unknown }) => err.data,
      );

      // Assert
      expect(result).toMatchObject(REFUSAL);
      expect(cleaned).toEqual([tmpPath]);
    });
  });
});

describe('Given a malformed core.bigFileThreshold and a received pack without a blob', () => {
  describe('When indexing the quarantined pack', () => {
    it('Then it indexes without reading the threshold', async () => {
      // Arrange
      const ctx = await malformedRepo();
      const { tmpPath, totalBytes } = await quarantined(ctx, [EMPTY_TREE]);
      const sut = indexQuarantinedPack;

      // Act
      const result = await sut(ctx, tmpPath, totalBytes, async () => undefined);

      // Assert
      expect(result.count).toBe(1);
    });
  });
});

describe('Given a malformed core.bigFileThreshold and a bundled pack holding a blob', () => {
  describe('When walking the pack entries', () => {
    it('Then it walks without reading the threshold', async () => {
      // Arrange
      const ctx = await malformedRepo();
      const { packBytes } = await buildSyntheticPack(ctx, [BLOB]);
      const sut = walkPackEntries;

      // Act
      const result = await sut(ctx, packBytes);

      // Assert
      expect(result).toHaveLength(1);
    });
  });
});

describe('Given a well-formed configuration and a received pack holding two blobs', () => {
  describe('When indexing the quarantined pack', () => {
    it('Then it reads the threshold once', async () => {
      // Arrange
      const ctx = createMemoryContext();
      const second: EntrySpec = { kind: 'base', type: 'blob', content: ENCODER.encode('other\n') };
      const { tmpPath, totalBytes } = await quarantined(ctx, [BLOB, second]);
      const thresholdReads = vi.mocked(repoSettingsGate.assertBigFileThresholdValid);
      thresholdReads.mockClear();
      const sut = indexQuarantinedPack;

      // Act
      await sut(ctx, tmpPath, totalBytes, async () => undefined);

      // Assert
      expect(thresholdReads).toHaveBeenCalledTimes(1);
    });
  });
});
