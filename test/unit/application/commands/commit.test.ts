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

  describe('Given a second commit with no index changes', () => {
    describe('When commit (allowEmpty=false)', () => {
      it('Then throws NOTHING_TO_COMMIT', async () => {
        // Arrange
        const ctx = await seed();
        await commit(ctx, { message: 'first', author });

        // Assert
        await expectError(() => commit(ctx, { message: 'second', author }), 'NOTHING_TO_COMMIT');
      });
    });
  });

  describe('Given an empty message + allowEmptyMessage=false', () => {
    describe('When commit', () => {
      it('Then throws EMPTY_COMMIT_MESSAGE', async () => {
        // Arrange
        const ctx = await seed();
        // Assert
        await expectError(
          () => commit(ctx, { message: '   \n   ', author }),
          'EMPTY_COMMIT_MESSAGE',
        );
      });
    });
  });

  describe('Given no author and no config user', () => {
    describe('When commit', () => {
      it('Then throws AUTHOR_UNCONFIGURED', async () => {
        // Arrange
        const ctx = await seed();
        // Assert
        await expectError(() => commit(ctx, { message: 'x' }), 'AUTHOR_UNCONFIGURED');
      });
    });
  });

  describe('Given a non-repo ctx', () => {
    describe('When commit', () => {
      it('Then throws NOT_A_REPOSITORY', async () => {
        // Arrange
        const ctx = createMemoryContext();
        // Assert
        await expectError(() => commit(ctx, { message: 'x', author }), 'NOT_A_REPOSITORY');
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

  describe('Given an empty message with a stray MERGE_MSG but no merge in progress', () => {
    describe('When commit', () => {
      it('Then throws EMPTY_COMMIT_MESSAGE', async () => {
        // Arrange — MERGE_MSG present, but MERGE_HEAD absent → mergeHead is undefined.
        const ctx = await seed();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/MERGE_MSG`, 'should be ignored');

        // Act
        const err = await expectError(
          () => commit(ctx, { message: '', author }),
          'EMPTY_COMMIT_MESSAGE',
        );

        // Assert — kills the ConditionalExpression mutant on `mergeHead === undefined`
        // (false would route to the MERGE_MSG fallback and succeed instead).
        expect(err.data.code).toBe('EMPTY_COMMIT_MESSAGE');
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
  describe('Given a config with valueless user.name and valued user.email', () => {
    describe('When commit without an explicit author', () => {
      it('Then throws CONFIG_MISSING_VALUE with key user.name at line 2', async () => {
        // Arrange
        const ctx = await seed();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[user]\n\tname\n\temail = a@b.c\n');
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
        expect((data as { key: string }).key).toBe('user.name');
        expect((data as { line: number }).line).toBe(2);
        expect((data as { source: string }).source).toMatch(/\/config$/);
      });
    });
  });

  describe('Given a config with valued user.name and valueless user.email', () => {
    describe('When commit without an explicit author', () => {
      it('Then throws CONFIG_MISSING_VALUE with key user.email at line 3', async () => {
        // Arrange
        const ctx = await seed();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[user]\n\tname = Ada\n\temail\n');
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
        expect((data as { key: string }).key).toBe('user.email');
        expect((data as { line: number }).line).toBe(3);
        expect((data as { source: string }).source).toMatch(/\/config$/);
      });
    });
  });

  describe('Given a config with both user.name and user.email valueless, name earlier', () => {
    describe('When commit without an explicit author', () => {
      it('Then throws CONFIG_MISSING_VALUE with key user.name at line 2', async () => {
        // Arrange
        const ctx = await seed();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[user]\n\tname\n\temail\n');
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
        expect((data as { key: string }).key).toBe('user.name');
        expect((data as { line: number }).line).toBe(2);
        expect((data as { source: string }).source).toMatch(/\/config$/);
      });
    });
  });

  describe('Given a config with both user.email and user.name valueless, email earlier', () => {
    describe('When commit without an explicit author', () => {
      it('Then throws CONFIG_MISSING_VALUE with key user.email at line 2 (file-position order)', async () => {
        // Arrange
        const ctx = await seed();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[user]\n\temail\n\tname\n');
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
        expect((data as { key: string }).key).toBe('user.email');
        expect((data as { line: number }).line).toBe(2);
        expect((data as { source: string }).source).toMatch(/\/config$/);
      });
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

describe('commit — valueless core path-like refusal', () => {
  describe('Given a repo with a valueless core.hooksPath and a supplied identity', () => {
    describe('When commit', () => {
      it('Then it throws CONFIG_MISSING_VALUE for core.hookspath', async () => {
        // Arrange
        const ctx = await seed();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[core]\n\thooksPath\n');
        const sut = commit;

        // Act
        let caught: unknown;
        try {
          await sut(ctx, { message: 'm', author });
        } catch (err) {
          caught = err;
        }

        // Assert — each field individually (mutation-resistant)
        const data = (caught as TsgitError).data as {
          code: string;
          key: string;
          line: number;
        };
        expect(data.code).toBe('CONFIG_MISSING_VALUE');
        expect(data.key).toBe('core.hookspath');
        expect(data.line).toBe(2);
      });
    });
  });

  describe('Given a valueless core.hooksPath and no configured identity', () => {
    describe('When commit', () => {
      it('Then the core guard fires before the user-identity guard', async () => {
        // Arrange
        const ctx = await seed();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[core]\n\thooksPath\n');
        const sut = commit;

        // Act — no author supplied, so the identity guard would otherwise fire
        let caught: unknown;
        try {
          await sut(ctx, { message: 'm' });
        } catch (err) {
          caught = err;
        }

        // Assert — core dies first, not AUTHOR_UNCONFIGURED
        const data = (caught as TsgitError).data as { code: string; key: string };
        expect(data.code).toBe('CONFIG_MISSING_VALUE');
        expect(data.key).toBe('core.hookspath');
      });
    });
  });
});

afterEach(() => __resetConfigCacheForTests());
