/**
 * Renaming onto a destination that exists on disk but cannot be read.
 *
 * git's `refs_rename_ref` deletes the destination rather than locking it, so a
 * broken destination is renamed over rather than refused. Measured against git
 * 2.55.0 with a scrubbed environment: `git branch -m src dst` across a `dst`
 * holding `garbage\n` exits 0 and renames, while `git branch dst main` over the
 * same ref refuses `cannot lock ref … reference broken` — the refusal belongs
 * to create, not to rename.
 *
 * Files backend only: a broken ref is a malformed loose file, which the
 * reftable backend has no equivalent of.
 */
import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { branchCreate, branchRename } from '../../../../src/application/commands/branch.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import { getRefStore } from '../../../../src/application/primitives/ref-store.js';
import { writeSymbolicRef } from '../../../../src/application/primitives/write-symbolic-ref.js';
import type { AuthorIdentity, ObjectId, RefName } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';

const HEADS = 'refs/heads/';
const AUTHOR: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

const seedWithBrokenDestination = async (): Promise<{
  readonly ctx: Context;
  readonly id: ObjectId;
}> => {
  const ctx = createMemoryContext();
  await init(ctx);
  await writeSymbolicRef(ctx, 'HEAD' as RefName, `${HEADS}main` as RefName);
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
  await add(ctx, ['a.txt']);
  const { id } = await commit(ctx, { message: 'seed', author: AUTHOR });
  await branchCreate(ctx, { name: 'src' });
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/${HEADS}dst`, 'garbage\n');
  return { ctx, id };
};

describe('branchRename', () => {
  describe('Given a destination branch whose loose ref holds unreadable content', () => {
    describe('When branchRename runs unforced', () => {
      it('Then the rename succeeds and the destination carries the source tip', async () => {
        // Arrange
        const { ctx, id } = await seedWithBrokenDestination();
        const sut = branchRename;

        // Act
        await sut(ctx, { from: 'src', to: 'dst' });

        // Assert
        expect(await getRefStore(ctx).resolveDirect(`${HEADS}dst` as RefName)).toEqual({
          kind: 'direct',
          id,
        });
      });

      it('Then the source branch is gone', async () => {
        // Arrange
        const { ctx } = await seedWithBrokenDestination();
        const sut = branchRename;

        // Act
        await sut(ctx, { from: 'src', to: 'dst' });

        // Assert
        expect(await getRefStore(ctx).listRefNames(HEADS as RefName)).not.toContain(`${HEADS}src`);
      });
    });
  });

  describe('Given a destination branch that resolves', () => {
    describe('When branchRename runs unforced', () => {
      it('Then it still refuses BRANCH_EXISTS, as git does', async () => {
        // Arrange
        const { ctx } = await seedWithBrokenDestination();
        await branchCreate(ctx, { name: 'live' });
        const sut = branchRename;

        // Act
        const act = async (): Promise<void> => {
          await sut(ctx, { from: 'src', to: 'live' });
        };

        // Assert
        try {
          await act();
          expect.unreachable();
        } catch (error) {
          expect((error as { data: { code: string; name: string } }).data.code).toBe(
            'BRANCH_EXISTS',
          );
        }
      });
    });
  });
});
