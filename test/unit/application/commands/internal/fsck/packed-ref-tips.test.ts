import { describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../../../src/adapters/memory/memory-adapter.js';
import {
  assertRefTipsReadable,
  packsWithWrongRevIndex,
} from '../../../../../../src/application/commands/internal/fsck/packed-ref-tips.js';
import { readObject } from '../../../../../../src/application/primitives/read-object.js';
import {
  decompressFailed,
  permissionDenied,
  type TsgitError,
} from '../../../../../../src/domain/error.js';
import {
  invalidCommit,
  invalidFileMode,
  invalidIdentity,
  invalidObjectHeader,
  invalidTag,
  invalidTreeEntry,
  objectHashMismatch,
  objectNotFound,
} from '../../../../../../src/domain/objects/error.js';
import type { ObjectId } from '../../../../../../src/domain/objects/index.js';
import {
  deltaChainTooDeep,
  invalidDelta,
  invalidMultiPackIndex,
  invalidPackEntry,
  invalidPackHeader,
  invalidPackIndex,
  invalidPackRevIndex,
} from '../../../../../../src/domain/storage/error.js';
import type { Context } from '../../../../../../src/ports/context.js';
import { writeSyntheticPack } from '../../../primitives/pack-fixture.js';

vi.mock('../../../../../../src/application/primitives/read-object.js', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../../../../../src/application/primitives/read-object.js')
    >();
  return { ...actual, readObject: vi.fn(actual.readObject) };
});

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

const packedTip = async (): Promise<Context> => {
  const ctx = createMemoryContext();
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
  const [id] = await writeSyntheticPack(ctx, 'tip', [
    { kind: 'base', type: 'blob', content: new TextEncoder().encode('packed tip') },
  ]);
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/tags/t`, `${id}\n`);
  return ctx;
};

const rejectionOf = async (attempt: Promise<unknown>): Promise<TsgitError> => {
  try {
    await attempt;
  } catch (error) {
    return error as TsgitError;
  }
  throw new Error('expected a rejection');
};

describe('Given a pack-claimed ref tip whose read fails for an I/O reason', () => {
  describe('When ref tips are checked', () => {
    it('Then the original fault propagates instead of a damaged-entry refusal', async () => {
      // Arrange
      const ctx = await packedTip();
      const fault = permissionDenied('/repo/.git/objects/pack/pack-tip.pack');
      vi.mocked(readObject).mockRejectedValueOnce(fault);

      // Act
      const caught = await rejectionOf(sut(ctx, NO_CACHE, NO_PACKS));

      // Assert
      expect(caught.data).toEqual(fault.data);
    });
  });
});

describe.each([
  ['an inflate failure', decompressFailed('invalid stored block lengths')],
  ['a damaged pack entry', invalidPackEntry(12, 'bad entry')],
  ['a broken delta', invalidDelta('bad delta')],
  ['a delta chain too deep', deltaChainTooDeep(51)],
  ['a bad pack header', invalidPackHeader('bad')],
  ['a bad pack index', invalidPackIndex('bad')],
  ['a bad multi-pack-index', invalidMultiPackIndex('pack-int-id', 'bad')],
  ['a bad reverse index', invalidPackRevIndex('size', 'bad')],
  ['a bad object header', invalidObjectHeader('bad')],
  ['a bad tree entry', invalidTreeEntry(0, 'bad')],
  ['a bad commit', invalidCommit('bad')],
  ['a bad tag', invalidTag('bad')],
  ['a bad file mode', invalidFileMode('bad')],
  ['a bad identity', invalidIdentity('line', 'bad')],
  ['a missing delta base', objectNotFound('c'.repeat(40) as ObjectId)],
  ['a hash mismatch', objectHashMismatch('a'.repeat(40) as ObjectId, 'b'.repeat(40) as ObjectId)],
])('Given a pack-claimed ref tip whose read fails with %s', (_label, fault) => {
  describe('When ref tips are checked', () => {
    it('Then it refuses as a damaged pack entry at the claimed offset', async () => {
      // Arrange
      const ctx = await packedTip();
      vi.mocked(readObject).mockRejectedValueOnce(fault);

      // Act
      const caught = await rejectionOf(sut(ctx, NO_CACHE, NO_PACKS));

      // Assert
      expect(caught.data).toMatchObject({ code: 'INVALID_PACK_ENTRY', offset: 12 });
    });
  });
});
