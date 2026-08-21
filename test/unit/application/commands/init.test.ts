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
        const result = await init(ctx);

        // Assert
        expect(result.initialBranch).toBe('main');
        expect(result.bare).toBe(false);
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
        const result = await init(ctx, { initialBranch: 'trunk' });

        // Assert
        expect(result.initialBranch).toBe('trunk');
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
        const result = await init(ctx, { bare: true });

        // Assert
        expect(result.bare).toBe(true);
      });
    });
  });

  describe("Given opts.objectFormat='sha256'", () => {
    describe('When init()', () => {
      it('Then .git/config is exactly the [extensions]-then-[core] block with objectformat = sha256 and repositoryformatversion = 1', async () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        await init(ctx, { objectFormat: 'sha256' });

        // Assert — byte-literal, TABs included. The [extensions]-before-[core]
        // ordering and the lower-cased key are measured against
        // `git init --object-format=sha256` (git 2.55.0). git's own init also
        // writes logallrefupdates/ignorecase/precomposeunicode, but none of
        // them is format-conditional — it writes the same set for sha1,
        // gates logallrefupdates on not-bare, and probes the filesystem for
        // the other two — so tsgit keeps its existing three-key block and
        // adds only the format bump.
        const config = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/config`);
        expect(config).toBe(
          '[extensions]\n' +
            '\tobjectformat = sha256\n' +
            '[core]\n' +
            '\trepositoryformatversion = 1\n' +
            '\tfilemode = true\n' +
            '\tbare = false\n',
        );
      });
    });
  });

  describe('Given no opts.objectFormat', () => {
    describe('When init()', () => {
      it("Then .git/config is byte-identical to today's default", async () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        await init(ctx);

        // Assert
        const config = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/config`);
        expect(config).toBe(
          '[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n',
        );
      });
    });
  });

  describe("Given opts.objectFormat='sha256' and opts.bare=true", () => {
    describe('When init()', () => {
      it('Then bare = true and the [extensions] block still precedes [core]', async () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        await init(ctx, { objectFormat: 'sha256', bare: true });

        // Assert
        const config = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/config`);
        expect(config.indexOf('[extensions]')).toBe(0);
        expect(config.indexOf('[extensions]')).toBeLessThan(config.indexOf('[core]'));
        expect(config).toContain('\tbare = true\n');
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
