import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import {
  assertNoPendingOperation,
  assertNotBare,
  assertRepository,
  isBare,
  readHeadRaw,
} from '../../../../../src/application/commands/internal/repo-state.js';
import { TsgitError } from '../../../../../src/domain/index.js';
import type { Context } from '../../../../../src/ports/context.js';

const seedRepo = async (ctx: Context, head = 'ref: refs/heads/main\n'): Promise<void> => {
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, head);
};

describe('internal/repo-state', () => {
  describe('assertRepository', () => {
    it('Given a .git/HEAD exists, When called, Then returns the repo root (workDir)', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await seedRepo(ctx);

      // Act
      const sut = await assertRepository(ctx);

      // Assert
      expect(sut).toBe(ctx.layout.workDir);
    });

    it('Given no .git directory, When called, Then throws NOT_A_REPOSITORY', async () => {
      // Arrange — fresh ctx with no HEAD
      const ctx = createMemoryContext();

      // Act
      let caught: unknown;
      try {
        await assertRepository(ctx);
      } catch (err) {
        caught = err;
      }

      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      expect((caught as TsgitError).data.code).toBe('NOT_A_REPOSITORY');
    });
  });

  describe('isBare', () => {
    it('Given core.bare=true in config, When isBare, Then true', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[core]\n  bare = true\n');

      // Act
      const sut = await isBare(ctx);

      // Assert
      expect(sut).toBe(true);
    });

    it('Given core.bare=false in config, When isBare, Then false', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[core]\n  bare = false\n');

      // Act
      const sut = await isBare(ctx);

      // Assert
      expect(sut).toBe(false);
    });

    it('Given missing .git/config, When isBare, Then false (default)', async () => {
      // Arrange
      const ctx = createMemoryContext();

      // Act
      const sut = await isBare(ctx);

      // Assert
      expect(sut).toBe(false);
    });

    it('Given config without [core] section, When isBare, Then false (default)', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[user]\n  name = Bob\n');

      // Act
      const sut = await isBare(ctx);

      // Assert
      expect(sut).toBe(false);
    });
  });

  describe('assertNotBare', () => {
    it('Given a non-bare repo, When assertNotBare, Then resolves', async () => {
      // Arrange
      const ctx = createMemoryContext();

      // Act + Assert — must not throw.
      // Assert
      await assertNotBare(ctx, 'add');
    });

    it('Given a bare repo (core.bare=true), When assertNotBare, Then throws BARE_REPOSITORY with operation', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[core]\n  bare = true\n');

      // Act
      let caught: unknown;
      try {
        await assertNotBare(ctx, 'add');
      } catch (err) {
        caught = err;
      }

      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      const data = (caught as TsgitError).data;
      expect(data.code).toBe('BARE_REPOSITORY');
      if (data.code === 'BARE_REPOSITORY') {
        expect(data.operation).toBe('add');
      }
    });
  });

  describe('readHeadRaw', () => {
    it("Given HEAD = 'ref: refs/heads/main\\n', When readHeadRaw, Then returns symbolic with target", async () => {
      // Arrange
      const ctx = createMemoryContext();
      await seedRepo(ctx, 'ref: refs/heads/main\n');

      // Act
      const sut = await readHeadRaw(ctx);

      // Assert
      expect(sut.kind).toBe('symbolic');
      if (sut.kind === 'symbolic') {
        expect(sut.target).toBe('refs/heads/main');
      }
    });

    it('Given HEAD with a 40-hex oid, When readHeadRaw, Then returns direct with id', async () => {
      // Arrange
      const ctx = createMemoryContext();
      const oid = '0123456789abcdef0123456789abcdef01234567';
      await seedRepo(ctx, `${oid}\n`);

      // Act
      const sut = await readHeadRaw(ctx);

      // Assert
      expect(sut.kind).toBe('direct');
      if (sut.kind === 'direct') {
        expect(sut.id).toBe(oid);
      }
    });

    it('Given readUtf8 rejects with a non-TsgitError, When readHeadRaw, Then the original error is rethrown unchanged (not mapped to REF_NOT_FOUND)', async () => {
      // Arrange — the guard is `err instanceof TsgitError && ...`; a plain
      // Error must fail the first operand and be rethrown verbatim.
      const ctx = createMemoryContext();
      const original = new Error('disk exploded');
      const ctxStub: Context = {
        ...ctx,
        fs: { ...ctx.fs, readUtf8: async () => Promise.reject(original) },
      };

      // Act
      let caught: unknown;
      try {
        await readHeadRaw(ctxStub);
      } catch (err) {
        caught = err;
      }

      // Assert
      expect(caught).toBe(original);
    });

    it('Given readUtf8 rejects with a TsgitError whose code is not FILE_NOT_FOUND, When readHeadRaw, Then that error is rethrown unchanged (not mapped to REF_NOT_FOUND)', async () => {
      // Arrange — the guard's second operand is `err.data.code === 'FILE_NOT_FOUND'`;
      // a different code must fail it so the error passes through untouched.
      const ctx = createMemoryContext();
      const original = new TsgitError({ code: 'PERMISSION_DENIED', path: '/repo/.git/HEAD' });
      const ctxStub: Context = {
        ...ctx,
        fs: { ...ctx.fs, readUtf8: async () => Promise.reject(original) },
      };

      // Act
      let caught: unknown;
      try {
        await readHeadRaw(ctxStub);
      } catch (err) {
        caught = err;
      }

      // Assert
      expect(caught).toBe(original);
      expect((caught as TsgitError).data.code).toBe('PERMISSION_DENIED');
    });

    it('Given missing HEAD, When readHeadRaw, Then throws REF_NOT_FOUND', async () => {
      // Arrange
      const ctx = createMemoryContext();

      // Act
      let caught: unknown;
      try {
        await readHeadRaw(ctx);
      } catch (err) {
        caught = err;
      }

      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      expect((caught as TsgitError).data.code).toBe('REF_NOT_FOUND');
    });
  });

  describe('assertNoPendingOperation', () => {
    it('Given no marker files, When called, Then resolves', async () => {
      // Arrange
      const ctx = createMemoryContext();

      // Act + Assert — must not throw.
      // Assert
      await assertNoPendingOperation(ctx);
    });

    it('Given .git/MERGE_HEAD exists, When called, Then throws OPERATION_IN_PROGRESS with operation merge', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/MERGE_HEAD`, 'oid\n');

      // Act
      let caught: unknown;
      try {
        await assertNoPendingOperation(ctx);
      } catch (err) {
        caught = err;
      }

      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      const data = (caught as TsgitError).data;
      expect(data.code).toBe('OPERATION_IN_PROGRESS');
      if (data.code === 'OPERATION_IN_PROGRESS') {
        expect(data.operation).toBe('merge');
      }
    });

    it('Given .git/CHERRY_PICK_HEAD exists, When called, Then throws with operation cherry-pick', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/CHERRY_PICK_HEAD`, 'oid\n');

      // Act
      let caught: unknown;
      try {
        await assertNoPendingOperation(ctx);
      } catch (err) {
        caught = err;
      }

      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      const data = (caught as TsgitError).data;
      if (data.code === 'OPERATION_IN_PROGRESS') {
        expect(data.operation).toBe('cherry-pick');
      } else {
        expect.fail(`expected OPERATION_IN_PROGRESS, got ${data.code}`);
      }
    });

    it('Given .git/REVERT_HEAD exists, When called, Then throws with operation revert', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/REVERT_HEAD`, 'oid\n');

      // Act
      let caught: unknown;
      try {
        await assertNoPendingOperation(ctx);
      } catch (err) {
        caught = err;
      }

      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      const data = (caught as TsgitError).data;
      if (data.code === 'OPERATION_IN_PROGRESS') {
        expect(data.operation).toBe('revert');
      } else {
        expect.fail(`expected OPERATION_IN_PROGRESS, got ${data.code}`);
      }
    });

    it('Given .git/REBASE_HEAD exists, When called, Then throws with operation rebase', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/REBASE_HEAD`, 'oid\n');

      // Act
      let caught: unknown;
      try {
        await assertNoPendingOperation(ctx);
      } catch (err) {
        caught = err;
      }

      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      const data = (caught as TsgitError).data;
      if (data.code === 'OPERATION_IN_PROGRESS') {
        expect(data.operation).toBe('rebase');
      } else {
        expect.fail(`expected OPERATION_IN_PROGRESS, got ${data.code}`);
      }
    });
  });
});
