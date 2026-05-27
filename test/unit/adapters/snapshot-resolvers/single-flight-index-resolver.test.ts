import { describe, expect, it } from 'vitest';

import { createSingleFlightIndexResolver } from '../../../../src/adapters/snapshot-resolvers/single-flight-index-resolver.js';
import type { GitIndex } from '../../../../src/domain/git-index/index-entry.js';
import type { IndexResolver } from '../../../../src/ports/snapshot-resolvers.js';
import { buildSeededContext } from '../../application/primitives/fixtures.js';

const EMPTY_INDEX: GitIndex = {
  version: 2,
  entries: [],
  extensions: [],
  trailerSha: new Uint8Array(0),
};

interface CountingResolver extends IndexResolver {
  readonly calls: () => number;
}

interface Gate {
  readonly opened: Promise<void>;
  readonly open: () => void;
}

const createGate = (): Gate => {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
};

const createCountingResolver = (resolveImpl: () => Promise<GitIndex>): CountingResolver => {
  let count = 0;
  return {
    calls: () => count,
    resolve: async () => {
      count += 1;
      return resolveImpl();
    },
  };
};

describe('createSingleFlightIndexResolver', () => {
  describe('Given an inner resolver that takes time to resolve', () => {
    describe('When 1000 concurrent resolve() calls are made', () => {
      it('Then the inner resolver is invoked exactly once', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const gate = createGate();
        const inner = createCountingResolver(async () => {
          await gate.opened;
          return EMPTY_INDEX;
        });
        const sut = createSingleFlightIndexResolver(inner);

        // Act — fire 1000 concurrent resolves, then release the inner.
        const calls = Array.from({ length: 1000 }, () => sut.resolve(ctx));
        gate.open();
        const results = await Promise.all(calls);

        // Assert
        expect(inner.calls()).toBe(1);
        expect(results).toHaveLength(1000);
        for (const r of results) expect(r).toBe(EMPTY_INDEX);
      });
    });
  });

  describe('Given the first resolve has settled', () => {
    describe('When a new resolve is started after settlement', () => {
      it('Then the inner resolver is invoked a second time (no permanent caching)', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const inner = createCountingResolver(async () => EMPTY_INDEX);
        const sut = createSingleFlightIndexResolver(inner);

        // Act
        await sut.resolve(ctx);
        await sut.resolve(ctx);

        // Assert
        expect(inner.calls()).toBe(2);
      });
    });
  });

  describe('Given a non-bypass call is in flight', () => {
    describe('When a concurrent bypassCache=true call arrives', () => {
      it('Then the bypass call skips the dedup gate and triggers a second inner call', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const gate = createGate();
        const inner = createCountingResolver(async () => {
          await gate.opened;
          return EMPTY_INDEX;
        });
        const sut = createSingleFlightIndexResolver(inner);

        // Act — start a non-bypass call (blocked on gate), then fire bypass.
        const slow = sut.resolve(ctx);
        const bypass = sut.resolve(ctx, { bypassCache: true });
        gate.open();
        await Promise.all([slow, bypass]);

        // Assert — both calls reach the inner resolver
        expect(inner.calls()).toBe(2);
      });
    });
  });

  describe('Given the inner resolver rejects', () => {
    describe('When concurrent resolves observe the rejection', () => {
      it('Then all callers see the same rejection and inflight is cleared for retry', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const failure = new Error('boom');
        let firstCall = true;
        const inner = createCountingResolver(async () => {
          if (firstCall) {
            firstCall = false;
            throw failure;
          }
          return EMPTY_INDEX;
        });
        const sut = createSingleFlightIndexResolver(inner);

        // Act
        const concurrentRejections = await Promise.allSettled([sut.resolve(ctx), sut.resolve(ctx)]);
        const followUp = await sut.resolve(ctx);

        // Assert
        for (const settled of concurrentRejections) {
          expect(settled.status).toBe('rejected');
          if (settled.status === 'rejected') expect(settled.reason).toBe(failure);
        }
        expect(inner.calls()).toBe(2);
        expect(followUp).toBe(EMPTY_INDEX);
      });
    });
  });
});
