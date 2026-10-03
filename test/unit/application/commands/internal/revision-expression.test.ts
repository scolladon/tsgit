import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../../src/application/commands/add.js';
import { commit } from '../../../../../src/application/commands/commit.js';
import { init } from '../../../../../src/application/commands/init.js';
import { resolveRevisionExpression } from '../../../../../src/application/commands/internal/revision-expression.js';
import * as revParseMod from '../../../../../src/application/commands/rev-parse.js';
import { TsgitError } from '../../../../../src/domain/error.js';
import type { AuthorIdentity } from '../../../../../src/domain/objects/index.js';

const AUTHOR: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

const seed = async () => {
  const ctx = createMemoryContext();
  await init(ctx);
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
  await add(ctx, ['a.txt']);
  const head = await commit(ctx, { message: 'first', author: AUTHOR });
  return { ctx, head: head.id };
};

describe('resolveRevisionExpression', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Given a revision expression naming a commit', () => {
    describe('When resolved', () => {
      it('Then it answers that commit', async () => {
        // Arrange
        const { ctx, head } = await seed();
        const sut = resolveRevisionExpression;

        // Act
        const result = await sut(ctx, 'HEAD~0');

        // Assert
        expect(result).toBe(head);
      });
    });
  });

  describe.each([
    { label: 'an unknown name', expression: 'missing-rev' },
    { label: 'a revision past the root', expression: 'HEAD~5' },
    { label: 'a peel to an unknown type', expression: 'HEAD^{bogus}' },
  ])('Given $label', ({ expression }) => {
    describe('When resolved', () => {
      it('Then it answers undefined', async () => {
        // Arrange
        const { ctx } = await seed();
        const sut = resolveRevisionExpression;

        // Act
        const result = await sut(ctx, expression);

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe('Given resolution failing for another reason', () => {
    describe('When resolved', () => {
      it('Then that failure propagates unchanged', async () => {
        // Arrange
        const { ctx } = await seed();
        const failure = new TsgitError({
          code: 'REVPARSE_AMBIGUOUS',
          expression: 'x',
          candidates: [],
        });
        vi.spyOn(revParseMod, 'evaluateRevision').mockRejectedValue(failure);
        const sut = resolveRevisionExpression;

        // Act
        const attempt = sut(ctx, 'x');

        // Assert
        await expect(attempt).rejects.toBe(failure);
      });
    });
  });
});
