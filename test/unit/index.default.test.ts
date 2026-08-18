import { describe, expect, it } from 'vitest';

import { TsgitError } from '../../src/domain/error.js';
import { openRepository } from '../../src/index.default.js';

describe('memory shim — openRepository', () => {
  describe('Given no options', () => {
    describe('When openRepository runs', () => {
      it('Then it returns a frozen Repository handle', async () => {
        // Arrange & Act
        const sut = await openRepository();

        // Assert
        expect(sut).toBeDefined();
        expect(Object.isFrozen(sut)).toBe(true);
      });
    });
  });

  describe('Given the default cwd', () => {
    describe('When inspecting ctx', () => {
      it("Then it equals '/repo' and the layout matches", async () => {
        // Arrange & Act
        const sut = await openRepository();

        // Assert
        expect(sut.ctx.cwd).toBe('/repo');
        expect(sut.ctx.layout.workDir).toBe('/repo');
        expect(sut.ctx.layout.gitDir).toBe('/repo/.git');
        expect(sut.ctx.layout.bare).toBe(false);
      });
    });
  });

  describe('Given gitDir: "" (empty string)', () => {
    describe('When openRepository runs', () => {
      it('Then it throws INVALID_OPTION{option: "gitDir"} rather than resolving a layout', async () => {
        // Arrange / Act
        let caught: unknown;
        try {
          await openRepository({ gitDir: '' });
        } catch (err) {
          caught = err;
        }

        // Assert — validateOptions runs BEFORE resolveLayout in this shim.
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data;
        expect(data.code).toBe('INVALID_OPTION');
        if (data.code === 'INVALID_OPTION') {
          expect(data.option).toBe('gitDir');
        }
      });
    });
  });

  describe("Given algorithm 'sha256'", () => {
    describe('When inspecting ctx.hashConfig', () => {
      it('Then digestLength is 32 (sha256)', async () => {
        // Arrange & Act
        const sut = await openRepository({ algorithm: 'sha256' });

        // Assert
        expect(sut.ctx.hashConfig.digestLength).toBe(32);
      });
    });
  });

  describe('Given default algorithm', () => {
    describe('When inspecting ctx.hashConfig', () => {
      it('Then digestLength is 20 (sha1)', async () => {
        // Arrange & Act
        const sut = await openRepository();

        // Assert
        expect(sut.ctx.hashConfig.digestLength).toBe(20);
      });
    });
  });

  describe('Given a files seed', () => {
    describe('When init runs', () => {
      it('Then the .git directory is created and seeded files survive', async () => {
        // Arrange
        const seedBytes = new TextEncoder().encode('hello');
        const sut = await openRepository({
          files: { '/repo/seed.txt': seedBytes },
        });

        // Act
        await sut.init();

        // Assert
        expect(await sut.ctx.fs.exists('/repo/.git/HEAD')).toBe(true);
        expect(await sut.ctx.fs.readUtf8('/repo/seed.txt')).toBe('hello');
      });
    });
  });

  describe('Given an init via the bound method', () => {
    describe('When followed by status', () => {
      it('Then status reports clean and on refs/heads/main', async () => {
        // Arrange
        const sut = await openRepository();
        await sut.init();

        // Act
        const result = await sut.status();

        // Assert
        expect(result.clean).toBe(true);
        expect(result.branch).toBe('refs/heads/main');
      });
    });
  });

  describe('Given a disposed repo', () => {
    describe('When any bound method is invoked', () => {
      it('Then it throws REPOSITORY_DISPOSED', async () => {
        // Arrange
        const sut = await openRepository();
        await sut.dispose();

        // Act & Assert
        try {
          await sut.init();
          expect.unreachable();
        } catch (err) {
          expect((err as { data: { code: string } }).data.code).toBe('REPOSITORY_DISPOSED');
        }
      });
    });
  });
});

describe('Given a directory holding an INVALID .git with a hostile config', () => {
  describe('When openRepository falls back to the bootstrap layout', () => {
    it("Then the rejected directory's config is never consulted — the layout stays the literal bootstrap", async () => {
      // Arrange — no HEAD/objects/refs, so discovery rejects the .git; the
      // planted config would flip bareness (or throw) if it were read.
      const repo = await openRepository({
        files: { '/repo/.git/config': new TextEncoder().encode('[core]\n\tbare = banana\n') },
      });

      try {
        // Act
        const result = repo.ctx.layout;

        // Assert
        expect(result.bare).toBe(false);
        expect(result.workDir).toBe('/repo');
      } finally {
        await repo.dispose();
      }
    });
  });
});
