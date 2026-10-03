import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import {
  admitClean,
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
