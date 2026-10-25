import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { indexEntryFromStat } from '../../../../../src/application/primitives/internal/index-entry-from-stat.js';
import type { IndexMtime } from '../../../../../src/application/primitives/internal/is-entry-stat-clean.js';
import {
  type ClashScope,
  classifyOccupant,
  type IgnoredProbe,
  type TrackedLookup,
} from '../../../../../src/application/primitives/internal/occupant-clash.js';
import { serializeAndHash } from '../../../../../src/application/primitives/internal/serialize-and-hash.js';
import { createLeadingPathScanner } from '../../../../../src/application/primitives/internal/symlinked-leading-path.js';
import { FILE_MODE } from '../../../../../src/domain/objects/file-mode.js';
import type { FilePath, ObjectId } from '../../../../../src/domain/objects/object-id.js';
import type { Context } from '../../../../../src/ports/context.js';

const path = (s: string): FilePath => s as FilePath;
const BYTES = new Uint8Array([1]);

interface ScopeOptions {
  readonly removed?: ReadonlyArray<string>;
  readonly ignored?: ReadonlyArray<string>;
  readonly tracked?: TrackedLookup;
}

const scopeOf = (ctx: Context, options: ScopeOptions = {}): ClashScope => {
  const workdir = ctx.layout.workDir ?? '';
  const ignored = new Set((options.ignored ?? []).map((p) => `${workdir}/${p}`));
  const isIgnoredPath: IgnoredProbe = async (abs) => ignored.has(abs);
  return {
    workdir,
    removed: new Set((options.removed ?? []).map((p) => `${workdir}/${p}`)),
    isIgnoredPath,
    scanner: createLeadingPathScanner(ctx),
    tracked: options.tracked ?? (async () => undefined),
  };
};

const classify = (ctx: Context, target: string, scope: ClashScope) =>
  classifyOccupant(ctx, { kind: 'add', path: path(target) }, scope);

const classifyChange = (
  ctx: Context,
  kind: 'update' | 'delete',
  target: string,
  scope: ClashScope,
) => classifyOccupant(ctx, { kind, path: path(target) }, scope);

const LOCAL_AT = (target: string) => ({
  kind: 'clash',
  clash: { class: 'local-changes', path: target },
});

describe('classifyOccupant', () => {
  describe('Given a regular file where the added path leading directory is due', () => {
    describe('When the file is neither removed nor ignored', () => {
      it('Then it is untracked at the file component', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.write(`${ctx.layout.workDir}/d`, BYTES);

        // Act
        const result = await classify(ctx, 'd/x', scopeOf(ctx));

        // Assert
        expect(result).toEqual({ kind: 'clash', clash: { class: 'untracked', path: 'd' } });
      });
    });

    describe('When the changeset removes the file', () => {
      it('Then it is clear', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.write(`${ctx.layout.workDir}/d`, BYTES);

        // Act
        const result = await classify(ctx, 'd/x', scopeOf(ctx, { removed: ['d'] }));

        // Assert
        expect(result).toEqual({ kind: 'clear' });
      });
    });

    describe('When the ignore rules cover the file', () => {
      it('Then it is clear', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.write(`${ctx.layout.workDir}/d`, BYTES);

        // Act
        const result = await classify(ctx, 'd/x', scopeOf(ctx, { ignored: ['d'] }));

        // Assert
        expect(result).toEqual({ kind: 'clear' });
      });
    });
  });

  describe('Given a symlink where the added path leading directory is due', () => {
    describe('When the symlink is neither removed nor ignored', () => {
      it('Then it is untracked at the symlink component', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.symlink('nowhere', `${ctx.layout.workDir}/l`);

        // Act
        const result = await classify(ctx, 'l/x', scopeOf(ctx));

        // Assert
        expect(result).toEqual({ kind: 'clash', clash: { class: 'untracked', path: 'l' } });
      });
    });
  });

  describe('Given a directory at the added path', () => {
    describe('When it holds an untracked file', () => {
      it('Then it is untracked at the added path', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.mkdir(`${ctx.layout.workDir}/d`);
        await ctx.fs.write(`${ctx.layout.workDir}/d/u`, BYTES);

        // Act
        const result = await classify(ctx, 'd', scopeOf(ctx));

        // Assert
        expect(result).toEqual({ kind: 'clash', clash: { class: 'untracked', path: 'd' } });
      });
    });

    describe('When it holds ignored files only', () => {
      it('Then it is clear', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.mkdir(`${ctx.layout.workDir}/d`);
        await ctx.fs.write(`${ctx.layout.workDir}/d/u`, BYTES);

        // Act
        const result = await classify(ctx, 'd', scopeOf(ctx, { ignored: ['d/u'] }));

        // Assert
        expect(result).toEqual({ kind: 'clear' });
      });
    });
  });

  describe('Given a file at the added path', () => {
    describe('When the ignore rules do not cover it', () => {
      it('Then it is untracked at the added path', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.write(`${ctx.layout.workDir}/f`, BYTES);

        // Act
        const result = await classify(ctx, 'f', scopeOf(ctx));

        // Assert
        expect(result).toEqual({ kind: 'clash', clash: { class: 'untracked', path: 'f' } });
      });
    });

    describe('When the ignore rules cover it', () => {
      it('Then it is clear', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.write(`${ctx.layout.workDir}/f`, BYTES);

        // Act
        const result = await classify(ctx, 'f', scopeOf(ctx, { ignored: ['f'] }));

        // Assert
        expect(result).toEqual({ kind: 'clear' });
      });
    });
  });

  describe('Given a symlink at the added path', () => {
    describe('When the ignore rules cover it', () => {
      it('Then it is clear', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.symlink('nowhere', `${ctx.layout.workDir}/l`);

        // Act
        const result = await classify(ctx, 'l', scopeOf(ctx, { ignored: ['l'] }));

        // Assert
        expect(result).toEqual({ kind: 'clear' });
      });
    });

    describe('When the ignore rules do not cover it', () => {
      it('Then it is untracked at the added path', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.symlink('nowhere', `${ctx.layout.workDir}/l`);

        // Act
        const result = await classify(ctx, 'l', scopeOf(ctx));

        // Assert
        expect(result).toEqual({ kind: 'clash', clash: { class: 'untracked', path: 'l' } });
      });
    });
  });

  describe('Given nothing at the added path', () => {
    describe('When it is classified', () => {
      it('Then it is clear', async () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        const result = await classify(ctx, 'd/x', scopeOf(ctx));

        // Assert
        expect(result).toEqual({ kind: 'clear' });
      });
    });
  });

  describe('Given a regular file where the updated path leading directory is due', () => {
    describe('When the entry is updated', () => {
      it('Then it is a local change at the entry path', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.write(`${ctx.layout.workDir}/d`, BYTES);

        // Act
        const result = await classifyChange(ctx, 'update', 'd/x', scopeOf(ctx));

        // Assert
        expect(result).toEqual(LOCAL_AT('d/x'));
      });
    });
  });

  describe('Given a regular file where the deleted path leading directory is due', () => {
    describe('When the entry is deleted', () => {
      it('Then it is a local change at the entry path', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.write(`${ctx.layout.workDir}/d`, BYTES);

        // Act
        const result = await classifyChange(ctx, 'delete', 'd/x', scopeOf(ctx));

        // Assert
        expect(result).toEqual(LOCAL_AT('d/x'));
      });
    });
  });

  describe('Given a dangling symlink where the updated path leading directory is due', () => {
    describe('When the entry is updated', () => {
      it('Then it is clear', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.symlink('nowhere', `${ctx.layout.workDir}/d`);

        // Act
        const result = await classifyChange(ctx, 'update', 'd/x', scopeOf(ctx));

        // Assert
        expect(result).toEqual({ kind: 'clear' });
      });
    });
  });

  describe.each(['update', 'delete'] as const)(
    'Given a symlink to a directory holding the %s path',
    (kind) => {
      describe('When the entry is classified', () => {
        it('Then it is a local change at the entry path', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await ctx.fs.mkdir(`${ctx.layout.workDir}/held`);
          await ctx.fs.write(`${ctx.layout.workDir}/held/x`, BYTES);
          await ctx.fs.symlink('held', `${ctx.layout.workDir}/d`);

          // Act
          const result = await classifyChange(ctx, kind, 'd/x', scopeOf(ctx));

          // Assert
          expect(result).toEqual(LOCAL_AT('d/x'));
        });
      });
    },
  );

  describe('Given a symlink to a directory that lacks the updated path', () => {
    describe('When the entry is updated', () => {
      it('Then it is clear', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.mkdir(`${ctx.layout.workDir}/held`);
        await ctx.fs.symlink('held', `${ctx.layout.workDir}/d`);

        // Act
        const result = await classifyChange(ctx, 'update', 'd/x', scopeOf(ctx));

        // Assert
        expect(result).toEqual({ kind: 'clear' });
      });
    });
  });

  describe('Given a directory at an updated path', () => {
    describe('When the entry is updated', () => {
      it('Then it is a local change at the entry path', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.mkdir(`${ctx.layout.workDir}/f`);
        await ctx.fs.write(`${ctx.layout.workDir}/f/u`, BYTES);

        // Act
        const result = await classifyChange(ctx, 'update', 'f', scopeOf(ctx));

        // Assert
        expect(result).toEqual(LOCAL_AT('f'));
      });
    });
  });

  describe('Given an empty directory at a deleted path', () => {
    describe('When the entry is deleted', () => {
      it('Then it is a local change at the entry path', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.mkdir(`${ctx.layout.workDir}/f`);

        // Act
        const result = await classifyChange(ctx, 'delete', 'f', scopeOf(ctx));

        // Assert
        expect(result).toEqual(LOCAL_AT('f'));
      });
    });
  });

  describe('Given a directory of ignored files at a deleted path', () => {
    describe('When the entry is deleted', () => {
      it('Then it is a local change at the entry path', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.mkdir(`${ctx.layout.workDir}/f`);
        await ctx.fs.write(`${ctx.layout.workDir}/f/u`, BYTES);

        // Act
        const result = await classifyChange(ctx, 'delete', 'f', scopeOf(ctx, { ignored: ['f/u'] }));

        // Assert
        expect(result).toEqual(LOCAL_AT('f'));
      });
    });
  });

  describe('Given a directory holding an untracked file at a deleted path', () => {
    describe('When the entry is deleted', () => {
      it('Then it is untracked at the entry path', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.mkdir(`${ctx.layout.workDir}/f`);
        await ctx.fs.write(`${ctx.layout.workDir}/f/u`, BYTES);

        // Act
        const result = await classifyChange(ctx, 'delete', 'f', scopeOf(ctx));

        // Assert
        expect(result).toEqual({ kind: 'clash', clash: { class: 'untracked', path: 'f' } });
      });
    });
  });

  describe('Given a regular file at an updated path', () => {
    describe('When the entry is updated', () => {
      it('Then its content is left to the caller', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.write(`${ctx.layout.workDir}/f`, BYTES);

        // Act
        const result = await classifyChange(ctx, 'update', 'f', scopeOf(ctx));

        // Assert
        expect(result).toEqual({ kind: 'compare-content' });
      });
    });
  });

  describe('Given a regular file at a deleted path', () => {
    describe('When the entry is deleted', () => {
      it('Then its content is left to the caller', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.write(`${ctx.layout.workDir}/f`, BYTES);

        // Act
        const result = await classifyChange(ctx, 'delete', 'f', scopeOf(ctx));

        // Assert
        expect(result).toEqual({ kind: 'compare-content' });
      });
    });
  });

  describe('Given nothing at an updated path', () => {
    describe('When the entry is updated', () => {
      it('Then it is clear', async () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        const result = await classifyChange(ctx, 'update', 'd/x', scopeOf(ctx));

        // Assert
        expect(result).toEqual({ kind: 'clear' });
      });
    });
  });

  describe('Given a symlink to a regular file where the updated path leading directory is due', () => {
    describe.each(['update', 'delete'] as const)('When the entry is %s-classified', (kind) => {
      it('Then it is a local change at the entry path', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.write(`${ctx.layout.workDir}/held`, BYTES);
        await ctx.fs.symlink('held', `${ctx.layout.workDir}/d`);

        // Act
        const result = await classifyChange(ctx, kind, 'd/x', scopeOf(ctx));

        // Assert
        expect(result).toEqual(LOCAL_AT('d/x'));
      });
    });
  });

  describe('Given a path reached through a symlinked directory', () => {
    const CONTENT = new TextEncoder().encode('v1\n');
    const LONG_AGO: IndexMtime = { seconds: 4_000_000_000, nanoseconds: 0 };
    const REACHED = 'd/x';

    const blobIdOf = async (ctx: Context, bytes: Uint8Array): Promise<ObjectId> =>
      (await serializeAndHash(ctx, { type: 'blob', id: '' as ObjectId, content: bytes })).id;

    const arrangeTracked = async (
      ctx: Context,
      options: { readonly indexMtime: IndexMtime; readonly cachedFrom?: Uint8Array },
    ): Promise<TrackedLookup> => {
      const workdir = ctx.layout.workDir ?? '';
      await ctx.fs.mkdir(`${workdir}/held`);
      await ctx.fs.write(`${workdir}/held/x`, options.cachedFrom ?? CONTENT);
      const stat = await ctx.fs.lstat(`${workdir}/held/x`);
      const id = await blobIdOf(ctx, CONTENT);
      const entry = indexEntryFromStat(stat, FILE_MODE.REGULAR, id, path(REACHED));
      await ctx.fs.symlink('held', `${workdir}/d`);
      return async () => ({ entry, indexMtime: options.indexMtime });
    };

    describe('When the reached file still matches the cached stat', () => {
      it('Then it is clear', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const tracked = await arrangeTracked(ctx, { indexMtime: LONG_AGO });

        // Act
        const result = await classifyChange(ctx, 'update', REACHED, scopeOf(ctx, { tracked }));

        // Assert
        expect(result).toEqual({ kind: 'clear' });
      });
    });

    describe('When the reached file differs from the cached stat', () => {
      it('Then it is a local change at the entry path', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const tracked = await arrangeTracked(ctx, { indexMtime: LONG_AGO });
        await ctx.fs.write(`${ctx.layout.workDir}/held/x`, new Uint8Array([1, 2, 3, 4, 5]));

        // Act
        const result = await classifyChange(ctx, 'update', REACHED, scopeOf(ctx, { tracked }));

        // Assert
        expect(result).toEqual(LOCAL_AT(REACHED));
      });
    });

    describe('When the entry is racy and the reached content equals the index blob', () => {
      it('Then it is clear', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const racy: IndexMtime = { seconds: 0, nanoseconds: 0 };
        const tracked = await arrangeTracked(ctx, { indexMtime: racy });

        // Act
        const result = await classifyChange(ctx, 'update', REACHED, scopeOf(ctx, { tracked }));

        // Assert
        expect(result).toEqual({ kind: 'clear' });
      });
    });

    describe('When the entry is racy and the reached content differs at the same size', () => {
      it('Then it is a local change at the entry path', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const racy: IndexMtime = { seconds: 0, nanoseconds: 0 };
        const sameSize = new TextEncoder().encode('v2\n');
        const tracked = await arrangeTracked(ctx, { indexMtime: racy, cachedFrom: sameSize });

        // Act
        const result = await classifyChange(ctx, 'update', REACHED, scopeOf(ctx, { tracked }));

        // Assert
        expect(result).toEqual(LOCAL_AT(REACHED));
      });
    });

    describe('When the index holds no entry for the path', () => {
      it('Then it is a local change at the entry path', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await arrangeTracked(ctx, { indexMtime: LONG_AGO });

        // Act
        const result = await classifyChange(ctx, 'update', REACHED, scopeOf(ctx));

        // Assert
        expect(result).toEqual(LOCAL_AT(REACHED));
      });
    });
  });
});
