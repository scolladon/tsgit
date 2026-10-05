import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { expandPriorCheckout } from '../../../../../src/application/commands/internal/prior-checkout.js';
import type { Context } from '../../../../../src/ports/context.js';

const OID_A = 'a'.repeat(40);
const OID_B = 'b'.repeat(40);

const withHeadReflog = async (messages: ReadonlyArray<string>): Promise<Context> => {
  const ctx = createMemoryContext();
  const lines = messages.map(
    (message) => `${OID_A} ${OID_B} Ada <a@x> 1700000000 +0000\t${message}\n`,
  );
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/logs/HEAD`, lines.join(''));
  return ctx;
};

const HISTORY = [
  'commit (initial): base',
  'checkout: moving from main to side',
  'checkout: moving from side to main',
  'checkout: moving from nowhere',
  'commit: tip',
];

describe('expandPriorCheckout', () => {
  describe.each([
    ['@{-1}', 'side'],
    ['@{-2}', 'main'],
    ['@{-1}~2', 'side~2'],
    ['@{-3}', '@{-3}'],
    ['@{-0}', '@{-0}'],
    ['side', 'side'],
  ])('Given HEAD switched main → side → main, and the name %s', (name, expected) => {
    describe('When it is expanded', () => {
      it('Then it reads as git interprets the n-th prior checkout', async () => {
        // Arrange
        const ctx = await withHeadReflog(HISTORY);
        const sut = expandPriorCheckout;

        // Act
        const result = await sut(ctx, name);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });
});
