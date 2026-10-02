import { describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../../../src/adapters/memory/memory-adapter.js';
import { assertRefTipsReadable } from '../../../../../../src/application/commands/internal/fsck/packed-ref-tips.js';
import { looseObjectPath } from '../../../../../../src/application/primitives/path-layout.js';
import { readObject } from '../../../../../../src/application/primitives/read-object.js';
import { writeObject } from '../../../../../../src/application/primitives/write-object.js';
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
      const result = sut(ctx, NO_CACHE);

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
        await sut(guarded, NO_CACHE);
      } catch (error) {
        caught = error;
      }

      // Assert
      expect((caught as TsgitError).data).toEqual(fault.data);
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
      const caught = await rejectionOf(sut(ctx, NO_CACHE));

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
      const caught = await rejectionOf(sut(ctx, NO_CACHE));

      // Assert
      expect(caught.data).toMatchObject({ code: 'INVALID_PACK_ENTRY', offset: 12 });
    });
  });
});

const looseTip = async (): Promise<{ readonly ctx: Context; readonly id: ObjectId }> => {
  const ctx = createMemoryContext();
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
  const id = await writeObject(ctx, {
    type: 'blob',
    id: '' as ObjectId,
    content: new TextEncoder().encode('loose tip'),
  });
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/tags/t`, `${id}\n`);
  return { ctx, id };
};

describe.each([
  ['an inflate failure', decompressFailed('incorrect header check')],
  ['a bad object header', invalidObjectHeader('bad')],
])('Given a loose ref tip no pack claims whose read fails with %s', (_label, fault) => {
  describe('When ref tips are checked', () => {
    it('Then it refuses as git dies on the corrupt loose object', async () => {
      // Arrange
      const { ctx, id } = await looseTip();
      vi.mocked(readObject).mockRejectedValueOnce(fault);

      // Act
      const caught = await rejectionOf(sut(ctx, NO_CACHE));

      // Assert
      expect(caught.data).toEqual({
        code: 'INVALID_OBJECT_HEADER',
        reason: `loose object ${id} (stored in ${looseObjectPath(ctx.layout.gitDir, id)}) is corrupt`,
      });
    });
  });
});

describe('Given a loose ref tip no pack claims whose bytes hash to another id', () => {
  describe('When ref tips are checked', () => {
    it('Then it resolves, as git reads the loose file before it refuses the hash', async () => {
      // Arrange
      const { ctx, id } = await looseTip();
      vi.mocked(readObject).mockRejectedValueOnce(objectHashMismatch(id, ABSENT as ObjectId));

      // Act
      const result = sut(ctx, NO_CACHE);

      // Assert
      await expect(result).resolves.toBeUndefined();
    });
  });
});

describe('Given a ref tip no store holds whose read fails to inflate', () => {
  describe('When ref tips are checked', () => {
    it('Then it resolves, as no loose file is there to die on', async () => {
      // Arrange
      const ctx = await repoWithTag(ABSENT);
      vi.mocked(readObject).mockRejectedValueOnce(decompressFailed('incorrect header check'));

      // Act
      const result = sut(ctx, NO_CACHE);

      // Assert
      await expect(result).resolves.toBeUndefined();
    });
  });
});
