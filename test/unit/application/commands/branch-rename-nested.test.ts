/**
 * Renaming a branch onto a name nested under it, or onto the name it is
 * nested under. git takes the source out of the way first — its log aside,
 * the ref deleted — and only then creates the destination, so both directions
 * succeed on either backend.
 */
import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { branchCreate, branchRename } from '../../../../src/application/commands/branch.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import { getRefStore } from '../../../../src/application/primitives/ref-store.js';
import { readReflog } from '../../../../src/application/primitives/reflog-store.js';
import { writeSymbolicRef } from '../../../../src/application/primitives/write-symbolic-ref.js';
import type { AuthorIdentity, ObjectId, RefName } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';
import { withReftableStorage } from '../primitives/reftable-fixtures.js';

const AUTHOR: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

const HEADS = 'refs/heads/';

const filesRepo = async (): Promise<Context> => createMemoryContext();
const reftableRepo = async (): Promise<Context> => withReftableStorage(createMemoryContext());

const BACKENDS = [
  { backend: 'files', build: filesRepo },
  { backend: 'reftable', build: reftableRepo },
] as const;

/** One commit on `main`, plus the branch `short` at it. */
const seedBranch = async (
  build: () => Promise<Context>,
  short: string,
): Promise<{ readonly ctx: Context; readonly id: ObjectId }> => {
  const ctx = await build();
  await init(ctx);
  await writeSymbolicRef(ctx, 'HEAD' as RefName, `${HEADS}main` as RefName);
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
  await add(ctx, ['a.txt']);
  const { id } = await commit(ctx, { message: 'seed', author: AUTHOR });
  await branchCreate(ctx, { name: short });
  return { ctx, id };
};

const branchNames = async (ctx: Context): Promise<ReadonlyArray<RefName>> =>
  [...(await getRefStore(ctx).listRefNames(HEADS as RefName))].sort();

const reflogMessages = async (ctx: Context, name: RefName): Promise<ReadonlyArray<string>> =>
  (await readReflog(ctx, name)).map((entry) => entry.message);

describe('branchRename — a destination nested with the source', () => {
  describe.each(BACKENDS)('$backend backend', ({ build }) => {
    describe('Given a branch whose destination sits under its own name', () => {
      describe('When branchRename runs', () => {
        it('Then the branch moves and its log follows', async () => {
          // Arrange
          const { ctx, id } = await seedBranch(build, 'a');
          const sut = branchRename;

          // Act
          const result = await sut(ctx, { from: 'a', to: 'a/b' });

          // Assert
          expect(result).toEqual({ from: `${HEADS}a`, to: `${HEADS}a/b` });
          expect(await branchNames(ctx)).toEqual([`${HEADS}a/b`, `${HEADS}main`]);
          expect(await getRefStore(ctx).resolveDirect(`${HEADS}a/b` as RefName)).toEqual({
            kind: 'direct',
            id,
          });
          expect(await reflogMessages(ctx, `${HEADS}a/b` as RefName)).toContain(
            `Branch: renamed ${HEADS}a to ${HEADS}a/b`,
          );
        });
      });
    });

    describe('Given a branch whose destination is the name it sits under', () => {
      describe('When branchRename runs', () => {
        it('Then the branch moves and its log follows', async () => {
          // Arrange
          const { ctx, id } = await seedBranch(build, 'c/d');
          const sut = branchRename;

          // Act
          const result = await sut(ctx, { from: 'c/d', to: 'c' });

          // Assert
          expect(result).toEqual({ from: `${HEADS}c/d`, to: `${HEADS}c` });
          expect(await branchNames(ctx)).toEqual([`${HEADS}c`, `${HEADS}main`]);
          expect(await getRefStore(ctx).resolveDirect(`${HEADS}c` as RefName)).toEqual({
            kind: 'direct',
            id,
          });
          expect(await reflogMessages(ctx, `${HEADS}c` as RefName)).toContain(
            `Branch: renamed ${HEADS}c/d to ${HEADS}c`,
          );
        });
      });
    });

    describe('Given the nested destination of a branch HEAD is attached to', () => {
      describe('When branchRename runs', () => {
        it('Then HEAD names the destination', async () => {
          // Arrange
          const { ctx } = await seedBranch(build, 'a');
          await writeSymbolicRef(ctx, 'HEAD' as RefName, `${HEADS}a` as RefName);
          const sut = branchRename;

          // Act
          await sut(ctx, { from: 'a', to: 'a/b' });

          // Assert
          expect(await getRefStore(ctx).resolveDirect('HEAD' as RefName)).toEqual({
            kind: 'symbolic',
            target: `${HEADS}a/b`,
          });
        });
      });
    });
  });
});
