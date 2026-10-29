import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../../src/adapters/memory/memory-adapter.js';
import { runPackHealthPass } from '../../../../../../src/application/commands/internal/fsck/pack-health.js';
import type { Context } from '../../../../../../src/ports/context.js';
import {
  restampPackHeader,
  writeSyntheticPack,
  writeSyntheticPackIn,
} from '../../../primitives/pack-fixture.js';

const sut = runPackHealthPass;

const enc = new TextEncoder();
const DONOR_OBJECTS = '/repo/donor/objects';

const onePackEntry = (content: string) => [
  { kind: 'base' as const, type: 'blob' as const, content: enc.encode(content) },
];

const borrowerContext = async (): Promise<Context> => {
  const ctx = createMemoryContext({
    files: { '/repo/.git/objects/info/alternates': enc.encode(`${DONOR_OBJECTS}\n`) },
  });
  await ctx.fs.mkdir(DONOR_OBJECTS);
  return ctx;
};

describe('Given a pack whose .idx is corrupt', () => {
  describe('When the pack health pass runs under connectivityOnly', () => {
    it('Then no pack-rev-index-unusable finding is emitted and the bit stays clear', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await writeSyntheticPack(ctx, 'gate-conn', onePackEntry('gate-conn'));
      await ctx.fs.write(
        `${ctx.layout.gitDir}/objects/pack/pack-gate-conn.idx`,
        new Uint8Array(1072),
      );

      // Act
      const result = await sut(ctx, { connectivityOnly: true });

      // Assert
      expect(result).toEqual({ findings: [], exitBit: 0 });
    });
  });

  describe('When the pack health pass runs with full: false', () => {
    it('Then the local pack-rev-index-unusable finding is kept with bit 1', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await writeSyntheticPack(ctx, 'gate-local', onePackEntry('gate-local'));
      await ctx.fs.write(
        `${ctx.layout.gitDir}/objects/pack/pack-gate-local.idx`,
        new Uint8Array(1072),
      );

      // Act
      const result = await sut(ctx, { full: false });

      // Assert
      expect(result.findings.map((f) => f.type)).toEqual(['pack-rev-index-unusable']);
      expect(result.exitBit).toBe(1);
    });
  });
});

describe('Given a v99-header pack', () => {
  describe('When the pack health pass runs in default mode', () => {
    it('Then the pack-inaccessible finding sets the generic corruption bit', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await writeSyntheticPack(ctx, 'refused', onePackEntry('refused'));
      await restampPackHeader(ctx, `${ctx.layout.gitDir}/objects/pack/pack-refused.pack`, {
        version: 99,
      });

      // Act
      const result = await sut(ctx, {});

      // Assert
      expect(result.findings.map((f) => f.type)).toEqual(['pack-inaccessible']);
      expect(result.exitBit).toBe(1);
    });
  });
});

describe('Given a donor pack whose .idx is corrupt', () => {
  describe('When the pack health pass runs with full: false', () => {
    it('Then the donor is skipped and nothing is reported', async () => {
      // Arrange
      const ctx = await borrowerContext();
      await writeSyntheticPackIn(ctx, DONOR_OBJECTS, 'donor-idx', onePackEntry('donor-idx'));
      await ctx.fs.write(`${DONOR_OBJECTS}/pack/pack-donor-idx.idx`, new Uint8Array(1072));

      // Act
      const result = await sut(ctx, { full: false });

      // Assert
      expect(result).toEqual({ findings: [], exitBit: 0 });
    });
  });
});
