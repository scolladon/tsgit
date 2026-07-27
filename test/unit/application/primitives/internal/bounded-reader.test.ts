import { describe, expect, it } from 'vitest';
import { createBoundedReader } from '../../../../../src/application/primitives/internal/bounded-reader.js';
import type { ObjectId } from '../../../../../src/domain/objects/index.js';

describe('createBoundedReader', () => {
  describe('Given a consumed id that was forgotten', () => {
    describe('When start is called again for the same id', () => {
      it('Then the underlying read runs a second time (memo entry was dropped)', async () => {
        // Arrange
        let reads = 0;
        const boundedRead = createBoundedReader(2, async (id: ObjectId) => {
          reads += 1;
          return id;
        });
        const id = 'a'.repeat(40) as ObjectId;

        // Act
        await boundedRead.start(id);
        boundedRead.forget(id);
        await boundedRead.start(id);

        // Assert
        expect(reads).toBe(2);
      });
    });
  });

  describe('Given a bound of 2 and 5 ids started without awaiting between them', () => {
    describe('When every read is eventually awaited', () => {
      it('Then concurrent in-flight reads never exceed the bound', async () => {
        // Arrange
        let active = 0;
        let maxActive = 0;
        const read = async (id: ObjectId): Promise<ObjectId> => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise<void>((resolve) => setTimeout(resolve, 5));
          active -= 1;
          return id;
        };
        const boundedRead = createBoundedReader(2, read);
        const ids = [
          '1'.repeat(40),
          '2'.repeat(40),
          '3'.repeat(40),
          '4'.repeat(40),
          '5'.repeat(40),
        ].map((hex) => hex as ObjectId);

        // Act
        const promises = ids.map((id) => boundedRead.start(id));
        await Promise.all(promises);

        // Assert
        expect(maxActive).toBeLessThanOrEqual(2);
      });
    });
  });

  describe('Given the same id started twice before either resolves', () => {
    describe('When both calls are awaited', () => {
      it('Then the underlying read runs exactly once and both see its result', async () => {
        // Arrange
        let callCount = 0;
        const read = async (id: ObjectId): Promise<ObjectId> => {
          callCount += 1;
          await Promise.resolve();
          return id;
        };
        const boundedRead = createBoundedReader(4, read);
        const id = 'a'.repeat(40) as ObjectId;

        // Act
        const first = boundedRead.start(id);
        const second = boundedRead.start(id);
        const [firstResult, secondResult] = await Promise.all([first, second]);

        // Assert
        expect(callCount).toBe(1);
        expect(firstResult).toBe(id);
        expect(secondResult).toBe(id);
      });
    });
  });

  describe('Given a read that rejects', () => {
    describe('When the rejection is never synchronously awaited by the starter', () => {
      it('Then a later await on the same promise still observes the rejection', async () => {
        // Arrange — pins the unhandled-rejection-safe fire-and-forget contract:
        // `start` must not swallow the error for a real awaiter.
        const read = async (): Promise<never> => {
          throw new Error('boom');
        };
        const boundedRead = createBoundedReader(1, read);
        const id = 'b'.repeat(40) as ObjectId;

        // Act
        boundedRead.start(id); // fire-and-forget, exactly as a prefetching walk would
        let caught: unknown;
        try {
          await boundedRead.start(id);
        } catch (error) {
          caught = error;
        }

        // Assert
        expect(caught).toBeInstanceOf(Error);
        expect((caught as Error).message).toBe('boom');
      });
    });
  });
});
