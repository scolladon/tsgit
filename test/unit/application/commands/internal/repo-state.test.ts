import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import {
  assertNoPendingOperation,
  assertNotBare,
  assertNoValuelessCorePaths,
  assertOperationalRepository,
  assertRepository,
  isBare,
  readHeadRaw,
} from '../../../../../src/application/commands/internal/repo-state.js';
import { TsgitError } from '../../../../../src/domain/index.js';
import type { Context } from '../../../../../src/ports/context.js';

const seedRepo = async (ctx: Context, head = 'ref: refs/heads/main\n'): Promise<void> => {
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, head);
};

const seedConfig = async (ctx: Context, config: string): Promise<void> => {
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, config);
};

interface MissingValueData {
  readonly code: string;
  readonly key: string;
  readonly line: number;
  readonly source: string;
}

describe('internal/repo-state', () => {
  describe('assertRepository', () => {
    describe('Given a .git/HEAD exists', () => {
      describe('When called', () => {
        it('Then returns the repo root (workDir)', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seedRepo(ctx);

          // Act
          const sut = await assertRepository(ctx);

          // Assert
          expect(sut).toBe(ctx.layout.workDir);
        });
      });
    });

    describe('Given no .git directory', () => {
      describe('When called', () => {
        it('Then throws NOT_A_REPOSITORY', async () => {
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
    });
  });

  describe('isBare', () => {
    describe('Given core.bare=true in config', () => {
      describe('When isBare', () => {
        it('Then true', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[core]\n  bare = true\n');

          // Act
          const sut = await isBare(ctx);

          // Assert
          expect(sut).toBe(true);
        });
      });
    });

    describe('Given core.bare=false in config', () => {
      describe('When isBare', () => {
        it('Then false', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[core]\n  bare = false\n');

          // Act
          const sut = await isBare(ctx);

          // Assert
          expect(sut).toBe(false);
        });
      });
    });

    describe('Given missing .git/config', () => {
      describe('When isBare', () => {
        it('Then false (default)', async () => {
          // Arrange
          const ctx = createMemoryContext();

          // Act
          const sut = await isBare(ctx);

          // Assert
          expect(sut).toBe(false);
        });
      });
    });

    describe('Given config without [core] section', () => {
      describe('When isBare', () => {
        it('Then false (default)', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[user]\n  name = Bob\n');

          // Act
          const sut = await isBare(ctx);

          // Assert
          expect(sut).toBe(false);
        });
      });
    });
  });

  describe('assertNotBare', () => {
    describe('Given a non-bare repo', () => {
      describe('When assertNotBare', () => {
        it('Then resolves', async () => {
          // Arrange
          const ctx = createMemoryContext();

          // Act + Assert — must not throw.
          await assertNotBare(ctx, 'add');
        });
      });
    });

    describe('Given a bare repo (core.bare=true)', () => {
      describe('When assertNotBare', () => {
        it('Then throws BARE_REPOSITORY with operation', async () => {
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
    });
  });

  describe('readHeadRaw', () => {
    describe("Given HEAD = 'ref: refs/heads/main\\\\n'", () => {
      describe('When readHeadRaw', () => {
        it('Then returns symbolic with target', async () => {
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
      });
    });

    describe('Given HEAD with a 40-hex oid', () => {
      describe('When readHeadRaw', () => {
        it('Then returns direct with id', async () => {
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
      });
    });

    describe('Given readUtf8 rejects with a non-TsgitError', () => {
      describe('When readHeadRaw', () => {
        it('Then the original error is rethrown unchanged (not mapped to REF_NOT_FOUND)', async () => {
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
      });
    });

    describe('Given readUtf8 rejects with a TsgitError whose code is not FILE_NOT_FOUND', () => {
      describe('When readHeadRaw', () => {
        it('Then that error is rethrown unchanged (not mapped to REF_NOT_FOUND)', async () => {
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
      });
    });

    describe('Given missing HEAD', () => {
      describe('When readHeadRaw', () => {
        it('Then throws REF_NOT_FOUND', async () => {
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
    });
  });

  describe('assertNoPendingOperation', () => {
    describe('Given no marker files', () => {
      describe('When called', () => {
        it('Then resolves', async () => {
          // Arrange
          const ctx = createMemoryContext();

          // Act + Assert — must not throw.
          await assertNoPendingOperation(ctx);
        });
      });
    });

    describe('Given .git/MERGE_HEAD exists', () => {
      describe('When called', () => {
        it('Then throws OPERATION_IN_PROGRESS with operation merge', async () => {
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
      });
    });

    describe('Given .git/CHERRY_PICK_HEAD exists', () => {
      describe('When called', () => {
        it('Then throws with operation cherry-pick', async () => {
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
      });
    });

    describe('Given .git/REVERT_HEAD exists', () => {
      describe('When called', () => {
        it('Then throws with operation revert', async () => {
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
      });
    });

    describe('Given .git/REBASE_HEAD exists', () => {
      describe('When called', () => {
        it('Then throws with operation rebase', async () => {
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
  });

  describe('assertNoValuelessCorePaths', () => {
    describe('Given a config with a valueless core.excludesfile', () => {
      describe('When called', () => {
        it('Then throws CONFIG_MISSING_VALUE for core.excludesfile', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seedRepo(ctx);
          await seedConfig(ctx, '[core]\n\texcludesfile\n');

          // Act
          let caught: unknown;
          try {
            await assertNoValuelessCorePaths(ctx);
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data as MissingValueData;
          expect(data.code).toBe('CONFIG_MISSING_VALUE');
          expect(data.key).toBe('core.excludesfile');
          expect(data.line).toBe(2);
          expect(data.source).toMatch(/\/config$/);
        });
      });
    });

    describe('Given a config with a valueless core.attributesfile', () => {
      describe('When called', () => {
        it('Then throws CONFIG_MISSING_VALUE for core.attributesfile', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seedRepo(ctx);
          await seedConfig(ctx, '[core]\n\tattributesfile\n');

          // Act
          let caught: unknown;
          try {
            await assertNoValuelessCorePaths(ctx);
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data as MissingValueData;
          expect(data.code).toBe('CONFIG_MISSING_VALUE');
          expect(data.key).toBe('core.attributesfile');
          expect(data.line).toBe(2);
          expect(data.source).toMatch(/\/config$/);
        });
      });
    });

    describe('Given a config with hookspath valueless but the core path-likes valued', () => {
      describe('When called', () => {
        it('Then resolves (hookspath is not in the broad pair)', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seedRepo(ctx);
          await seedConfig(
            ctx,
            '[core]\n\texcludesfile = /x\n\tattributesfile = /y\n\thookspath\n',
          );

          // Act + Assert — must not throw; hookspath is out of the broad gate.
          await assertNoValuelessCorePaths(ctx);
        });
      });
    });
  });

  describe('assertOperationalRepository', () => {
    describe('Given a valueless core.excludesfile and excludesfile earlier than attributesfile', () => {
      describe('When called', () => {
        it('Then throws CONFIG_MISSING_VALUE for the earlier-line key core.excludesfile', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seedRepo(ctx);
          await seedConfig(ctx, '[core]\n\texcludesfile\n\tattributesfile\n');

          // Act
          let caught: unknown;
          try {
            await assertOperationalRepository(ctx);
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data as MissingValueData;
          expect(data.code).toBe('CONFIG_MISSING_VALUE');
          expect(data.key).toBe('core.excludesfile');
          expect(data.line).toBe(2);
        });
      });
    });

    describe('Given two core path-likes both valueless with attributesfile earlier', () => {
      describe('When called', () => {
        it('Then throws CONFIG_MISSING_VALUE for the earlier-line key core.attributesfile', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seedRepo(ctx);
          await seedConfig(ctx, '[core]\n\tattributesfile\n\texcludesfile\n');

          // Act
          let caught: unknown;
          try {
            await assertOperationalRepository(ctx);
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data as MissingValueData;
          expect(data.code).toBe('CONFIG_MISSING_VALUE');
          expect(data.key).toBe('core.attributesfile');
          expect(data.line).toBe(2);
        });
      });
    });

    describe('Given a valueless core.excludesfile', () => {
      describe('When called', () => {
        it('Then throws CONFIG_MISSING_VALUE in isolation', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seedRepo(ctx);
          await seedConfig(ctx, '[core]\n\texcludesfile\n');

          // Act
          let caught: unknown;
          try {
            await assertOperationalRepository(ctx);
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data as MissingValueData;
          expect(data.code).toBe('CONFIG_MISSING_VALUE');
          expect(data.key).toBe('core.excludesfile');
        });
      });
    });

    describe('Given a valueless core.attributesfile', () => {
      describe('When called', () => {
        it('Then throws CONFIG_MISSING_VALUE in isolation', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seedRepo(ctx);
          await seedConfig(ctx, '[core]\n\tattributesfile\n');

          // Act
          let caught: unknown;
          try {
            await assertOperationalRepository(ctx);
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data as MissingValueData;
          expect(data.code).toBe('CONFIG_MISSING_VALUE');
          expect(data.key).toBe('core.attributesfile');
        });
      });
    });

    describe('Given a valued core section', () => {
      describe('When called', () => {
        it('Then returns the repo root (no throw)', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seedRepo(ctx);
          await seedConfig(ctx, '[core]\n\texcludesfile = /x\n');

          // Act
          const sut = await assertOperationalRepository(ctx);

          // Assert
          expect(sut).toBe(ctx.layout.workDir);
        });
      });
    });

    describe('Given no [core] section', () => {
      describe('When called', () => {
        it('Then returns the repo root (no throw)', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seedRepo(ctx);
          await seedConfig(ctx, '[user]\n\tname = Bob\n');

          // Act
          const sut = await assertOperationalRepository(ctx);

          // Assert
          expect(sut).toBe(ctx.layout.workDir);
        });
      });
    });

    describe('Given no .git/HEAD on a valued config', () => {
      describe('When called', () => {
        it('Then throws NOT_A_REPOSITORY (the HEAD check runs)', async () => {
          // Arrange — no HEAD seeded
          const ctx = createMemoryContext();

          // Act
          let caught: unknown;
          try {
            await assertOperationalRepository(ctx);
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as TsgitError).data.code).toBe('NOT_A_REPOSITORY');
        });
      });
    });

    describe('Given a valueless core.excludesfile (the porcelain bypass)', () => {
      describe('When bare assertRepository is called', () => {
        it('Then returns the repo root without throwing (config porcelain survives)', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seedRepo(ctx);
          await seedConfig(ctx, '[core]\n\texcludesfile\n');

          // Act
          const sut = await assertRepository(ctx);

          // Assert
          expect(sut).toBe(ctx.layout.workDir);
        });
      });
    });
  });
});
