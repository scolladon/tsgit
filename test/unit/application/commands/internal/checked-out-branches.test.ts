import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../../src/application/commands/add.js';
import { commit } from '../../../../../src/application/commands/commit.js';
import { init } from '../../../../../src/application/commands/init.js';
import { worktreeHolding } from '../../../../../src/application/commands/internal/checked-out-branches.js';
import { updateRef } from '../../../../../src/application/primitives/update-ref.js';
import { writeSymbolicRef } from '../../../../../src/application/primitives/write-symbolic-ref.js';
import type { AuthorIdentity, ObjectId, RefName } from '../../../../../src/domain/objects/index.js';
import type { Context } from '../../../../../src/ports/context.js';

const SIDECAR = 'refs/heads/sidecar' as RefName;

const AUTHOR: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

const sut = worktreeHolding;

/** A repository holding one commit, with `sidecar` pointing at it. */
const seedRepo = async (): Promise<{ ctx: Context; head: ObjectId }> => {
  const ctx = createMemoryContext();
  await init(ctx);
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
  await add(ctx, ['a.txt']);
  const head = (await commit(ctx, { message: 'first', author: AUTHOR })).id;
  await updateRef(ctx, SIDECAR, head, { reflogMessage: 'seed' });
  return { ctx, head };
};

/** A repository whose single (main) worktree has a detached HEAD, so nothing
 *  but the state files below can make it hold a branch. */
const seedDetachedRepo = async (): Promise<Context> => {
  const { ctx, head } = await seedRepo();
  await updateRef(ctx, 'HEAD' as RefName, head, { reflogMessage: 'detach', noDeref: true });
  return ctx;
};

const writeState = (ctx: Context, relative: string, body: string): Promise<void> =>
  ctx.fs.writeUtf8(`${ctx.layout.gitDir}/${relative}`, body);

describe('worktreeHolding', () => {
  describe('Given a detached worktree with no rebase or bisect state', () => {
    describe('When the branch is looked up', () => {
      it('Then no worktree holds it', async () => {
        // Arrange
        const ctx = await seedDetachedRepo();

        // Act
        const result = await sut(ctx, SIDECAR);

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe('Given a detached worktree mid-rebase under the merge backend', () => {
    describe('When the branch its head-name records is looked up', () => {
      it('Then that worktree holds it', async () => {
        // Arrange
        const ctx = await seedDetachedRepo();
        await writeState(ctx, 'rebase-merge/head-name', `${SIDECAR}\n`);

        // Act
        const result = await sut(ctx, SIDECAR);

        // Assert
        expect(result).toBe(ctx.layout.workDir);
      });
    });
  });

  describe('Given a detached worktree mid-rebase under the apply backend', () => {
    describe('When the branch its head-name records is looked up', () => {
      it('Then that worktree holds it, and rebase-merge is never consulted', async () => {
        // Arrange
        const ctx = await seedDetachedRepo();
        await writeState(ctx, 'rebase-apply/head-name', `${SIDECAR}\n`);
        await writeState(ctx, 'rebase-merge/head-name', 'refs/heads/other\n');

        // Act
        const held = await sut(ctx, SIDECAR);
        const shadowed = await sut(ctx, 'refs/heads/other' as RefName);

        // Assert
        expect(held).toBe(ctx.layout.workDir);
        expect(shadowed).toBeUndefined();
      });
    });
  });

  describe('Given an am in progress under the same rebase-apply directory', () => {
    describe('When a branch is looked up', () => {
      it('Then it holds nothing — an am records no branch of its own', async () => {
        // Arrange
        const ctx = await seedDetachedRepo();
        await writeState(ctx, 'rebase-apply/applying', '');
        await writeState(ctx, 'rebase-apply/head-name', `${SIDECAR}\n`);

        // Act
        const result = await sut(ctx, SIDECAR);

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe('Given a rebase started from a detached HEAD', () => {
    describe.each([
      { body: 'detached HEAD\n', label: "git's detached-HEAD literal" },
      { body: '\n', label: 'an empty head-name' },
    ])('When head-name holds $label', (row) => {
      it('Then it names no branch at all', async () => {
        // Arrange
        const ctx = await seedDetachedRepo();
        await writeState(ctx, 'rebase-merge/head-name', row.body);

        // Act
        const result = await sut(ctx, SIDECAR);

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe('Given a head-name recording a short branch name without its prefix', () => {
    describe('When the full branch name is looked up', () => {
      it('Then the prefix is composed back on and the worktree holds it', async () => {
        // Arrange
        const ctx = await seedDetachedRepo();
        await writeState(ctx, 'rebase-merge/head-name', 'sidecar\n');

        // Act
        const result = await sut(ctx, SIDECAR);

        // Assert
        expect(result).toBe(ctx.layout.workDir);
      });
    });
  });

  describe('Given a bisect in progress', () => {
    describe('When the branch BISECT_START records is looked up', () => {
      it('Then that worktree holds it', async () => {
        // Arrange
        const ctx = await seedDetachedRepo();
        await writeState(ctx, 'BISECT_LOG', 'git bisect start\n');
        await writeState(ctx, 'BISECT_START', 'sidecar\n');

        // Act
        const result = await sut(ctx, SIDECAR);

        // Assert
        expect(result).toBe(ctx.layout.workDir);
      });
    });
  });

  describe('Given a BISECT_START left behind with no BISECT_LOG beside it', () => {
    describe('When the branch it names is looked up', () => {
      it('Then it holds nothing — the log is the gate', async () => {
        // Arrange
        const ctx = await seedDetachedRepo();
        await writeState(ctx, 'BISECT_START', 'sidecar\n');

        // Act
        const result = await sut(ctx, SIDECAR);

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe('Given a bare main checkout carrying rebase state', () => {
    describe('When the branch that state names is looked up', () => {
      it('Then it holds nothing — a bare checkout is skipped outright', async () => {
        // Arrange
        const { ctx: base } = await seedRepo();
        const ctx: Context = { ...base, layout: { ...base.layout, bare: true } };
        await writeState(ctx, 'rebase-merge/head-name', `${SIDECAR}\n`);

        // Act
        const result = await sut(ctx, SIDECAR);

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe('Given a worktree whose HEAD names the branch directly', () => {
    describe('When the branch is looked up', () => {
      it('Then that worktree holds it without any state file', async () => {
        // Arrange
        const { ctx } = await seedRepo();
        await writeSymbolicRef(ctx, 'HEAD' as RefName, SIDECAR);

        // Act
        const result = await sut(ctx, SIDECAR);

        // Assert
        expect(result).toBe(ctx.layout.workDir);
      });
    });
  });
});
