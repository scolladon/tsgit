import { afterEach, describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { MemoryHookRunner } from '../../../../src/adapters/memory/memory-hook-runner.js';
import { add } from '../../../../src/application/commands/add.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import { __resetConfigCacheForTests } from '../../../../src/application/primitives/config-read.js';
import { readObject } from '../../../../src/application/primitives/read-object.js';
import { readReflog } from '../../../../src/application/primitives/reflog-store.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { TsgitError } from '../../../../src/domain/index.js';
import type { AuthorIdentity, ObjectId, RefName } from '../../../../src/domain/objects/index.js';
import { ObjectId as ObjectIdFactory } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';
import type { HookResult, HookRunner } from '../../../../src/ports/hook-runner.js';
import { stubCommandRunner } from '../primitives/helpers/stub-command-runner.js';

const author: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

const seed = async (workingTree: Readonly<Record<string, string>> = { 'a.txt': 'a' }) => {
  const ctx = createMemoryContext();
  await init(ctx);
  for (const [path, content] of Object.entries(workingTree)) {
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/${path}`, content);
  }
  await add(ctx, Object.keys(workingTree));
  return ctx;
};

const expectError = async (fn: () => Promise<unknown>, code: string): Promise<TsgitError> => {
  let caught: unknown;
  try {
    await fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(TsgitError);
  expect((caught as TsgitError).data.code).toBe(code);
  return caught as TsgitError;
};

describe('commit — cherry-pick resolution', () => {
  const seedCommitted = async (): Promise<{ ctx: Context; base: ObjectId }> => {
    const ctx = await seed({ 'a.txt': 'a\n' });
    const base = await commit(ctx, { message: 'base', author });
    return { ctx, base: base.id };
  };

  describe('Given CHERRY_PICK_HEAD set and an empty message (MERGE_MSG fallback)', () => {
    describe('When commit resolves it', () => {
      it('Then single-parent, comments stripped, state cleared, cherry-pick reflog', async () => {
        // Arrange
        const { ctx, base } = await seedCommitted();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'resolved\n');
        await add(ctx, ['a.txt']);
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/CHERRY_PICK_HEAD`, `${base}\n`);
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/MERGE_MSG`,
          'picked msg\n\n# Conflicts:\n#\ta.txt\n',
        );

        // Act
        const sut = await commit(ctx, { message: '', author });

        // Assert
        expect(sut.parents).toEqual([base]); // CHERRY_PICK_HEAD NOT a second parent
        const data = await readObject(ctx, sut.id);
        if (data.type === 'commit') expect(data.data.message).toBe('picked msg\n');
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/CHERRY_PICK_HEAD`)).toBe(false);
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/MERGE_MSG`)).toBe(false);
        const reflog = await readReflog(ctx, 'refs/heads/main' as RefName);
        expect(reflog.some((e) => e.message === 'commit (cherry-pick): picked msg')).toBe(true);
      });
    });
  });

  describe('Given CHERRY_PICK_HEAD set and an explicit message', () => {
    describe('When commit resolves it', () => {
      it('Then uses the explicit message with a cherry-pick reflog', async () => {
        // Arrange
        const { ctx, base } = await seedCommitted();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'resolved\n');
        await add(ctx, ['a.txt']);
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/CHERRY_PICK_HEAD`, `${base}\n`);

        // Act
        const sut = await commit(ctx, { message: 'explicit', author });

        // Assert
        expect(sut.parents).toEqual([base]);
        const data = await readObject(ctx, sut.id);
        if (data.type === 'commit') expect(data.data.message).toBe('explicit\n');
        const reflog = await readReflog(ctx, 'refs/heads/main' as RefName);
        expect(reflog.some((e) => e.message === 'commit (cherry-pick): explicit')).toBe(true);
      });
    });
  });
});

describe('commit — revert resolution', () => {
  const seedCommitted = async (): Promise<{ ctx: Context; base: ObjectId }> => {
    const ctx = await seed({ 'a.txt': 'a\n' });
    const base = await commit(ctx, { message: 'base', author });
    return { ctx, base: base.id };
  };

  describe('Given REVERT_HEAD set and an empty message (MERGE_MSG fallback)', () => {
    describe('When commit resolves it', () => {
      it('Then single-parent, comments stripped, state cleared, plain `commit:` reflog', async () => {
        // Arrange
        const { ctx, base } = await seedCommitted();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'reverted\n');
        await add(ctx, ['a.txt']);
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/REVERT_HEAD`, `${base}\n`);
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/MERGE_MSG`,
          'Revert "x"\n\n# Conflicts:\n#\ta.txt\n',
        );

        // Act
        const sut = await commit(ctx, { message: '', author });

        // Assert
        expect(sut.parents).toEqual([base]); // REVERT_HEAD NOT a second parent
        const data = await readObject(ctx, sut.id);
        if (data.type === 'commit') expect(data.data.message).toBe('Revert "x"\n');
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/REVERT_HEAD`)).toBe(false);
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/MERGE_MSG`)).toBe(false);
        const reflog = await readReflog(ctx, 'refs/heads/main' as RefName);
        // git writes a plain `commit:` reflog for a resolved revert (not `commit (revert):`).
        expect(reflog.some((e) => e.message === 'commit: Revert "x"')).toBe(true);
        expect(reflog.some((e) => e.message.startsWith('commit (revert)'))).toBe(false);
      });
    });
  });

  describe('Given REVERT_HEAD set and a no-change resolution', () => {
    describe('When commit runs without allowEmpty', () => {
      it('Then refuses with NOTHING_TO_COMMIT and keeps REVERT_HEAD', async () => {
        // Arrange — index still matches HEAD (the revert resolved to nothing).
        const { ctx, base } = await seedCommitted();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/REVERT_HEAD`, `${base}\n`);

        // Act + Assert
        await expectError(
          () => commit(ctx, { message: 'Revert "x"', author }),
          'NOTHING_TO_COMMIT',
        );
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/REVERT_HEAD`)).toBe(true);
      });
    });

    describe('When commit runs with allowEmpty', () => {
      it('Then commits the empty revert and clears REVERT_HEAD', async () => {
        // Arrange
        const { ctx, base } = await seedCommitted();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/REVERT_HEAD`, `${base}\n`);

        // Act
        const sut = await commit(ctx, { message: 'Revert "x"', author, allowEmpty: true });

        // Assert
        expect(sut.parents).toEqual([base]);
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/REVERT_HEAD`)).toBe(false);
      });
    });
  });
});

describe('commit', () => {
  describe('Given a staged file + explicit author', () => {
    describe('When commit', () => {
      it('Then returns id and updates HEAD branch', async () => {
        // Arrange
        const ctx = await seed();

        // Act
        const sut = await commit(ctx, { message: 'first', author });

        // Assert
        expect(sut.id).toMatch(/^[0-9a-f]{40}$/);
        expect(sut.parents).toEqual([]);
        expect(sut.branch).toBe('refs/heads/main');
        const refContent = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/refs/heads/main`);
        expect(refContent.trim()).toBe(sut.id);
      });
    });
  });

  describe('Given a guard condition that must refuse the commit before it writes anything', () => {
    describe('When commit runs', () => {
      it.each([
        {
          label: 'a second commit with no index changes since the last one',
          build: async (): Promise<{ ctx: Context; opts: Parameters<typeof commit>[1] }> => {
            const ctx = await seed();
            await commit(ctx, { message: 'first', author });
            return { ctx, opts: { message: 'second', author } };
          },
          code: 'NOTHING_TO_COMMIT',
        },
        {
          label: 'a whitespace-only message and allowEmptyMessage=false',
          build: async (): Promise<{ ctx: Context; opts: Parameters<typeof commit>[1] }> => ({
            ctx: await seed(),
            opts: { message: '   \n   ', author },
          }),
          code: 'EMPTY_COMMIT_MESSAGE',
        },
        {
          label: 'no author and no config user',
          build: async (): Promise<{ ctx: Context; opts: Parameters<typeof commit>[1] }> => ({
            ctx: await seed(),
            opts: { message: 'x' },
          }),
          code: 'AUTHOR_UNCONFIGURED',
        },
        {
          label: 'a non-repo context',
          build: async (): Promise<{ ctx: Context; opts: Parameters<typeof commit>[1] }> => ({
            ctx: createMemoryContext(),
            opts: { message: 'x', author },
          }),
          code: 'NOT_A_REPOSITORY',
        },
        {
          label: 'an empty message with a stray MERGE_MSG but no MERGE_HEAD',
          build: async (): Promise<{ ctx: Context; opts: Parameters<typeof commit>[1] }> => {
            const ctx = await seed();
            await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/MERGE_MSG`, 'should be ignored');
            return { ctx, opts: { message: '', author } };
          },
          code: 'EMPTY_COMMIT_MESSAGE',
        },
      ])('Then throws $code ($label)', async ({ build, code }) => {
        // Arrange
        const { ctx, opts } = await build();

        // Assert
        await expectError(() => commit(ctx, opts), code);
      });
    });
  });

  describe('Given allowEmpty=true', () => {
    describe('When commit on unchanged tree', () => {
      it('Then succeeds with the same tree', async () => {
        // Arrange
        const ctx = await seed();
        const first = await commit(ctx, { message: 'first', author });

        // Act — same tree, allowEmpty=true means the empty-commit guard is skipped.
        const sut = await commit(ctx, { message: 'second', author, allowEmpty: true });

        // Assert — both commits share the tree but produce distinct ids (different message).
        expect(sut.tree).toBe(first.tree);
        expect(sut.id).not.toBe(first.id);
        expect(sut.parents).toEqual([first.id]);
      });
    });
  });

  describe('Given a bare repo', () => {
    describe('When commit', () => {
      it('Then throws BARE_REPOSITORY tagged with operation "commit"', async () => {
        // Arrange — flip core.bare before any config read caches the empty config.
        const ctx = await seed();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[core]\n  bare = true\n');
        __resetConfigCacheForTests();

        // Act
        const err = await expectError(
          () => commit(ctx, { message: 'x', author }),
          'BARE_REPOSITORY',
        );

        // Assert — kills the StringLiteral mutant on assertNotBare(ctx, 'commit').
        expect(err.data).toMatchObject({ code: 'BARE_REPOSITORY', operation: 'commit' });
      });
    });
  });

  describe('Given a present but empty MERGE_HEAD marker', () => {
    describe('When commit', () => {
      it('Then throws OPERATION_IN_PROGRESS for merge', async () => {
        // Arrange — empty file: readMergeHead → undefined, yet the marker file
        // still exists, so assertNoPendingOperation must NOT except 'merge'.
        const ctx = await seed();
        await commit(ctx, { message: 'first', author });
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/MERGE_HEAD`, '');

        // Act
        const err = await expectError(
          () => commit(ctx, { message: 'second', author }),
          'OPERATION_IN_PROGRESS',
        );

        // Assert — kills the ConditionalExpression mutant that always excepts 'merge'.
        expect(err.data).toMatchObject({ code: 'OPERATION_IN_PROGRESS', operation: 'merge' });
      });
    });
  });

  describe('Given a real merge resolution with an unchanged tree', () => {
    describe('When commit', () => {
      it('Then succeeds as a two-parent commit', async () => {
        // Arrange — first commit, then a populated MERGE_HEAD; the index is unchanged
        // so the tree equals HEAD's tree.
        const ctx = await seed();
        const first = await commit(ctx, { message: 'first', author });
        const mergeHead = ObjectIdFactory.from('1'.repeat(40));
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/MERGE_HEAD`, `${mergeHead}\n`);

        // Act — the tree-equality guard must be skipped during a merge resolution.
        const sut = await commit(ctx, { message: 'merge resolved', author });

        // Assert — kills the ConditionalExpression mutant flipping `mergeHead === undefined`
        // to `true` (which would re-enable the guard and throw NOTHING_TO_COMMIT).
        expect(sut.tree).toBe(first.tree);
        expect(sut.parents).toEqual([first.id, mergeHead]);
      });
    });
  });

  describe('Given a merge resolution', () => {
    describe('When commit', () => {
      it('Then the branch reflog entry message is "commit (merge): <subject>"', async () => {
        // Arrange — first commit, then a populated MERGE_HEAD so the commit resolves
        // a merge. The reflog message must carry the `commit (merge):` catalogue
        // prefix, not the plain `commit:` prefix and not an empty string.
        const ctx = await seed();
        await commit(ctx, { message: 'first', author });
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/MERGE_HEAD`, `${'1'.repeat(40)}\n`);

        // Act
        await commit(ctx, { message: 'resolve the merge', author });

        // Assert
        const { readReflog } = await import(
          '../../../../src/application/primitives/reflog-store.js'
        );
        const entries = await readReflog(ctx, 'refs/heads/main' as RefName);
        expect(entries[entries.length - 1]?.message).toBe('commit (merge): resolve the merge');
      });
    });
  });

  describe('Given a non-empty user message during a merge resolution', () => {
    describe('When commit', () => {
      it('Then the explicit message wins over MERGE_MSG', async () => {
        // Arrange — both an explicit message and a MERGE_MSG draft are available.
        const ctx = await seed();
        await commit(ctx, { message: 'first', author });
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/MERGE_HEAD`, `${'1'.repeat(40)}\n`);
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/MERGE_MSG`, 'draft from merge');
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'changed');
        await add(ctx, ['a.txt']);

        // Act
        const sut = await commit(ctx, { message: 'explicit message', author });

        // Assert — kills the LogicalOperator mutant (`||` → `&&`) in resolveCommitMessage.
        const obj = await readObject(ctx, sut.id);
        if (obj.type !== 'commit') throw new Error('expected a commit object');
        expect(obj.data.message).toBe('explicit message\n');
      });
    });
  });

  describe('Given a normal commit', () => {
    describe('When commit', () => {
      it('Then the stored message is the user message', async () => {
        // Arrange
        const ctx = await seed();

        // Act
        const sut = await commit(ctx, { message: 'plain message', author });

        // Assert — kills the ConditionalExpression mutant flipping the
        // resolveCommitMessage guard to `false` (which would route to MERGE_MSG).
        const obj = await readObject(ctx, sut.id);
        if (obj.type !== 'commit') throw new Error('expected a commit object');
        expect(obj.data.message).toBe('plain message\n');
      });
    });
  });

  describe('Given a detached HEAD', () => {
    describe('When commit', () => {
      it('Then HEAD is rewritten in place to the new commit id', async () => {
        // Arrange — first commit, then detach HEAD onto that commit id.
        const ctx = await seed();
        const first = await commit(ctx, { message: 'first', author });
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, `${first.id}\n`);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'changed');
        await add(ctx, ['a.txt']);

        // Act
        const sut = await commit(ctx, { message: 'detached', author });

        // Assert — kills the BlockStatement + StringLiteral mutants on the
        // detached-HEAD write: HEAD file content must be exactly `${id}\n`.
        expect(sut.branch).toBeUndefined();
        expect(sut.parents).toEqual([first.id]);
        const headContent = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/HEAD`);
        expect(headContent).toBe(`${sut.id}\n`);
      });
    });
  });

  describe('Given a config [user] and no explicit author', () => {
    describe('When commit', () => {
      it('Then the author uses second-granularity timestamp and +0000 offset', async () => {
        // Arrange — only the config user identity is available.
        const ctx = await seed();
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/config`,
          '[user]\n  name = Grace\n  email = grace@example.com\n',
        );
        __resetConfigCacheForTests();
        const before = Math.floor(Date.now() / 1000);

        // Act
        const sut = await commit(ctx, { message: 'configured' });

        // Assert — kills the ArithmeticOperator (`/` → `*`) and StringLiteral
        // (`+0000` → ``) mutants in toAuthor.
        const obj = await readObject(ctx, sut.id);
        if (obj.type !== 'commit') throw new Error('expected a commit object');
        const after = Math.ceil(Date.now() / 1000);
        expect(obj.data.author.name).toBe('Grace');
        expect(obj.data.author.timestamp).toBeGreaterThanOrEqual(before);
        expect(obj.data.author.timestamp).toBeLessThanOrEqual(after);
        expect(obj.data.author.timezoneOffset).toBe('+0000');
      });
    });
  });

  describe('Given a stray MERGE_MSG but no merge in progress', () => {
    describe('When commit succeeds', () => {
      it('Then merge state is left untouched', async () => {
        // Arrange — a stray MERGE_MSG with no MERGE_HEAD: mergeHead resolves to
        // undefined, so the resolving commit must NOT clear merge state.
        const ctx = await seed();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/MERGE_MSG`, 'leftover draft');

        // Act
        await commit(ctx, { message: 'normal commit', author });

        // Assert — kills the ConditionalExpression mutant flipping `mergeHead !==
        // undefined` to `true` (which would unconditionally clear merge state).
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/MERGE_MSG`)).toBe(true);
      });
    });
  });

  describe('Given a real merge resolution', () => {
    describe('When commit succeeds', () => {
      it('Then MERGE_HEAD and MERGE_MSG are cleared', async () => {
        // Arrange
        const ctx = await seed();
        await commit(ctx, { message: 'first', author });
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/MERGE_HEAD`, `${'1'.repeat(40)}\n`);
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/MERGE_MSG`, 'merge draft');
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'changed');
        await add(ctx, ['a.txt']);

        // Act
        await commit(ctx, { message: 'resolved', author });

        // Assert — the merge-state clear path actually runs and removes the markers.
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/MERGE_HEAD`)).toBe(false);
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/MERGE_MSG`)).toBe(false);
      });
    });
  });

  describe('Given a detached HEAD pointing at a non-commit object', () => {
    describe('When commit', () => {
      it('Then the parent-tree falls back to the zero oid and the commit succeeds', async () => {
        // Arrange — detach HEAD onto a blob; getParentTree must return a zero oid
        // for the non-commit parent rather than constructing an empty id.
        const ctx = await seed();
        await commit(ctx, { message: 'first', author });
        const blobId = (await writeObject(ctx, {
          type: 'blob',
          id: '' as ObjectId,
          content: new TextEncoder().encode('not a commit'),
        })) as ObjectId;
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, `${blobId}\n`);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'changed');
        await add(ctx, ['a.txt']);

        // Act
        const sut = await commit(ctx, { message: 'orphan parent', author });

        // Assert — kills the StringLiteral mutant `'0'.repeat(40)` → `''`, which
        // would make ObjectId.from throw INVALID_OBJECT_ID instead of returning.
        expect(sut.id).toMatch(/^[0-9a-f]{40}$/);
        expect(sut.parents).toEqual([blobId]);
      });
    });
  });
});

describe('commit — valueless identity refusal', () => {
  describe('Given a config with a valueless user.name and/or user.email', () => {
    describe('When commit runs without an explicit author', () => {
      it.each([
        {
          label: 'valueless user.name, valued user.email',
          configText: '[user]\n\tname\n\temail = a@b.c\n',
          key: 'user.name',
          line: 2,
        },
        {
          label: 'valued user.name, valueless user.email',
          configText: '[user]\n\tname = Ada\n\temail\n',
          key: 'user.email',
          line: 3,
        },
        {
          label: 'both valueless, name earlier',
          configText: '[user]\n\tname\n\temail\n',
          key: 'user.name',
          line: 2,
        },
        {
          label: 'both valueless, email earlier (file-position order)',
          configText: '[user]\n\temail\n\tname\n',
          key: 'user.email',
          line: 2,
        },
      ])(
        'Then throws CONFIG_MISSING_VALUE with key $key at line $line ($label)',
        async ({ configText, key, line }) => {
          // Arrange
          const ctx = await seed();
          await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, configText);
          __resetConfigCacheForTests();

          // Act
          let caught: unknown;
          try {
            await commit(ctx, { message: 'x' });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data;
          expect(data.code).toBe('CONFIG_MISSING_VALUE');
          expect((data as { key: string }).key).toBe(key);
          expect((data as { line: number }).line).toBe(line);
          expect((data as { source: string }).source).toMatch(/\/config$/);
        },
      );
    });
  });

  describe('Given no [user] section (absent)', () => {
    describe('When commit without an explicit author', () => {
      it('Then throws AUTHOR_UNCONFIGURED and NOT CONFIG_MISSING_VALUE', async () => {
        // Arrange
        const ctx = await seed();

        // Act
        let caught: unknown;
        try {
          await commit(ctx, { message: 'x' });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data;
        expect(data.code).toBe('AUTHOR_UNCONFIGURED');
        expect(data.code).not.toBe('CONFIG_MISSING_VALUE');
      });
    });
  });

  describe('Given a config with valueless user.name and an explicit opts.author', () => {
    describe('When commit with an explicit author', () => {
      it('Then succeeds without refusing (guard is opts.author === undefined)', async () => {
        // Arrange
        const ctx = await seed();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[user]\n\tname\n');
        __resetConfigCacheForTests();

        // Act
        const result = await commit(ctx, { message: 'x', author });

        // Assert
        expect(result.id).toMatch(/^[0-9a-f]{40}$/);
      });
    });
  });
});

describe('commit — hooks', () => {
  const hookedCtx = (
    over: {
      readonly preCommit?: HookResult;
      readonly commitMsg?: HookResult;
      readonly commitMsgRewrite?: string;
    } = {},
  ): Context => {
    let ctx!: Context;
    const runner: HookRunner = {
      run: async (request) => {
        if (request.name === 'pre-commit' && over.preCommit !== undefined) return over.preCommit;
        if (request.name === 'commit-msg') {
          if (over.commitMsgRewrite !== undefined) {
            await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/COMMIT_EDITMSG`, over.commitMsgRewrite);
          }
          if (over.commitMsg !== undefined) return over.commitMsg;
        }
        return { kind: 'ran', exitCode: 0, stdout: '', stderr: '' };
      },
    };
    ctx = createMemoryContext({ hooks: runner });
    return ctx;
  };

  const seedHooked = async (ctx: Context): Promise<Context> => {
    await init(ctx);
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
    await add(ctx, ['a.txt']);
    return ctx;
  };

  describe('Given a pre-commit hook that exits non-zero', () => {
    describe('When commit', () => {
      it('Then it throws HOOK_FAILED and writes no commit', async () => {
        // Arrange
        const ctx = await seedHooked(
          hookedCtx({ preCommit: { kind: 'ran', exitCode: 1, stdout: '', stderr: 'lint failed' } }),
        );

        // Act
        await expectError(() => commit(ctx, { message: 'first', author }), 'HOOK_FAILED');

        // Assert — aborted before the branch ref was created.
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/refs/heads/main`)).toBe(false);
      });
    });
  });

  describe('Given a commit-msg hook that rewrites the message', () => {
    describe('When commit', () => {
      it('Then the commit uses the rewritten message', async () => {
        // Arrange
        const ctx = await seedHooked(hookedCtx({ commitMsgRewrite: 'rewritten subject' }));

        // Act
        const sut = await commit(ctx, { message: 'original', author });

        // Assert
        const obj = await readObject(ctx, sut.id);
        expect(obj.type).toBe('commit');
        if (obj.type === 'commit') {
          expect(obj.data.message).toBe('rewritten subject\n');
        }
      });
    });
  });

  describe('Given failing hooks but noVerify true', () => {
    describe('When commit', () => {
      it('Then it succeeds with hooks skipped', async () => {
        // Arrange
        const ctx = await seedHooked(
          hookedCtx({
            preCommit: { kind: 'ran', exitCode: 1, stdout: '', stderr: 'x' },
            commitMsg: { kind: 'ran', exitCode: 1, stdout: '', stderr: 'y' },
          }),
        );

        // Act
        const sut = await commit(ctx, { message: 'first', author, noVerify: true });

        // Assert
        expect(sut.id).toMatch(/^[0-9a-f]{40}$/);
      });
    });
  });

  describe('Given a commit-msg hook that empties the message and no allowEmptyMessage', () => {
    describe('When commit', () => {
      it('Then it throws EMPTY_COMMIT_MESSAGE', async () => {
        // Arrange — the hook blanks COMMIT_EDITMSG; the re-sanitise must reject it.
        const ctx = await seedHooked(hookedCtx({ commitMsgRewrite: '   ' }));

        // Act & Assert
        await expectError(
          () => commit(ctx, { message: 'original', author }),
          'EMPTY_COMMIT_MESSAGE',
        );
      });
    });
  });

  describe('Given a normal commit', () => {
    describe('When commit fires prepare-commit-msg', () => {
      it('Then the message source argument is "message"', async () => {
        // Arrange
        const runner = new MemoryHookRunner();
        const ctx = createMemoryContext({ hooks: runner });
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
        await add(ctx, ['a.txt']);

        // Act
        await commit(ctx, { message: 'first', author });

        // Assert
        const prepare = runner.calls.find((c) => c.name === 'prepare-commit-msg');
        expect(prepare?.args[1]).toBe('message');
      });
    });
  });

  describe('Given a merge resolution commit', () => {
    describe('When commit fires prepare-commit-msg', () => {
      it('Then the message source argument is "merge"', async () => {
        // Arrange — a populated MERGE_HEAD makes this a merge resolution.
        const runner = new MemoryHookRunner();
        const ctx = createMemoryContext({ hooks: runner });
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
        await add(ctx, ['a.txt']);
        await commit(ctx, { message: 'first', author });
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/MERGE_HEAD`, `${'1'.repeat(40)}\n`);

        // Act
        await commit(ctx, { message: 'resolve', author });

        // Assert
        const prepares = runner.calls.filter((c) => c.name === 'prepare-commit-msg');
        expect(prepares[prepares.length - 1]?.args[1]).toBe('merge');
      });
    });
  });
});

describe('commit — signing', () => {
  // Signers (gpg, ssh-keygen) terminate their armor block with a trailing
  // newline; git's own header encoding treats that as the last line's
  // terminator, not as an extra blank continuation line, so the stored
  // gpgSignature is the armor with that one trailing newline stripped.
  const armor = () =>
    '-----BEGIN PGP SIGNATURE-----\n\nZmFrZXNpZw==\n-----END PGP SIGNATURE-----\n';
  const signedArmor = () => armor().slice(0, -1);

  const seedSigning = async (
    command?: ReturnType<typeof stubCommandRunner>,
    configText?: string,
  ): Promise<Context> => {
    const ctx = createMemoryContext(command !== undefined ? { command } : {});
    await init(ctx);
    if (configText !== undefined) {
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, configText);
    }
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
    await add(ctx, ['a.txt']);
    return ctx;
  };

  const branchRefPath = (ctx: Context): string => `${ctx.layout.gitDir}/refs/heads/main`;

  describe('Given opts.sign is true and the signer succeeds', () => {
    describe('When commit is called', () => {
      it('Then the commit object carries the returned armor as gpgSignature', async () => {
        // Arrange
        const runner = stubCommandRunner({ stdout: new TextEncoder().encode(armor()) });
        const ctx = await seedSigning(runner);

        // Act
        const result = await commit(ctx, { message: 'm', author, sign: true });

        // Assert
        const stored = await readObject(ctx, result.id);
        if (stored.type !== 'commit') throw new Error('expected a commit object');
        expect(stored.data.gpgSignature).toBe(signedArmor());
      });
    });
  });

  describe('Given the signer returns armor with no trailing newline', () => {
    describe('When commit stores the signature', () => {
      it('Then the armor is stored verbatim — the strip only fires on a real trailing newline', async () => {
        // Arrange — signedArmor() already ends at `-----` with no trailing newline.
        const runner = stubCommandRunner({ stdout: new TextEncoder().encode(signedArmor()) });
        const ctx = await seedSigning(runner);

        // Act
        const result = await commit(ctx, { message: 'm', author, sign: true });

        // Assert — the false branch keeps the armor's last byte; the endsWith('\n')
        // literal must not degrade to endsWith('') (always true → drops a real byte).
        const stored = await readObject(ctx, result.id);
        if (stored.type !== 'commit') throw new Error('expected a commit object');
        expect(stored.data.gpgSignature).toBe(signedArmor());
      });
    });
  });

  describe('Given opts.sign is true', () => {
    describe('When commit signs', () => {
      it('Then the signer receives the unsigned payload on stdin with no gpgsig header', async () => {
        // Arrange
        const runner = stubCommandRunner({ stdout: new TextEncoder().encode(armor()) });
        const ctx = await seedSigning(runner);

        // Act
        await commit(ctx, { message: 'payload check', author, sign: true });

        // Assert
        expect(runner.calls).toHaveLength(1);
        const stdin = new TextDecoder().decode(runner.calls[0]?.stdin);
        expect(stdin).toContain('payload check');
        expect(stdin).not.toContain('gpgsig');
      });
    });
  });

  describe('Given commit.gpgsign=true in config and opts.sign is undefined', () => {
    describe('When commit is called', () => {
      it('Then it signs — the config default applies', async () => {
        // Arrange
        const runner = stubCommandRunner({ stdout: new TextEncoder().encode(armor()) });
        const ctx = await seedSigning(runner, '[commit]\n\tgpgSign = true\n');

        // Act
        const result = await commit(ctx, { message: 'm', author });

        // Assert
        const stored = await readObject(ctx, result.id);
        if (stored.type !== 'commit') throw new Error('expected a commit object');
        expect(stored.data.gpgSignature).toBe(signedArmor());
      });
    });
  });

  describe('Given commit.gpgsign=true in config and opts.sign is explicitly false', () => {
    describe('When commit is called', () => {
      it('Then it does not sign — the explicit false overrides the config default', async () => {
        // Arrange
        const runner = stubCommandRunner({ stdout: new TextEncoder().encode(armor()) });
        const ctx = await seedSigning(runner, '[commit]\n\tgpgSign = true\n');

        // Act
        const result = await commit(ctx, { message: 'm', author, sign: false });

        // Assert
        expect(runner.calls).toHaveLength(0);
        const stored = await readObject(ctx, result.id);
        if (stored.type !== 'commit') throw new Error('expected a commit object');
        expect(stored.data.gpgSignature).toBeUndefined();
      });
    });
  });

  describe('Given opts.signKey overrides a configured user.signingKey', () => {
    describe('When commit signs', () => {
      it('Then the signer invocation uses the override key, not the configured one', async () => {
        // Arrange
        const runner = stubCommandRunner({ stdout: new TextEncoder().encode(armor()) });
        const ctx = await seedSigning(runner, '[user]\n\tsigningKey = DEFAULTKEY\n');

        // Act
        await commit(ctx, { message: 'm', author, sign: true, signKey: 'OVERRIDEKEY' });

        // Assert
        const invoked = runner.calls[0]?.command ?? '';
        expect(invoked).toContain('OVERRIDEKEY');
        expect(invoked).not.toContain('DEFAULTKEY');
      });
    });
  });

  describe('Given the signer exits non-zero', () => {
    describe('When commit is called with sign: true', () => {
      it('Then it throws SIGNING_FAILED with reason signer-failed and writes nothing', async () => {
        // Arrange
        const runner = stubCommandRunner({ exitCode: 1 });
        const ctx = await seedSigning(runner);

        // Act
        let caught: unknown;
        try {
          await commit(ctx, { message: 'm', author, sign: true });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const error = caught as TsgitError;
        expect(error.data).toEqual({
          code: 'SIGNING_FAILED',
          reason: 'signer-failed',
          format: 'openpgp',
        });
        expect(await ctx.fs.exists(branchRefPath(ctx))).toBe(false);
      });
    });
  });

  describe('Given a context with no CommandRunner (off-node)', () => {
    describe('When commit is called with sign: true', () => {
      it('Then it throws SIGNING_FAILED with reason off-node and writes nothing', async () => {
        // Arrange
        const ctx = await seedSigning(undefined);

        // Act
        let caught: unknown;
        try {
          await commit(ctx, { message: 'm', author, sign: true });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const error = caught as TsgitError;
        expect(error.data).toEqual({ code: 'SIGNING_FAILED', reason: 'off-node' });
        expect(await ctx.fs.exists(branchRefPath(ctx))).toBe(false);
      });
    });
  });

  afterEach(() => __resetConfigCacheForTests());
});

afterEach(() => __resetConfigCacheForTests());
