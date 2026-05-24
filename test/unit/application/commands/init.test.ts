import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { init } from '../../../../src/application/commands/init.js';
import { TsgitError } from '../../../../src/domain/index.js';

describe('init', () => {
  describe('Given a fresh directory', () => {
    describe('When init()', () => {
      it('Then creates .git and returns InitResult{initialBranch:main, bare:false}', async () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        const sut = await init(ctx);

        // Assert
        expect(sut.initialBranch).toBe('main');
        expect(sut.bare).toBe(false);
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/HEAD`)).toBe(true);
      });
    });
  });

  describe("Given opts.initialBranch='trunk'", () => {
    describe('When init()', () => {
      it('Then HEAD is symref to refs/heads/trunk', async () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        const sut = await init(ctx, { initialBranch: 'trunk' });

        // Assert
        expect(sut.initialBranch).toBe('trunk');
        expect(await ctx.fs.readUtf8(`${ctx.layout.gitDir}/HEAD`)).toBe('ref: refs/heads/trunk\n');
      });
    });
  });

  describe('Given opts.bare=true', () => {
    describe('When init()', () => {
      it('Then result.bare is true', async () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        const sut = await init(ctx, { bare: true });

        // Assert
        expect(sut.bare).toBe(true);
      });
    });
  });

  describe('Given an existing .git/HEAD', () => {
    describe('When init()', () => {
      it('Then throws ALREADY_INITIALIZED', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');

        // Act
        let caught: unknown;
        try {
          await init(ctx);
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('ALREADY_INITIALIZED');
      });
    });
  });

  describe("Given an invalid initialBranch ('with space')", () => {
    describe('When init()', () => {
      it('Then throws INVALID_REF before any I/O', async () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        let caught: unknown;
        try {
          await init(ctx, { initialBranch: 'with space' });
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
});
