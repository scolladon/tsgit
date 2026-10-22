import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { branchCreate } from '../../../../src/application/commands/branch.js';
import { checkout } from '../../../../src/application/commands/checkout.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import { tagCreate } from '../../../../src/application/commands/tag.js';
import { readHeadRaw as readHead } from '../../../../src/application/primitives/internal/repo-state.js';
import { updateConfigEntries } from '../../../../src/application/primitives/update-config.js';
import { pathspecNoMatch } from '../../../../src/domain/commands/error.js';
import type { TsgitError } from '../../../../src/domain/error.js';
import type { AuthorIdentity, ObjectId } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';

const author: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

/** `main` with one commit and a `side` branch at it; no checkout recorded yet. */
const seed = async (): Promise<{ readonly ctx: Context; readonly base: ObjectId }> => {
  const ctx = createMemoryContext();
  await init(ctx);
  await updateConfigEntries(ctx, [
    { section: 'user', key: 'name', value: author.name },
    { section: 'user', key: 'email', value: author.email },
  ]);
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/f`, 'base\n');
  await add(ctx, ['f']);
  const base = (await commit(ctx, { message: 'base', author })).id;
  await branchCreate(ctx, { name: 'side' });
  return { ctx, base };
};

const refusal = (run: Promise<unknown>): Promise<unknown> =>
  run.then(
    () => undefined,
    (error: unknown) => (error as TsgitError).data,
  );

describe('checkout of a switch target git cannot switch to', () => {
  describe.each(['nope', 'nope~1', 'HEAD~5', 'nope^{tree}', 'HEAD^{/nomatch}', '-'])(
    'Given %s names no revision',
    (rev) => {
      describe('When checkout switches to it', () => {
        it('Then it refuses as an unmatched pathspec and HEAD stays', async () => {
          // Arrange
          const { ctx } = await seed();
          const sut = checkout;

          // Act
          const result = await refusal(sut(ctx, { rev }));

          // Assert
          expect(result).toEqual(pathspecNoMatch(rev).data);
          expect(await readHead(ctx)).toMatchObject({ kind: 'symbolic' });
        });
      });
    },
  );

  describe.each([
    ['a plain switch', {}],
    ['a detached switch', { detach: true }],
    ['a branch-creating switch', { createBranch: { name: 'fresh' } }],
  ] as const)('Given a revision naming a tree and %s', (_label, extra) => {
    describe('When checkout switches to it', () => {
      it('Then it refuses to switch to a non-commit', async () => {
        // Arrange
        const { ctx } = await seed();
        const sut = checkout;

        // Act
        const result = await refusal(sut(ctx, { rev: 'HEAD^{tree}', ...extra }));

        // Assert
        expect(result).toEqual({ code: 'CHECKOUT_NON_COMMIT', revision: 'HEAD^{tree}' });
        expect(await readHead(ctx)).toMatchObject({ kind: 'symbolic' });
      });
    });
  });

  describe('Given a branch to create that exists and a revision naming a tree', () => {
    describe('When checkout switches to it', () => {
      it('Then the existing branch refuses first', async () => {
        // Arrange
        const { ctx } = await seed();
        const sut = checkout;

        // Act
        const result = await refusal(
          sut(ctx, { rev: 'HEAD^{tree}', createBranch: { name: 'side' } }),
        );

        // Assert
        expect(result).toEqual({ code: 'BRANCH_EXISTS', name: 'refs/heads/side' });
      });
    });
  });

  describe('Given a branch to create that exists and a start point naming nothing', () => {
    describe('When checkout switches to it', () => {
      it('Then the start point refuses first, naming both', async () => {
        // Arrange
        const { ctx } = await seed();
        const sut = checkout;

        // Act
        const result = await refusal(sut(ctx, { rev: 'nope', createBranch: { name: 'side' } }));

        // Assert
        expect(result).toEqual({
          code: 'CHECKOUT_START_POINT_NOT_COMMIT',
          revision: 'nope',
          branch: 'side',
        });
      });
    });
  });

  describe('Given an annotated tag', () => {
    describe('When checkout switches to it', () => {
      it('Then HEAD detaches at the commit it tags', async () => {
        // Arrange
        const { ctx, base } = await seed();
        await tagCreate(ctx, { name: 'v1', target: 'main', message: 'v1' });
        const sut = checkout;

        // Act
        const result = await sut(ctx, { rev: 'v1' });

        // Assert
        expect(result).toMatchObject({ id: base, detached: true });
        expect(await readHead(ctx)).toEqual({ kind: 'direct', id: base });
      });
    });
  });
});
