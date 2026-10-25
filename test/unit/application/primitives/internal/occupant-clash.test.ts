import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import {
  type ClashScope,
  classifyOccupant,
  type IgnoredProbe,
} from '../../../../../src/application/primitives/internal/occupant-clash.js';
import { createLeadingPathScanner } from '../../../../../src/application/primitives/internal/symlinked-leading-path.js';
import type { FilePath } from '../../../../../src/domain/objects/object-id.js';
import type { Context } from '../../../../../src/ports/context.js';

const path = (s: string): FilePath => s as FilePath;
const BYTES = new Uint8Array([1]);

interface ScopeOptions {
  readonly removed?: ReadonlyArray<string>;
  readonly ignored?: ReadonlyArray<string>;
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
  };
};

const classify = (ctx: Context, target: string, scope: ClashScope) =>
  classifyOccupant(ctx, { kind: 'add', path: path(target) }, scope);

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
});
