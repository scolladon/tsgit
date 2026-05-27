/**
 * Mutation-killer tests for `workdir-snapshot.ts`. Targets the
 * `consistency: 'verified'` branch — the only place the operator
 * diverges from the eager pass-through.
 */
import { describe, expect, it } from 'vitest';

import { createWorkdirSnapshot } from '../../../../../src/application/primitives/snapshot/workdir-snapshot.js';
import {
  FILE_MODE,
  type FileMode,
  type FilePath,
} from '../../../../../src/domain/objects/index.js';
import type { WorkdirEntryRow } from '../../../../../src/domain/snapshot/index.js';
import type { WorkdirEnumerator } from '../../../../../src/ports/snapshot-resolvers.js';
import { buildSeededContext } from '../fixtures.js';

const sampleRow = (path: string, drained: { count: number }): WorkdirEntryRow => {
  void drained;
  return {
    source: 'workdir',
    path: path as FilePath,
    mode: FILE_MODE.REGULAR as FileMode,
    kind: 'file',
    stat: {
      mode: FILE_MODE.REGULAR as FileMode,
      size: 0,
      mtimeMs: 0,
      ino: 0n,
    },
  };
};

const collect = async <T>(it: AsyncIterable<T>): Promise<T[]> => {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
};

describe('workdir-snapshot — consistency mode timing', () => {
  describe('Given consistency="verified" (factory-time)', () => {
    describe('When entries() is iterated and the first row is consumed', () => {
      it('Then the enumerator has been fully drained BEFORE the first yield', async () => {
        // Arrange — counter increments each time the enumerator yields a row.
        const ctx = await buildSeededContext();
        const drained = { count: 0 };
        const enumerator: WorkdirEnumerator = {
          enumerate: async function* () {
            drained.count += 1;
            yield sampleRow('a', drained);
            drained.count += 1;
            yield sampleRow('b', drained);
            drained.count += 1;
            yield sampleRow('c', drained);
          },
        };
        const sut = createWorkdirSnapshot({ ctx, enumerator }, { consistency: 'verified' });

        // Act — peek the first row only
        const iter = sut.entries()[Symbol.asyncIterator]();
        await iter.next();
        const drainedBeforeFirstYield = drained.count;
        await iter.return?.();

        // Assert — verified buffered all 3 before yielding the first one
        expect(drainedBeforeFirstYield).toBe(3);
      });
    });
  });

  describe('Given default eager mode (no consistency option)', () => {
    describe('When entries() is iterated and the first row is consumed', () => {
      it('Then only the FIRST enumerator row has been pulled before the first yield', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const drained = { count: 0 };
        const enumerator: WorkdirEnumerator = {
          enumerate: async function* () {
            drained.count += 1;
            yield sampleRow('a', drained);
            drained.count += 1;
            yield sampleRow('b', drained);
            drained.count += 1;
            yield sampleRow('c', drained);
          },
        };
        const sut = createWorkdirSnapshot({ ctx, enumerator });

        // Act
        const iter = sut.entries()[Symbol.asyncIterator]();
        await iter.next();
        const drainedBeforeFirstYield = drained.count;
        await iter.return?.();

        // Assert — eager: only 1 pull happened before the first yield
        expect(drainedBeforeFirstYield).toBe(1);
      });
    });
  });

  describe('Given explicit consistency="eager"', () => {
    describe('When entries() is iterated', () => {
      it('Then the same eager streaming behaviour as the default applies', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const drained = { count: 0 };
        const enumerator: WorkdirEnumerator = {
          enumerate: async function* () {
            drained.count += 1;
            yield sampleRow('a', drained);
            drained.count += 1;
            yield sampleRow('b', drained);
          },
        };
        const sut = createWorkdirSnapshot({ ctx, enumerator }, { consistency: 'eager' });

        // Act
        const iter = sut.entries()[Symbol.asyncIterator]();
        await iter.next();
        const drainedBeforeFirstYield = drained.count;
        await iter.return?.();

        // Assert
        expect(drainedBeforeFirstYield).toBe(1);
      });
    });
  });

  describe('Given consistency="verified" with no rows', () => {
    describe('When entries() is iterated', () => {
      it('Then iteration completes cleanly with zero yields', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const enumerator: WorkdirEnumerator = {
          enumerate: async function* () {
            yield* [];
          },
        };
        const sut = createWorkdirSnapshot({ ctx, enumerator }, { consistency: 'verified' });

        // Act
        const out = await collect(sut.entries());

        // Assert
        expect(out).toEqual([]);
      });
    });
  });
});
