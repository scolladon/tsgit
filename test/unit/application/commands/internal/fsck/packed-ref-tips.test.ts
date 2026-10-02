import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../../src/adapters/memory/memory-adapter.js';
import {
  assertRefTipsReadable,
  packsWithWrongRevIndex,
} from '../../../../../../src/application/commands/internal/fsck/packed-ref-tips.js';
import { permissionDenied, type TsgitError } from '../../../../../../src/domain/error.js';
import type { Context } from '../../../../../../src/ports/context.js';

const sut = assertRefTipsReadable;

const ABSENT = '1111111111111111111111111111111111111111';
const NO_CACHE = new Map();
const NO_PACKS: ReadonlySet<string> = new Set();

const repoWithTag = async (target: string): Promise<Context> => {
  const ctx = createMemoryContext();
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/tags/t`, `${target}\n`);
  return ctx;
};

describe('Given a ref whose tip no store holds', () => {
  describe('When ref tips are checked', () => {
    it('Then it resolves — the absent tip is an invalid pointer, not a damaged pack entry', async () => {
      // Arrange
      const ctx = await repoWithTag(ABSENT);

      // Act
      const result = sut(ctx, NO_CACHE, NO_PACKS);

      // Assert
      await expect(result).resolves.toBeUndefined();
    });
  });
});

describe('Given a ref whose file cannot be read', () => {
  describe('When ref tips are checked', () => {
    it('Then the read fault propagates', async () => {
      // Arrange
      const ctx = await repoWithTag(ABSENT);
      const refPath = `${ctx.layout.gitDir}/refs/tags/t`;
      const fault = permissionDenied(refPath);
      const guarded: Context = {
        ...ctx,
        fs: {
          ...ctx.fs,
          read: async (path: string) => {
            if (path === refPath) throw fault;
            return ctx.fs.read(path);
          },
          readUtf8: async (path: string) => {
            if (path === refPath) throw fault;
            return ctx.fs.readUtf8(path);
          },
          openWithNoFollow: async (path: string, mode: 'read' | 'write') => {
            if (path === refPath) throw fault;
            return ctx.fs.openWithNoFollow(path, mode);
          },
        },
      };

      // Act
      let caught: unknown;
      try {
        await sut(guarded, NO_CACHE, NO_PACKS);
      } catch (error) {
        caught = error;
      }

      // Assert
      expect((caught as TsgitError).data).toEqual(fault.data);
    });
  });
});

describe('Given rev-index findings of every kind, one from an alternate', () => {
  describe('When the packs with a wrong .rev are collected', () => {
    it('Then only invalid and position-mismatch findings count, keyed by objects dir and pack', () => {
      // Arrange
      const sut = packsWithWrongRevIndex;
      const findings = [
        { type: 'pack-rev-index-invalid', pack: 'pack-a', reason: 'trailer' },
        {
          type: 'pack-rev-index-position-mismatch',
          pack: 'pack-b',
          position: 0,
          expected: 1,
          stored: 0,
          objectsDir: '/donor/objects',
        },
        { type: 'pack-rev-index-unusable', pack: 'pack-c', reason: 'idx' },
      ] as const;

      // Act
      const result = sut(findings);

      // Assert
      expect([...result]).toEqual(['\0pack-a', '/donor/objects\0pack-b']);
    });
  });
});
