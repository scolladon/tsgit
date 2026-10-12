import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import {
  expandPriorCheckout,
  interpretBranchName,
  nthPriorCheckout,
  previousCheckoutArg,
} from '../../../../../src/application/commands/internal/prior-checkout.js';
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

describe('nthPriorCheckout', () => {
  describe.each([
    ['@{-1}', 'side'],
    ['@{-2}', 'main'],
    ['@{-1}~2', undefined],
    ['x@{-1}', undefined],
    ['@{-3}', undefined],
    ['@{-0}', undefined],
  ])('Given HEAD switched main → side → main, and the whole name %s', (name, expected) => {
    describe('When it is interpreted', () => {
      it('Then only a whole @{-<n>} the reflog can name reads as a branch', async () => {
        // Arrange
        const ctx = await withHeadReflog(HISTORY);
        const sut = nthPriorCheckout;

        // Act
        const result = await sut(ctx, name);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });
});

describe('interpretBranchName', () => {
  describe.each([
    ['@{-1}', 'side'],
    ['@{-3}', '@{-3}'],
    ['topic', 'topic'],
  ])('Given HEAD switched main → side → main, and the branch name %s', (name, expected) => {
    describe('When it is interpreted', () => {
      it('Then it spells the branch git would act on', async () => {
        // Arrange
        const ctx = await withHeadReflog(HISTORY);
        const sut = interpretBranchName;

        // Act
        const result = await sut(ctx, name);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });
});

describe('previousCheckoutArg', () => {
  describe.each([
    ['-', '@{-1}'],
    ['--', '--'],
    ['main', 'main'],
  ])('Given the argument %s', (arg, expected) => {
    describe('When it is read', () => {
      it('Then only a lone dash is the previous checkout', () => {
        // Arrange
        const sut = previousCheckoutArg;

        // Act
        const result = sut(arg);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });
});

describe('expandPriorCheckout reflog reads', () => {
  describe('Given a reflog entry that merely mentions a switch in its text', () => {
    describe('When @{-1} is expanded', () => {
      it('Then only a checkout entry counts as a switch', async () => {
        // Arrange
        const ctx = await withHeadReflog([
          'checkout: moving from main to side',
          'checkout: moving from side to main',
          'rebase (finish): returning to refs/heads/side',
        ]);
        const sut = expandPriorCheckout;

        // Act
        const result = await sut(ctx, '@{-1}');

        // Assert
        expect(result).toBe('side');
      });
    });
  });

  describe('Given the name @{-0}', () => {
    describe('When it is expanded', () => {
      it('Then HEAD reflog is not read, as there is no 0-th prior checkout', async () => {
        // Arrange
        const base = await withHeadReflog(HISTORY);
        const touched: string[] = [];
        const fs = new Proxy(base.fs, {
          get: (target, property, receiver) => {
            const member = Reflect.get(target, property, receiver);
            if (typeof member !== 'function') return member;
            return (...args: unknown[]) => {
              touched.push(String(args[0]));
              return member.apply(target, args);
            };
          },
        });
        const ctx: Context = { ...base, fs };
        const sut = expandPriorCheckout;

        // Act
        const result = await sut(ctx, '@{-0}');

        // Assert
        expect(result).toBe('@{-0}');
        expect(touched.filter((path) => path.endsWith('logs/HEAD'))).toEqual([]);
      });
    });
  });
});
