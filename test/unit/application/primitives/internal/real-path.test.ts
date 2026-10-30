import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import {
  realPathOf,
  realPathOutcomeOf,
} from '../../../../../src/application/primitives/internal/real-path.js';

const chainOf = async (links: number) => {
  const ctx = createMemoryContext({ files: { '/repo/end': new Uint8Array() } });
  for (let hop = 1; hop <= links; hop++) {
    await ctx.fs.symlink(hop === links ? '/repo/end' : `/repo/l${hop + 1}`, `/repo/l${hop}`);
  }
  return ctx;
};

describe('realPathOf', () => {
  describe('Given a context declaring a hop limit of 3 and a chain of 5 links', () => {
    describe('When realPathOf runs', () => {
      it('Then the chain is refused', async () => {
        // Arrange
        const ctx = await chainOf(5);
        const sut = realPathOf;

        // Act
        const result = await sut({ ...ctx, symlinkHopLimit: 3 }, '/repo/l1');

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe('Given a context declaring no hop limit and a chain of 5 links', () => {
    describe('When realPathOf runs', () => {
      it('Then the chain resolves', async () => {
        // Arrange
        const ctx = await chainOf(5);
        const sut = realPathOf;

        // Act
        const result = await sut(ctx, '/repo/l1');

        // Assert
        expect(result).toBe('/repo/end');
      });
    });
  });
});

describe('realPathOutcomeOf', () => {
  describe('Given a context declaring a hop limit of 3 and a chain of 5 links', () => {
    describe('When realPathOutcomeOf runs', () => {
      it('Then the walk stops on a symlink loop', async () => {
        // Arrange
        const ctx = await chainOf(5);
        const sut = realPathOutcomeOf;

        // Act
        const result = await sut({ ...ctx, symlinkHopLimit: 3 }, '/repo/l1');

        // Assert
        expect(result).toEqual({ kind: 'failed', reason: 'SYMLINK_LOOP', path: '/repo/l1' });
      });
    });
  });
});
