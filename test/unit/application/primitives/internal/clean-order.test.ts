import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import {
  admitClean,
  admitWrite,
  releaseClean,
  withCleanOrder,
} from '../../../../../src/application/primitives/internal/clean-order.js';
import type { FilePath } from '../../../../../src/domain/objects/object-id.js';

const A = 'a' as FilePath;
const B = 'b' as FilePath;
const C = 'c' as FilePath;

/** Settles every pending microtask chain before the caller looks at `admitted`. */
const drain = () => new Promise((resolve) => setTimeout(resolve, 0));

const track = (ctx: ReturnType<typeof createMemoryContext>, path: FilePath, admitted: FilePath[]) =>
  admitClean(ctx, path).then(() => {
    admitted.push(path);
  });

describe('withCleanOrder', () => {
  describe('Given paths enlisted in order', () => {
    describe('When a later path asks to clean first', () => {
      it('Then it is admitted only once every earlier path is released', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const admitted: FilePath[] = [];
        const sut = withCleanOrder;

        // Act
        await sut(ctx, async (order) => {
          for (const path of [A, B, C]) order.enlist(path);
          const later = track(ctx, C, admitted);
          await drain();
          expect(admitted).toEqual([]);
          order.release(A);
          await drain();
          expect(admitted).toEqual([]);
          order.release(B);
          await later;
        });

        // Assert
        expect(admitted).toEqual([C]);
      });
    });

    describe('When the first enlisted path asks to clean', () => {
      it('Then it is admitted at once', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const admitted: FilePath[] = [];
        const sut = withCleanOrder;

        // Act
        await sut(ctx, async (order) => {
          for (const path of [A, B]) order.enlist(path);
          await track(ctx, A, admitted);
        });

        // Assert
        expect(admitted).toEqual([A]);
      });
    });

    describe('When a path is enlisted twice and released once', () => {
      it('Then the paths after it are still admitted', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const admitted: FilePath[] = [];
        const sut = withCleanOrder;

        // Act
        await sut(ctx, async (order) => {
          for (const path of [A, A, B]) order.enlist(path);
          releaseClean(ctx, A);
          releaseClean(ctx, A);
          await track(ctx, B, admitted);
        });

        // Assert
        expect(admitted).toEqual([B]);
      });
    });

    describe('When a path that was never enlisted asks to clean', () => {
      it('Then it is admitted at once and its release changes nothing', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const admitted: FilePath[] = [];
        const sut = withCleanOrder;

        // Act
        await sut(ctx, async (order) => {
          for (const path of [A, B]) order.enlist(path);
          await track(ctx, C, admitted);
          releaseClean(ctx, C);
          const second = track(ctx, B, admitted);
          await drain();
          expect(admitted).toEqual([C]);
          order.release(A);
          await second;
        });

        // Assert
        expect(admitted).toEqual([C, B]);
      });
    });
  });

  describe('Given a scope already open on the context', () => {
    describe('When a nested scope enlists paths', () => {
      it('Then the nested enlistment leaves the outer order alone', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const admitted: FilePath[] = [];
        const sut = withCleanOrder;

        // Act
        await sut(ctx, async (outer) => {
          outer.enlist(A);
          await sut(ctx, async (inner) => {
            inner.enlist(B);
            inner.release(A);
          });
          const blocked = track(ctx, B, admitted);
          await drain();
          expect(admitted).toEqual([B]);
          outer.release(A);
          await blocked;
        });

        // Assert
        expect(admitted).toEqual([B]);
      });
    });

    describe('When a nested scope closes', () => {
      it('Then the outer order still holds a later path back', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const admitted: FilePath[] = [];
        const sut = withCleanOrder;

        // Act
        await sut(ctx, async (outer) => {
          for (const path of [A, B]) outer.enlist(path);
          await sut(ctx, async () => undefined);
          const blocked = track(ctx, B, admitted);
          await drain();
          expect(admitted).toEqual([]);
          outer.release(A);
          await blocked;
        });

        // Assert
        expect(admitted).toEqual([B]);
      });
    });

    describe('When a nested scope halts a path', () => {
      it('Then the outer order admits the later path as usual', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const admitted: FilePath[] = [];
        const sut = withCleanOrder;

        // Act
        await sut(
          ctx,
          async (outer) => {
            for (const path of [A, B]) outer.enlist(path);
            await sut(ctx, async (inner) => inner.halt(A, new Error('nested')), 'write');
            outer.release(A);
            await trackWrite(ctx, B, admitted);
          },
          'write',
        );

        // Assert
        expect(admitted).toEqual([B]);
      });
    });

    describe('When the scope closes', () => {
      it('Then later admissions on the context are no longer ordered', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const admitted: FilePath[] = [];
        const sut = withCleanOrder;
        await sut(ctx, async (order) => {
          for (const path of [A, B]) order.enlist(path);
        });

        // Act
        await track(ctx, B, admitted);

        // Assert
        expect(admitted).toEqual([B]);
      });
    });
  });

  describe('Given no scope open on the context', () => {
    describe('When a path asks to clean', () => {
      it('Then it is admitted at once', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const admitted: FilePath[] = [];
        const sut = admitClean;

        // Act
        await sut(ctx, A).then(() => admitted.push(A));
        releaseClean(ctx, A);

        // Assert
        expect(admitted).toEqual([A]);
      });
    });
  });
});

const trackWrite = (
  ctx: ReturnType<typeof createMemoryContext>,
  path: FilePath,
  admitted: FilePath[],
) =>
  admitWrite(ctx, path).then(() => {
    admitted.push(path);
  });

describe('withCleanOrder in a write span', () => {
  describe('Given a write span with a, b, c enlisted', () => {
    describe('When admitWrite(c) and admitWrite(b) are awaited', () => {
      it('Then b is admitted before c, each only after the previous release', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const admitted: FilePath[] = [];
        const sut = withCleanOrder;

        // Act
        await sut(
          ctx,
          async (order) => {
            for (const path of [A, B, C]) order.enlist(path);
            const third = trackWrite(ctx, C, admitted);
            const second = trackWrite(ctx, B, admitted);
            await drain();
            expect(admitted).toEqual([]);
            order.release(A);
            await second;
            await drain();
            expect(admitted).toEqual([B]);
            order.release(B);
            await third;
          },
          'write',
        );

        // Assert
        expect(admitted).toEqual([B, C]);
      });
    });

    describe('When releaseClean(a) runs before a is written', () => {
      it('Then b is still waiting', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const admitted: FilePath[] = [];
        const sut = withCleanOrder;

        // Act
        await sut(
          ctx,
          async (order) => {
            for (const path of [A, B]) order.enlist(path);
            await trackWrite(ctx, A, admitted);
            const second = trackWrite(ctx, B, admitted);
            releaseClean(ctx, A);
            await drain();
            expect(admitted).toEqual([A]);
            order.release(A);
            await second;
          },
          'write',
        );

        // Assert
        expect(admitted).toEqual([A, B]);
      });
    });

    describe('When admitClean asks for the admitted path', () => {
      it('Then it resolves at once', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const admitted: FilePath[] = [];
        const sut = withCleanOrder;

        // Act
        await sut(
          ctx,
          async (order) => {
            for (const path of [A, B]) order.enlist(path);
            await trackWrite(ctx, A, admitted);
            await track(ctx, A, admitted);
          },
          'write',
        );

        // Assert
        expect(admitted).toEqual([A, A]);
      });
    });

    describe('When b is halted with an error', () => {
      it('Then the pending waiter and a later admitWrite for c reject with it, a is unaffected', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const sut = withCleanOrder;
        const failure = new Error('b refused');
        const outcomes: unknown[] = [];

        // Act
        await sut(
          ctx,
          async (order) => {
            for (const path of [A, B, C]) order.enlist(path);
            await admitWrite(ctx, A);
            const pending = admitWrite(ctx, C).catch((error: unknown) => outcomes.push(error));
            order.release(A);
            await admitWrite(ctx, B);
            order.halt(B, failure);
            await pending;
            await admitWrite(ctx, C).catch((error: unknown) => outcomes.push(error));
            await admitWrite(ctx, B);
            await admitWrite(ctx, A);
          },
          'write',
        );

        // Assert
        expect(outcomes).toHaveLength(2);
        expect(outcomes[0]).toBe(failure);
        expect(outcomes[1]).toBe(failure);
      });
    });

    describe('When a path that was never enlisted is halted', () => {
      it('Then every enlisted path is still admitted in order', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const admitted: FilePath[] = [];
        const sut = withCleanOrder;

        // Act
        await sut(
          ctx,
          async (order) => {
            order.enlist(A);
            order.halt(C, new Error('unknown'));
            await trackWrite(ctx, A, admitted);
          },
          'write',
        );

        // Assert
        expect(admitted).toEqual([A]);
      });
    });

    describe('When an earlier path halts after a later one did', () => {
      it('Then the earlier halt error is the one later paths reject with', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const sut = withCleanOrder;
        const early = new Error('a refused');
        const late = new Error('b refused');
        const outcomes: unknown[] = [];

        // Act
        await sut(
          ctx,
          async (order) => {
            for (const path of [A, B, C]) order.enlist(path);
            order.halt(B, late);
            order.halt(A, early);
            order.halt(C, new Error('c refused'));
            await admitWrite(ctx, C).catch((error: unknown) => outcomes.push(error));
          },
          'write',
        );

        // Assert
        expect(outcomes).toEqual([early]);
      });
    });
  });

  describe('Given a clean span', () => {
    describe('When admitWrite asks for a path behind an unreleased one', () => {
      it('Then it resolves at once', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const admitted: FilePath[] = [];
        const sut = withCleanOrder;

        // Act
        await sut(ctx, async (order) => {
          for (const path of [A, B]) order.enlist(path);
          await trackWrite(ctx, B, admitted);
        });

        // Assert
        expect(admitted).toEqual([B]);
      });
    });
  });
});
