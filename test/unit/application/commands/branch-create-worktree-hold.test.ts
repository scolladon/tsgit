/**
 * `branch -f`'s worktree guard, in git's own order.
 *
 * `validate_new_branchname` asks whether the name already names a ref BEFORE
 * it asks whether a worktree holds it: a forced rewrite of a checked-out
 * branch refuses, while creating the unborn branch the current HEAD merely
 * names succeeds — that name holds no ref yet, so the worktree table is
 * never consulted (measured, git 2.55.0).
 */
import { describe, expect, it } from 'vitest';

import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { branchCreate } from '../../../../src/application/commands/branch.js';
import { init } from '../../../../src/application/commands/init.js';
import { getRefStore } from '../../../../src/application/primitives/ref-store.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { writeSymbolicRef } from '../../../../src/application/primitives/write-symbolic-ref.js';
import { TsgitError } from '../../../../src/domain/index.js';
import type { AuthorIdentity, ObjectId, RefName } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';

const author: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

const MAIN = 'refs/heads/main' as RefName;
const UNBORN = 'refs/heads/unborn' as RefName;

interface Seeded {
  readonly ctx: Context;
  /** The root commit — where `main` stands. */
  readonly root: ObjectId;
  /** A second commit, off any branch. */
  readonly next: ObjectId;
}

const seed = async (): Promise<Seeded> => {
  const ctx = createMemoryContext();
  await init(ctx);
  const tree = await writeObject(ctx, { type: 'tree', id: '' as ObjectId, entries: [] });
  const root = await writeObject(ctx, {
    type: 'commit',
    id: '' as ObjectId,
    data: { tree, parents: [], author, committer: author, message: 'root', extraHeaders: [] },
  });
  const next = await writeObject(ctx, {
    type: 'commit',
    id: '' as ObjectId,
    data: { tree, parents: [root], author, committer: author, message: 'next', extraHeaders: [] },
  });
  await getRefStore(ctx).applyRefUpdates([
    { kind: 'setSymbolic', name: 'HEAD' as RefName, target: MAIN },
    { kind: 'set', name: MAIN, id: root },
  ]);
  return { ctx, root, next };
};

describe('branchCreate — the worktree guard', () => {
  describe('Given an existing branch the current worktree holds', () => {
    describe('When branch create runs with force', () => {
      it('Then it refuses BRANCH_CHECKED_OUT and the branch keeps its tip', async () => {
        // Arrange
        const { ctx, root, next } = await seed();
        const sut = branchCreate;

        // Act
        let caught: unknown;
        try {
          await sut(ctx, { name: 'main', force: true, startPoint: next });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data).toEqual({
          code: 'BRANCH_CHECKED_OUT',
          branch: MAIN,
          path: ctx.layout.workDir,
        });
        expect(await getRefStore(ctx).resolveDirect(MAIN)).toEqual({ kind: 'direct', id: root });
      });
    });
  });

  describe('Given the unborn branch the current worktree HEAD merely names', () => {
    describe('When branch create runs with force', () => {
      it('Then the worktree is never consulted and the branch is created', async () => {
        // Arrange
        const { ctx, root } = await seed();
        await writeSymbolicRef(ctx, 'HEAD' as RefName, UNBORN);
        const sut = branchCreate;

        // Act
        const result = await sut(ctx, { name: 'unborn', force: true, startPoint: 'main' });

        // Assert
        expect(result).toEqual({ name: UNBORN, id: root });
        expect(await getRefStore(ctx).resolveDirect(UNBORN)).toEqual({ kind: 'direct', id: root });
      });
    });
  });
});
