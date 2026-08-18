import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { configGet, configList } from '../../../../../src/application/commands/config.js';
import {
  assertEagerConfigValid,
  assertNoPendingOperation,
  assertOperationalRepository,
  assertRepository,
  branchRefFromHead,
  currentBranchRef,
  readHeadRaw,
  requireWorkTree,
} from '../../../../../src/application/commands/internal/repo-state.js';
import type { HeadState } from '../../../../../src/application/primitives/internal/repo-state.js';
import { ObjectId, RefName, TsgitError } from '../../../../../src/domain/index.js';
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
          const result = await assertRepository(ctx);

          // Assert
          expect(result).toBe(ctx.layout.workDir);
        });
      });
    });

    describe('Given a T1 boolean key holds a value git refuses', () => {
      describe('When called', () => {
        it.each([
          {
            config: '[core]\n\tbare = maybe\n',
            expectedKey: 'core.bare',
            label: 'core.bare = maybe',
          },
          {
            config: '[extensions]\n\tworktreeConfig = maybe\n',
            expectedKey: 'extensions.worktreeconfig',
            label: 'extensions.worktreeConfig = maybe',
          },
        ])('Then $label throws CONFIG_BAD_BOOLEAN_VALUE', async ({ config, expectedKey }) => {
          // Arrange
          const ctx = createMemoryContext();
          await seedRepo(ctx);
          await seedConfig(ctx, config);

          // Act
          let caught: unknown;
          try {
            await assertRepository(ctx);
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data as BadBooleanData;
          expect(data.code).toBe('CONFIG_BAD_BOOLEAN_VALUE');
          expect(data.key).toBe(expectedKey);
          expect(data.value).toBe('maybe');
        });
      });
    });

    describe('Given a T2 boolean key (not T1) holds a value git refuses', () => {
      describe('When called', () => {
        it('Then resolves (no throw — T2 keys do not gate discovery)', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seedRepo(ctx);
          await seedConfig(ctx, '[core]\n\tsparseCheckout = maybe\n');

          // Act + Assert
          await assertRepository(ctx);
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

  describe('requireWorkTree', () => {
    describe('Given a Context with a work tree', () => {
      describe('When requireWorkTree', () => {
        it('Then returns the work tree path', () => {
          // Arrange
          const ctx = createMemoryContext();

          // Act
          const result = requireWorkTree(ctx, 'add');

          // Assert
          expect(result).toBe(ctx.layout.workDir);
        });
      });
    });

    describe('Given a Context with no work tree', () => {
      describe('When requireWorkTree', () => {
        it('Then throws WORK_TREE_REQUIRED with the operation', () => {
          // Arrange
          const ctx = createMemoryContext();
          const { workDir: _workDir, ...bareLayout } = ctx.layout;
          const bareCtx: Context = { ...ctx, layout: { ...bareLayout, bare: true } };

          // Act
          let caught: unknown;
          try {
            requireWorkTree(bareCtx, 'add');
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data;
          expect(data.code).toBe('WORK_TREE_REQUIRED');
          if (data.code === 'WORK_TREE_REQUIRED') {
            expect(data.operation).toBe('add');
          }
        });
      });
    });

    describe('Given a Context whose work-tree config is bogus, but a work tree is present', () => {
      describe('When requireWorkTree', () => {
        it('Then throws WORK_TREE_CONFIG_INVALID with the gitDir — never the missing-work-tree code', () => {
          // Arrange — a Context that trips BOTH conditions must not be the only
          // proof of either guard; this one keeps workDir present so only the
          // bogus-config guard can be the cause of the throw.
          const ctx = createMemoryContext();
          const bogusCtx: Context = {
            ...ctx,
            layout: { ...ctx.layout, workTreeConfigBogus: true },
          };

          // Act
          let caught: unknown;
          try {
            requireWorkTree(bogusCtx, 'add');
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data;
          expect(data.code).toBe('WORK_TREE_CONFIG_INVALID');
          if (data.code === 'WORK_TREE_CONFIG_INVALID') {
            expect(data.gitDir).toBe(ctx.layout.gitDir);
          }
        });
      });
    });

    describe('Given a Context with no work tree AND a bogus work-tree config', () => {
      describe('When requireWorkTree', () => {
        it('Then the bogus-config refusal wins — the guard order is pinned', () => {
          // Arrange — both guards can fire; git reports the invalid-config
          // fatal ahead of the plain work-tree one, so ours must too.
          const ctx = createMemoryContext();
          const { workDir: _workDir, ...bareLayout } = ctx.layout;
          const bothCtx: Context = {
            ...ctx,
            layout: { ...bareLayout, bare: true, workTreeConfigBogus: true },
          };

          // Act
          let caught: unknown;
          try {
            requireWorkTree(bothCtx, 'add');
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data;
          expect(data.code).toBe('WORK_TREE_CONFIG_INVALID');
          if (data.code === 'WORK_TREE_CONFIG_INVALID') {
            expect(data.gitDir).toBe(ctx.layout.gitDir);
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
          const result = await readHeadRaw(ctx);

          // Assert
          expect(result.kind).toBe('symbolic');
          if (result.kind === 'symbolic') {
            expect(result.target).toBe('refs/heads/main');
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
          const result = await readHeadRaw(ctx);

          // Assert
          expect(result.kind).toBe('direct');
          if (result.kind === 'direct') {
            expect(result.id).toBe(oid);
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

  describe('branchRefFromHead', () => {
    describe('Given a symbolic HeadState', () => {
      describe('When branchRefFromHead', () => {
        it('Then returns the exact target RefName', () => {
          // Arrange
          const head: HeadState = { kind: 'symbolic', target: RefName.from('refs/heads/main') };

          // Act
          const result = branchRefFromHead(head);

          // Assert
          expect(result).toBe('refs/heads/main');
        });
      });
    });

    describe('Given a direct HeadState', () => {
      describe('When branchRefFromHead', () => {
        it('Then returns undefined', () => {
          // Arrange
          const head: HeadState = {
            kind: 'direct',
            id: ObjectId.from('0123456789abcdef0123456789abcdef01234567'),
          };

          // Act
          const result = branchRefFromHead(head);

          // Assert
          expect(result).toBeUndefined();
        });
      });
    });
  });

  describe('currentBranchRef', () => {
    describe('Given an in-memory ctx whose HEAD is symbolic', () => {
      describe('When currentBranchRef', () => {
        it('Then returns the exact target RefName', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seedRepo(ctx, 'ref: refs/heads/main\n');

          // Act
          const result = await currentBranchRef(ctx);

          // Assert
          expect(result).toBe('refs/heads/main');
        });
      });
    });

    describe('Given an in-memory ctx whose HEAD is detached', () => {
      describe('When currentBranchRef', () => {
        it('Then returns undefined', async () => {
          // Arrange
          const ctx = createMemoryContext();
          const oid = '0123456789abcdef0123456789abcdef01234567';
          await seedRepo(ctx, `${oid}\n`);

          // Act
          const result = await currentBranchRef(ctx);

          // Assert
          expect(result).toBeUndefined();
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

    describe('Given a single pending-operation marker file exists', () => {
      describe('When called', () => {
        it.each([
          { marker: 'CHERRY_PICK_HEAD', operation: 'cherry-pick', label: 'CHERRY_PICK_HEAD' },
          { marker: 'REVERT_HEAD', operation: 'revert', label: 'REVERT_HEAD' },
          { marker: 'REBASE_HEAD', operation: 'rebase', label: 'REBASE_HEAD' },
        ])('Then .git/$label throws with operation $operation', async ({ marker, operation }) => {
          // Arrange
          const ctx = createMemoryContext();
          await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/${marker}`, 'oid\n');

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
            expect(data.operation).toBe(operation);
          } else {
            expect.fail(`expected OPERATION_IN_PROGRESS, got ${data.code}`);
          }
        });
      });
    });
  });

  describe('assertEagerConfigValid (string path-likes)', () => {
    describe('Given a config with a valueless core path-like', () => {
      describe('When called', () => {
        it.each([
          { key: 'excludesfile', label: 'core.excludesfile' },
          { key: 'attributesfile', label: 'core.attributesfile' },
        ])('Then throws CONFIG_MISSING_VALUE for $label', async ({ key }) => {
          // Arrange
          const ctx = createMemoryContext();
          await seedRepo(ctx);
          await seedConfig(ctx, `[core]\n\t${key}\n`);

          // Act
          let caught: unknown;
          try {
            await assertEagerConfigValid(ctx);
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data as MissingValueData;
          expect(data.code).toBe('CONFIG_MISSING_VALUE');
          expect(data.key).toBe(`core.${key}`);
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
          await assertEagerConfigValid(ctx);
        });
      });
    });
  });

  describe('assertOperationalRepository', () => {
    describe('Given two core path-likes both valueless', () => {
      describe('When called', () => {
        it.each([
          {
            config: '[core]\n\texcludesfile\n\tattributesfile\n',
            expectedKey: 'core.excludesfile',
            label:
              'excludesfile earlier than attributesfile throws for the earlier-line key core.excludesfile',
          },
          {
            config: '[core]\n\tattributesfile\n\texcludesfile\n',
            expectedKey: 'core.attributesfile',
            label:
              'attributesfile earlier than excludesfile throws for the earlier-line key core.attributesfile',
          },
        ])('Then $label', async ({ config, expectedKey }) => {
          // Arrange
          const ctx = createMemoryContext();
          await seedRepo(ctx);
          await seedConfig(ctx, config);

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
          expect(data.key).toBe(expectedKey);
          expect(data.line).toBe(2);
        });
      });
    });

    describe('Given a valueless core path-like in isolation', () => {
      describe('When called', () => {
        it.each([
          { key: 'excludesfile', label: 'core.excludesfile' },
          { key: 'attributesfile', label: 'core.attributesfile' },
        ])('Then throws CONFIG_MISSING_VALUE for $label', async ({ key }) => {
          // Arrange
          const ctx = createMemoryContext();
          await seedRepo(ctx);
          await seedConfig(ctx, `[core]\n\t${key}\n`);

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
          expect(data.key).toBe(`core.${key}`);
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
          const result = await assertOperationalRepository(ctx);

          // Assert
          expect(result).toBe(ctx.layout.workDir);
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
          const result = await assertOperationalRepository(ctx);

          // Assert
          expect(result).toBe(ctx.layout.workDir);
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

    describe('Given a porcelain-bypass config (a valueless core path-like)', () => {
      describe('When bare assertRepository is called', () => {
        it.each([
          { key: 'excludesfile', label: 'core.excludesfile' },
          { key: 'loosecompression', label: 'core.loosecompression (int keys too)' },
        ])(
          'Then $label returns the repo root without throwing (config porcelain survives)',
          async ({ key }) => {
            // Arrange
            const ctx = createMemoryContext();
            await seedRepo(ctx);
            await seedConfig(ctx, `[core]\n\t${key}\n`);

            // Act
            const result = await assertRepository(ctx);

            // Assert
            expect(result).toBe(ctx.layout.workDir);
          },
        );
      });
    });

    describe('Given a valueless core int key alone', () => {
      describe('When called', () => {
        it.each([
          { key: 'loosecompression', label: 'core.loosecompression' },
          { key: 'compression', label: 'core.compression' },
        ])('Then throws CONFIG_BAD_NUMERIC_VALUE for $label', async ({ key }) => {
          // Arrange
          const ctx = createMemoryContext();
          await seedRepo(ctx);
          await seedConfig(ctx, `[core]\n\t${key}\n`);

          // Act
          let caught: unknown;
          try {
            await assertOperationalRepository(ctx);
          } catch (err) {
            caught = err;
          }

          // Assert — each field individually (mutation-resistant)
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data as BadNumericData;
          expect(data.code).toBe('CONFIG_BAD_NUMERIC_VALUE');
          expect(data.key).toBe(`core.${key}`);
          expect(data.value).toBe('');
          expect(data.reason).toBe('invalid unit');
        });
      });
    });

    describe('Given a config with valid or absent int keys', () => {
      describe('When called', () => {
        it.each([
          {
            config: '[core]\n\tloosecompression = 9\n',
            label: 'a valued core.loosecompression resolves without throw',
          },
          {
            config: '[core]\n\trepositoryformatversion = 0\n',
            label: 'no int keys in core resolves without throw (absent int keys)',
          },
        ])('Then $label', async ({ config }) => {
          // Arrange
          const ctx = createMemoryContext();
          await seedRepo(ctx);
          await seedConfig(ctx, config);

          // Act + Assert — must not throw
          await assertOperationalRepository(ctx);
        });
      });
    });

    describe('Given a config with string key (excludesfile) earlier than int key (loosecompression)', () => {
      describe('When called', () => {
        it('Then throws CONFIG_MISSING_VALUE for core.excludesfile (string shape, with line)', async () => {
          // Arrange — line 2 = excludesfile, line 3 = loosecompression
          const ctx = createMemoryContext();
          await seedRepo(ctx);
          await seedConfig(ctx, '[core]\n\texcludesfile\n\tloosecompression\n');

          // Act
          let caught: unknown;
          try {
            await assertOperationalRepository(ctx);
          } catch (err) {
            caught = err;
          }

          // Assert — string shape wins (earlier line)
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data as MissingValueData;
          expect(data.code).toBe('CONFIG_MISSING_VALUE');
          expect(data.key).toBe('core.excludesfile');
          expect(data.line).toBe(2);
        });
      });
    });

    describe('Given a config with int key (loosecompression) earlier than string key (excludesfile)', () => {
      describe('When called', () => {
        it('Then throws CONFIG_BAD_NUMERIC_VALUE for core.loosecompression (int shape, no line)', async () => {
          // Arrange — line 2 = loosecompression, line 3 = excludesfile
          const ctx = createMemoryContext();
          await seedRepo(ctx);
          await seedConfig(ctx, '[core]\n\tloosecompression\n\texcludesfile\n');

          // Act
          let caught: unknown;
          try {
            await assertOperationalRepository(ctx);
          } catch (err) {
            caught = err;
          }

          // Assert — int shape wins (earlier line)
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data as BadNumericData;
          expect(data.code).toBe('CONFIG_BAD_NUMERIC_VALUE');
          expect(data.key).toBe('core.loosecompression');
          expect(data.value).toBe('');
          expect(data.reason).toBe('invalid unit');
        });
      });
    });
  });

  describe('assertEagerConfigValid', () => {
    describe('Given an invalid-unit or still-invalid-after-precedence compression key', () => {
      describe('When called', () => {
        it.each([
          {
            config: '[core]\n\tloosecompression = abc\n',
            expectedKey: 'core.loosecompression',
            expectedValue: 'abc',
            label: 'core.loosecompression = abc (invalid unit)',
          },
          {
            config: '[core]\n\tcompression = abc\n',
            expectedKey: 'core.compression',
            expectedValue: 'abc',
            label: 'core.compression = abc (invalid unit)',
          },
          {
            config: '[core]\n\tloosecompression = abc\n\texcludesfile\n',
            expectedKey: 'core.loosecompression',
            expectedValue: 'abc',
            label:
              'core.loosecompression = abc (line 2) and core.excludesfile valueless (line 3) — compression class wins, earlier line',
          },
          {
            config: '[core]\n\tloosecompression\n',
            expectedKey: 'core.loosecompression',
            expectedValue: '',
            label: 'core.loosecompression valueless (still invalid — numeric shape)',
          },
        ])(
          'Then $label throws CONFIG_BAD_NUMERIC_VALUE',
          async ({ config, expectedKey, expectedValue }) => {
            // Arrange
            const ctx = createMemoryContext();
            await seedRepo(ctx);
            await seedConfig(ctx, config);

            // Act
            let caught: unknown;
            try {
              await assertEagerConfigValid(ctx);
            } catch (err) {
              caught = err;
            }

            // Assert
            expect(caught).toBeInstanceOf(TsgitError);
            const data = (caught as TsgitError).data as BadNumericData;
            expect(data.code).toBe('CONFIG_BAD_NUMERIC_VALUE');
            expect(data.key).toBe(expectedKey);
            expect(data.value).toBe(expectedValue);
            expect(data.reason).toBe('invalid unit');
          },
        );
      });
    });

    describe('Given a compression key with an out-of-range numeric value', () => {
      describe('When called', () => {
        it.each([
          { key: 'loosecompression', label: 'core.loosecompression' },
          { key: 'compression', label: 'core.compression' },
        ])(
          'Then $label throws CONFIG_BAD_NUMERIC_VALUE with reason out of range',
          async ({ key }) => {
            // Arrange
            const ctx = createMemoryContext();
            await seedRepo(ctx);
            await seedConfig(ctx, `[core]\n\t${key} = 999999999999999999999999\n`);

            // Act
            let caught: unknown;
            try {
              await assertEagerConfigValid(ctx);
            } catch (err) {
              caught = err;
            }

            // Assert
            expect(caught).toBeInstanceOf(TsgitError);
            const data = (caught as TsgitError).data as BadNumericData;
            expect(data.code).toBe('CONFIG_BAD_NUMERIC_VALUE');
            expect(data.key).toBe(`core.${key}`);
            expect(data.reason).toBe('out of range');
          },
        );
      });
    });

    describe('Given a compression key with a valid int outside the zlib -1..9 range', () => {
      describe('When called', () => {
        it.each([
          {
            config: '[core]\n\tloosecompression = 99\n',
            level: 99,
            label: 'core.loosecompression = 99 (outside zlib -1..9)',
          },
          {
            config: '[core]\n\tcompression = 99\n',
            level: 99,
            label: 'core.compression = 99 (outside zlib -1..9)',
          },
          {
            config: '[core]\n\tloosecompression = -2\n',
            level: -2,
            label: 'core.loosecompression = -2 (below zlib min -1)',
          },
          {
            config: '[core]\n\tloosecompression = 10\n',
            level: 10,
            label: 'core.loosecompression = 10 (above zlib max 9)',
          },
          {
            config: '[core]\n\tloosecompression = 1\n\tcompression = 99\n',
            level: 99,
            label:
              'core.loosecompression = 1 (valid) and core.compression = 99 (bad zlib) — two-key independence',
          },
        ])(
          'Then $label throws CONFIG_BAD_ZLIB_LEVEL with that level',
          async ({ config, level }) => {
            // Arrange
            const ctx = createMemoryContext();
            await seedRepo(ctx);
            await seedConfig(ctx, config);

            // Act
            let caught: unknown;
            try {
              await assertEagerConfigValid(ctx);
            } catch (err) {
              caught = err;
            }

            // Assert
            expect(caught).toBeInstanceOf(TsgitError);
            const data = (caught as TsgitError).data as BadZlibData;
            expect(data.code).toBe('CONFIG_BAD_ZLIB_LEVEL');
            expect(data.level).toBe(level);
          },
        );
      });
    });

    describe('Given core.excludesfile valueless (line 2) and core.loosecompression = abc (line 3)', () => {
      describe('When called', () => {
        it('Then throws CONFIG_MISSING_VALUE for excludesfile (string class wins, earlier line)', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seedRepo(ctx);
          await seedConfig(ctx, '[core]\n\texcludesfile\n\tloosecompression = abc\n');

          // Act
          let caught: unknown;
          try {
            await assertEagerConfigValid(ctx);
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

    describe('Given a compression key with a valid zlib-range value or absent', () => {
      describe('When called', () => {
        it.each([
          {
            config: '[core]\n\tloosecompression = 9\n',
            label: 'core.loosecompression = 9 (valid zlib max)',
          },
          {
            config: '[core]\n\tloosecompression = 0\n',
            label: 'core.loosecompression = 0 (valid zlib level)',
          },
          {
            config: '[core]\n\tloosecompression = -1\n',
            label: 'core.loosecompression = -1 (valid zlib default)',
          },
          {
            config: '[core]\n\tloosecompression = 5\n',
            label: 'config with only valued valid compression keys',
          },
        ])('Then $label resolves without throw', async ({ config }) => {
          // Arrange
          const ctx = createMemoryContext();
          await seedRepo(ctx);
          await seedConfig(ctx, config);

          // Act + Assert — must not throw
          await assertEagerConfigValid(ctx);
        });
      });
    });

    describe('Given a T2 boolean key holds a value git refuses', () => {
      describe('When called', () => {
        it.each([
          {
            config: '[core]\n\tsparseCheckout = maybe\n',
            expectedKey: 'core.sparsecheckout',
            label: 'core.sparseCheckout = maybe',
          },
          {
            config: '[core]\n\tsparseCheckoutCone = maybe\n',
            expectedKey: 'core.sparsecheckoutcone',
            label: 'core.sparseCheckoutCone = maybe',
          },
          {
            config: '[core]\n\tlogAllRefUpdates = maybe\n',
            expectedKey: 'core.logallrefupdates',
            label: 'core.logAllRefUpdates = maybe',
          },
          {
            config: '[diff "MyDriver"]\n\tcachetextconv = maybe\n',
            expectedKey: 'diff.MyDriver.cachetextconv',
            label: '[diff "MyDriver"] cachetextconv = maybe (subsection verbatim)',
          },
        ])('Then $label throws CONFIG_BAD_BOOLEAN_VALUE', async ({ config, expectedKey }) => {
          // Arrange
          const ctx = createMemoryContext();
          await seedRepo(ctx);
          await seedConfig(ctx, config);

          // Act
          let caught: unknown;
          try {
            await assertEagerConfigValid(ctx);
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data as BadBooleanData;
          expect(data.code).toBe('CONFIG_BAD_BOOLEAN_VALUE');
          expect(data.key).toBe(expectedKey);
          expect(data.value).toBe('maybe');
        });
      });
    });

    describe('Given BOTH discovery keys malformed in the same config', () => {
      describe('When the operational entry point runs', () => {
        it.each([
          {
            config: '[core]\n\tbare = maybe\n[extensions]\n\tworktreeConfig = maybe\n',
            expectedKey: 'core.bare',
            label: 'core.bare first',
          },
          {
            config: '[extensions]\n\tworktreeConfig = maybe\n[core]\n\tbare = maybe\n',
            expectedKey: 'extensions.worktreeconfig',
            label: 'extensions.worktreeConfig first',
          },
        ])('Then the lower-line key wins ($label)', async ({ config, expectedKey }) => {
          // Arrange
          const ctx = createMemoryContext();
          await seedRepo(ctx);
          await seedConfig(ctx, config);

          // Act
          let caught: unknown;
          try {
            await assertOperationalRepository(ctx);
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data as BadBooleanData;
          expect(data.code).toBe('CONFIG_BAD_BOOLEAN_VALUE');
          expect(data.key).toBe(expectedKey);
        });
      });
    });

    describe('Given a T2 key on an EARLIER line than a malformed T1 key', () => {
      describe('When the operational entry point runs', () => {
        it('Then the T1 key wins regardless of line order — discovery is a separate, earlier pass', async () => {
          // Arrange — sparseCheckout (T2) on line 2, bare (T1) on line 3.
          const ctx = createMemoryContext();
          await seedRepo(ctx);
          await seedConfig(ctx, '[core]\n\tsparseCheckout = maybe\n\tbare = maybe\n');

          // Act
          let caught: unknown;
          try {
            await assertOperationalRepository(ctx);
          } catch (err) {
            caught = err;
          }

          // Assert — git names core.bare here too: its discovery-time config
          // read runs wholly before the default-config pass.
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data as BadBooleanData;
          expect(data.code).toBe('CONFIG_BAD_BOOLEAN_VALUE');
          expect(data.key).toBe('core.bare');
        });
      });
    });

    describe('Given a subsectionless [diff] cachetextconv holds a value git refuses', () => {
      describe('When called', () => {
        it('Then resolves without throw — git only knows the key per driver subsection', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seedRepo(ctx);
          await seedConfig(ctx, '[diff]\n\tcachetextconv = maybe\n');

          // Act + Assert — must not throw
          await assertEagerConfigValid(ctx);
        });
      });
    });

    describe('Given several malformed entries across the valueless, compression and boolean classes', () => {
      describe('When called', () => {
        it.each([
          {
            config: '[core]\n\tsparseCheckout = maybe\n\texcludesFile\n',
            expectedCode: 'CONFIG_BAD_BOOLEAN_VALUE',
            label: 'boolean (line 2) before valueless (line 3) — boolean wins',
          },
          {
            config: '[core]\n\texcludesFile\n\tsparseCheckout = maybe\n',
            expectedCode: 'CONFIG_MISSING_VALUE',
            label: 'valueless (line 2) before boolean (line 3) — valueless wins',
          },
          {
            config: '[core]\n\tsparseCheckout = maybe\n\tloosecompression = abc\n',
            expectedCode: 'CONFIG_BAD_BOOLEAN_VALUE',
            label: 'boolean (line 2) before invalid compression (line 3) — boolean wins',
          },
          {
            config: '[core]\n\tloosecompression = abc\n\tsparseCheckout = maybe\n',
            expectedCode: 'CONFIG_BAD_NUMERIC_VALUE',
            label: 'invalid compression (line 2) before boolean (line 3) — compression wins',
          },
        ])('Then $label ($expectedCode)', async ({ config, expectedCode }) => {
          // Arrange
          const ctx = createMemoryContext();
          await seedRepo(ctx);
          await seedConfig(ctx, config);

          // Act
          let caught: unknown;
          try {
            await assertEagerConfigValid(ctx);
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as TsgitError).data.code).toBe(expectedCode);
        });
      });
    });
  });

  describe('assertEagerConfigValid (core.maxTreeDepth)', () => {
    describe('Given core.maxTreeDepth = 2.5', () => {
      describe('When called', () => {
        it('Then throws CONFIG_BAD_NUMERIC_VALUE with reason invalid unit', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seedRepo(ctx);
          await seedConfig(ctx, '[core]\n\tmaxTreeDepth = 2.5\n');

          // Act
          let caught: unknown;
          try {
            await assertEagerConfigValid(ctx);
          } catch (err) {
            caught = err;
          }

          // Assert — the whole payload, each field individually (mutation-resistant)
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data as BadNumericData;
          expect(data.code).toBe('CONFIG_BAD_NUMERIC_VALUE');
          expect(data.key).toBe('core.maxtreedepth');
          expect(data.value).toBe('2.5');
          expect(data.reason).toBe('invalid unit');
        });
      });
    });

    describe('Given core.maxTreeDepth = 2147483648 (past the C int ceiling)', () => {
      describe('When called', () => {
        it('Then throws CONFIG_BAD_NUMERIC_VALUE with reason out of range', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seedRepo(ctx);
          await seedConfig(ctx, '[core]\n\tmaxTreeDepth = 2147483648\n');

          // Act
          let caught: unknown;
          try {
            await assertEagerConfigValid(ctx);
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data as BadNumericData;
          expect(data.code).toBe('CONFIG_BAD_NUMERIC_VALUE');
          expect(data.key).toBe('core.maxtreedepth');
          expect(data.value).toBe('2147483648');
          expect(data.reason).toBe('out of range');
        });
      });
    });

    describe('Given core.maxTreeDepth = 2.5 (an otherwise-clean config)', () => {
      describe('When the porcelain-only assertRepository is called', () => {
        it('Then resolves without throwing (the config porcelain survives)', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seedRepo(ctx);
          await seedConfig(ctx, '[core]\n\tmaxTreeDepth = 2.5\n');

          // Act + Assert — must not throw
          await assertRepository(ctx);
        });
      });

      describe('When configGet and configList are called', () => {
        it('Then both succeed and configGet reads the invalid value back verbatim', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seedRepo(ctx);
          await seedConfig(ctx, '[core]\n\tmaxTreeDepth = 2.5\n');

          // Act
          const got = await configGet(ctx, { key: 'core.maxTreeDepth' });
          let listCaught: unknown;
          try {
            await configList(ctx);
          } catch (err) {
            listCaught = err;
          }

          // Assert
          expect(got.value).toBe('2.5');
          expect(listCaught).toBeUndefined();
        });
      });
    });

    describe('Given core.loosecompression = bogus on an earlier line than core.maxTreeDepth = 2.5', () => {
      describe('When the operational entry point runs', () => {
        it('Then maxTreeDepth wins despite loosecompression sitting on the earlier line', async () => {
          // Arrange — line 2 = loosecompression (invalid), line 3 = maxTreeDepth (invalid)
          const ctx = createMemoryContext();
          await seedRepo(ctx);
          await seedConfig(ctx, '[core]\n\tloosecompression = bogus\n\tmaxTreeDepth = 2.5\n');

          // Act
          let caught: unknown;
          try {
            await assertOperationalRepository(ctx);
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data as BadNumericData;
          expect(data.code).toBe('CONFIG_BAD_NUMERIC_VALUE');
          expect(data.key).toBe('core.maxtreedepth');
          expect(data.value).toBe('2.5');
        });
      });
    });

    describe('Given core.sparseCheckout = bogus on an earlier line than core.maxTreeDepth = 2.5', () => {
      describe('When the operational entry point runs', () => {
        it('Then maxTreeDepth wins despite sparseCheckout sitting on the earlier line', async () => {
          // Arrange — line 2 = sparseCheckout (invalid), line 3 = maxTreeDepth (invalid)
          const ctx = createMemoryContext();
          await seedRepo(ctx);
          await seedConfig(ctx, '[core]\n\tsparseCheckout = bogus\n\tmaxTreeDepth = 2.5\n');

          // Act
          let caught: unknown;
          try {
            await assertOperationalRepository(ctx);
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data as BadNumericData;
          expect(data.code).toBe('CONFIG_BAD_NUMERIC_VALUE');
          expect(data.key).toBe('core.maxtreedepth');
          expect(data.value).toBe('2.5');
        });
      });
    });

    describe('Given maxTreeDepth = 2.5 on line 2 then maxTreeDepth = 2048 on line 3 (invalid-then-valid)', () => {
      describe('When called', () => {
        it('Then resolves without throwing (the effective last-wins value reaches the gate)', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seedRepo(ctx);
          await seedConfig(ctx, '[core]\n\tmaxTreeDepth = 2.5\n\tmaxTreeDepth = 2048\n');

          // Act + Assert — must not throw
          await assertEagerConfigValid(ctx);
        });
      });
    });

    describe('Given maxTreeDepth = 2048 on line 2 then maxTreeDepth = 2.5 on line 3 (valid-then-invalid)', () => {
      describe('When called', () => {
        it('Then throws CONFIG_BAD_NUMERIC_VALUE (the effective last-wins value reaches the gate)', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seedRepo(ctx);
          await seedConfig(ctx, '[core]\n\tmaxTreeDepth = 2048\n\tmaxTreeDepth = 2.5\n');

          // Act
          let caught: unknown;
          try {
            await assertEagerConfigValid(ctx);
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data as BadNumericData;
          expect(data.code).toBe('CONFIG_BAD_NUMERIC_VALUE');
          expect(data.key).toBe('core.maxtreedepth');
          expect(data.value).toBe('2.5');
        });
      });
    });
  });
});

interface BadNumericData {
  readonly code: string;
  readonly key: string;
  readonly value: string;
  readonly reason: string;
}

interface BadZlibData {
  readonly code: string;
  readonly level: number;
}

interface BadBooleanData {
  readonly code: string;
  readonly key: string;
  readonly value: string;
}
