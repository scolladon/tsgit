import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { LineKey } from '../../../../../src/domain/diff/whitespace.js';
import { linesEqualUnder } from '../../../../../src/domain/diff/whitespace.js';
import { classifyLines } from '../../../../../src/domain/diff/xdiff/xdl-classify.js';
import { bytesEqual } from '../../../../../src/domain/objects/encoding.js';
import { arbLineKey } from '../arbitraries.js';

// A small, mostly-overlapping alphabet of line bodies — deliberately
// collision-prone (repeated content, whitespace-only differences, presence
// vs absence of a trailing LF) so that shared/fresh class ids, and every
// whitespace mode's merge behaviour, are all reachable at a small array size.
const LINE_BODIES = ['a', 'A', 'ab', 'a b', ' a', 'a ', '\t a', ''] as const;

function arbLine(): fc.Arbitrary<Uint8Array> {
  return fc
    .record({
      body: fc.constantFrom(...LINE_BODIES),
      terminated: fc.boolean(),
    })
    .map(({ body, terminated }) => new TextEncoder().encode(terminated ? `${body}\n` : body));
}

function arbLines(): fc.Arbitrary<ReadonlyArray<Uint8Array>> {
  return fc.array(arbLine(), { minLength: 0, maxLength: 6 });
}

function sameKeyBytes(a: Uint8Array, b: Uint8Array, lineKey: LineKey | undefined): boolean {
  return lineKey === undefined ? bytesEqual(a, b) : linesEqualUnder(a, b, lineKey);
}

describe('classifyLines properties', () => {
  describe('Given arbitrary ours/theirs line arrays and an optional line key', () => {
    describe('When classifyLines assigns class ids', () => {
      it('Then two lines share a class id iff their (normalized) bytes are equal', () => {
        // Arrange
        fc.assert(
          fc.property(
            arbLines(),
            arbLines(),
            fc.option(arbLineKey(), { nil: undefined }),
            (ours, theirs, lineKey) => {
              // Act
              const result = classifyLines(ours, theirs, lineKey ?? undefined);
              const combined = [
                ...ours.map((line, i) => ({ line, id: result.ours[i]! })),
                ...theirs.map((line, j) => ({ line, id: result.theirs[j]! })),
              ];

              // Assert
              for (let a = 0; a < combined.length; a++) {
                for (let b = a + 1; b < combined.length; b++) {
                  const sameId = combined[a]!.id === combined[b]!.id;
                  const sameBytes = sameKeyBytes(
                    combined[a]!.line,
                    combined[b]!.line,
                    lineKey ?? undefined,
                  );
                  expect(sameId).toBe(sameBytes);
                }
              }
            },
          ),
          { numRuns: 100 },
        );
      });

      it('Then ids are dense in [0, classCount): every id in range appears at least once', () => {
        // Arrange
        fc.assert(
          fc.property(
            arbLines(),
            arbLines(),
            fc.option(arbLineKey(), { nil: undefined }),
            (ours, theirs, lineKey) => {
              // Act
              const result = classifyLines(ours, theirs, lineKey ?? undefined);
              const seen = new Set<number>([...result.ours, ...result.theirs]);

              // Assert
              for (const id of seen) {
                expect(id).toBeGreaterThanOrEqual(0);
                expect(id).toBeLessThan(result.classCount);
              }
              expect(seen.size).toBe(result.classCount);
            },
          ),
          { numRuns: 100 },
        );
      });
    });
  });
});
