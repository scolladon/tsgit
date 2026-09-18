/**
 * The name `branch.create` accepts as a start point. git runs it through the
 * revision ladder — a tag, a remote-tracking path or an abbreviated object id
 * all work — and is the one surface that REFUSES when more than one candidate
 * namespace resolves; every other command takes the first and warns.
 */
import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { branchCreate } from '../../../../src/application/commands/branch.js';
import { checkout } from '../../../../src/application/commands/checkout.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import { tagCreate } from '../../../../src/application/commands/tag.js';
import { updateRef } from '../../../../src/application/primitives/update-ref.js';
import { writeSymbolicRef } from '../../../../src/application/primitives/write-symbolic-ref.js';
import type { TsgitError } from '../../../../src/domain/error.js';
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
const ABBREVIATED_LENGTH = 7;

const BACKENDS = [
  { backend: 'files', build: async (): Promise<Context> => createMemoryContext() },
  {
    backend: 'reftable',
    build: async (): Promise<Context> => withReftableStorage(createMemoryContext()),
  },
] as const;

interface Fixture {
  readonly ctx: Context;
  /** `refs/heads/amb`, `refs/remotes/org/tgt`. */
  readonly branchId: ObjectId;
  /** `refs/tags/amb`, `refs/tags/release`. */
  readonly tagId: ObjectId;
}

const seedAmbiguity = async (build: () => Promise<Context>): Promise<Fixture> => {
  const ctx = await build();
  await init(ctx);
  await writeSymbolicRef(ctx, 'HEAD' as RefName, `${HEADS}main` as RefName);
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
  await add(ctx, ['a.txt']);
  const first = await commit(ctx, { message: 'first', author: AUTHOR });
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'b');
  await add(ctx, ['a.txt']);
  const second = await commit(ctx, { message: 'second', author: AUTHOR });
  const reflogMessage = 'plant';
  await updateRef(ctx, `${HEADS}amb` as RefName, first.id, { reflogMessage });
  await updateRef(ctx, 'refs/tags/amb' as RefName, second.id, { reflogMessage });
  await updateRef(ctx, 'refs/tags/release' as RefName, second.id, { reflogMessage });
  await updateRef(ctx, 'refs/remotes/org/tgt' as RefName, first.id, { reflogMessage });
  return { ctx, branchId: first.id, tagId: second.id };
};

const refusalOf = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    await run();
  } catch (err) {
    return (err as TsgitError).data;
  }
  return undefined;
};

describe('branchCreate — the start point a branch is cut from', () => {
  describe.each(BACKENDS)('$backend backend', ({ build }) => {
    describe('Given a short name that is both a branch and a tag', () => {
      describe('When branchCreate cuts from it', () => {
        it('Then it refuses, naming the expression and every object it could mean', async () => {
          // Arrange
          const { ctx, branchId, tagId } = await seedAmbiguity(build);
          const sut = branchCreate;

          // Act
          const data = await refusalOf(() => sut(ctx, { name: 'fresh', startPoint: 'amb' }));

          // Assert
          expect(data).toEqual({
            code: 'REVPARSE_AMBIGUOUS',
            expression: 'amb',
            candidates: [tagId, branchId],
          });
        });
      });

      describe('When branchCreate cuts from it with force', () => {
        it('Then it refuses all the same', async () => {
          // Arrange
          const { ctx } = await seedAmbiguity(build);
          const sut = branchCreate;

          // Act
          const data = await refusalOf(() =>
            sut(ctx, { name: 'fresh', startPoint: 'amb', force: true }),
          );

          // Assert
          expect((data as { code: string }).code).toBe('REVPARSE_AMBIGUOUS');
        });
      });

      describe('When a tag is created over it', () => {
        it('Then the ambiguity is taken, not refused', async () => {
          // Arrange
          const { ctx, tagId } = await seedAmbiguity(build);
          const sut = tagCreate;

          // Act
          const result = await sut(ctx, { name: 'fresh', target: 'amb' });

          // Assert
          expect(result.id).toBe(tagId);
        });
      });

      describe('When checkout detaches onto it', () => {
        it('Then the ambiguity is taken, not refused', async () => {
          // Arrange
          const { ctx, branchId } = await seedAmbiguity(build);
          const sut = checkout;

          // Act
          const result = await sut(ctx, { rev: 'amb', detach: true });

          // Assert
          expect(result.id).toBe(branchId);
        });
      });
    });

    describe('Given a short name only one namespace carries', () => {
      describe.each([
        { label: 'a tag', startPoint: 'release', tip: 'tag' },
        { label: 'a remote-tracking path', startPoint: 'org/tgt', tip: 'branch' },
        { label: 'an unambiguous branch', startPoint: 'main', tip: 'tag' },
      ])('When branchCreate cuts from $label', ({ startPoint, tip }) => {
        it('Then the branch is created at that commit', async () => {
          // Arrange
          const { ctx, branchId, tagId } = await seedAmbiguity(build);
          const sut = branchCreate;

          // Act
          const result = await sut(ctx, { name: 'fresh', startPoint });

          // Assert
          expect(result.id).toBe(tip === 'tag' ? tagId : branchId);
        });
      });
    });

    describe('Given an abbreviated object id that names no ref', () => {
      describe('When branchCreate cuts from it', () => {
        it('Then the branch is created at the object it abbreviates', async () => {
          // Arrange
          const { ctx, branchId } = await seedAmbiguity(build);
          const sut = branchCreate;

          // Act
          const result = await sut(ctx, {
            name: 'fresh',
            startPoint: branchId.slice(0, ABBREVIATED_LENGTH),
          });

          // Assert
          expect(result.id).toBe(branchId);
        });
      });
    });
  });
});
