import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { bootstrapRepository } from '../../../../../src/application/commands/internal/bootstrap.js';
import { TsgitError } from '../../../../../src/domain/index.js';

describe('internal/bootstrap', () => {
  describe("Given fresh dir + initialBranch='main' + bare=false", () => {
    describe('When bootstrapRepository', () => {
      it('Then standard .git layout is created', async () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        const result = await bootstrapRepository(ctx, { initialBranch: 'main', bare: false });

        // Assert — every documented file/dir is present.
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/HEAD`)).toBe(true);
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/config`)).toBe(true);
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/refs/heads`)).toBe(true);
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/refs/tags`)).toBe(true);
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/objects/info`)).toBe(true);
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/objects/pack`)).toBe(true);
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/info/exclude`)).toBe(true);
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/description`)).toBe(true);
        expect(result.bare).toBe(false);
        expect(result.initialBranch).toBe('main');
        expect(result.gitDir).toBe(ctx.layout.gitDir);
      });
    });
  });

  describe("Given initialBranch='trunk'", () => {
    describe('When bootstrapRepository', () => {
      it('Then HEAD is a symref to refs/heads/trunk', async () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        await bootstrapRepository(ctx, { initialBranch: 'trunk', bare: false });

        // Assert
        const head = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/HEAD`);
        expect(head).toBe('ref: refs/heads/trunk\n');
      });
    });
  });

  describe('Given bare=false', () => {
    describe('When bootstrapRepository', () => {
      it('Then config contains core.bare = false', async () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        await bootstrapRepository(ctx, { initialBranch: 'main', bare: false });

        // Assert
        const config = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/config`);
        expect(config).toContain('[core]');
        expect(config).toMatch(/bare\s*=\s*false/);
      });
    });
  });

  describe('Given bare=true', () => {
    describe('When bootstrapRepository', () => {
      it('Then config contains core.bare = true and result.bare is true', async () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        const result = await bootstrapRepository(ctx, { initialBranch: 'main', bare: true });

        // Assert
        expect(result.bare).toBe(true);
        const config = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/config`);
        expect(config).toMatch(/bare\s*=\s*true/);
      });
    });
  });

  describe("Given an invalid initialBranch ('with space')", () => {
    describe('When bootstrapRepository', () => {
      it('Then throws INVALID_REF before any I/O', async () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        let caught: unknown;
        try {
          await bootstrapRepository(ctx, { initialBranch: 'with space', bare: false });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('INVALID_REF');
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/HEAD`)).toBe(false);
      });
    });
  });

  describe('Given a partial-creation failure (write fails mid-bootstrap)', () => {
    describe('When bootstrapRepository', () => {
      it('Then rmRecursive cleans up the .git tree', async () => {
        // Arrange — make the second writeUtf8 (HEAD) fail.
        const ctx = createMemoryContext();
        const realWriteUtf8 = ctx.fs.writeUtf8.bind(ctx.fs);
        let calls = 0;
        (ctx.fs as { writeUtf8: typeof ctx.fs.writeUtf8 }).writeUtf8 = async (path, content) => {
          calls += 1;
          if (calls === 2) throw new Error('disk full');
          return realWriteUtf8(path, content);
        };

        // Act
        let caught: unknown;
        try {
          await bootstrapRepository(ctx, { initialBranch: 'main', bare: false });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(Error);
        // gitDir should be removed by the rollback.
        expect(await ctx.fs.exists(ctx.layout.gitDir)).toBe(false);
      });
    });
  });
});
