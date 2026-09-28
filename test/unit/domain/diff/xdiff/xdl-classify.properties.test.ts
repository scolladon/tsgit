import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { LineDiffOptions } from '../../../../../src/domain/diff/line-diff.js';
import { diffPresplitLines } from '../../../../../src/domain/diff/line-diff.js';
import type { LineKey } from '../../../../../src/domain/diff/whitespace.js';
import { linesEqualUnder, normalizeLine } from '../../../../../src/domain/diff/whitespace.js';
import { classifyLines, hashLineSide } from '../../../../../src/domain/diff/xdiff/xdl-classify.js';
import { bytesEqual } from '../../../../../src/domain/objects/encoding.js';
import { arbLineKey } from '../arbitraries.js';

/** `classifyLines`, hashing both sides from scratch — this suite's default shape. */
function classify(
  ours: ReadonlyArray<Uint8Array>,
  theirs: ReadonlyArray<Uint8Array>,
  lineKey: LineKey | undefined,
) {
  return classifyLines(
    ours,
    theirs,
    lineKey,
    hashLineSide(ours, lineKey),
    hashLineSide(theirs, lineKey),
  );
}

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

// Independent oracle: git's djb2, written in shift form (`(hash<<5)+hash`,
// the textbook rendering, rather than production's `Math.imul(hash,33)` —
// arithmetically the same 32-bit value, deliberately spelled differently),
// paired with hash-keyed chaining (a `Map` of hash -> linear chain,
// confirmed by `bytesEqual`) instead of production's open-addressing table.
// A bug in the table's capacity, mask, probe wraparound or EMPTY_SLOT
// bookkeeping would very plausibly desync ids from this differently-shaped
// bucketing; it must still land on the exact same ids, in the exact same
// first-appearance order, as the production table.
const ORACLE_LF = 0x0a;

function referenceDjb2(bytes: Uint8Array): number {
  const length = bytes.length;
  const end = length > 0 && bytes[length - 1] === ORACLE_LF ? length - 1 : length;
  let hash = 5381;
  for (let i = 0; i < end; i++) {
    hash = ((hash << 5) + hash + bytes[i]!) >>> 0;
  }
  return hash;
}

function referenceKeyOf(line: Uint8Array, lineKey: LineKey | undefined): Uint8Array {
  return lineKey === undefined ? line : normalizeLine(line, lineKey);
}

interface ReferenceBucketEntry {
  readonly key: Uint8Array;
  readonly id: number;
}

function referenceClassify(
  ours: ReadonlyArray<Uint8Array>,
  theirs: ReadonlyArray<Uint8Array>,
  lineKey: LineKey | undefined,
): { ours: number[]; theirs: number[]; classCount: number } {
  const chains = new Map<number, ReferenceBucketEntry[]>();
  let nextId = 0;
  const assign = (line: Uint8Array): number => {
    const key = referenceKeyOf(line, lineKey);
    const hash = referenceDjb2(key);
    const chain = chains.get(hash) ?? [];
    const existing = chain.find((entry) => bytesEqual(entry.key, key));
    if (existing !== undefined) return existing.id;
    const id = nextId++;
    chain.push({ key, id });
    chains.set(hash, chain);
    return id;
  };
  return {
    ours: ours.map(assign),
    theirs: theirs.map(assign),
    classCount: nextId,
  };
}

describe('classifyLines properties', () => {
  describe('Given arbitrary ours/theirs line arrays and an optional line key', () => {
    describe('When classifyLines assigns class ids', () => {
      it('Then two lines share a class id iff their (normalized) bytes are equal', () => {
        // Arrange
        const sut = classify;
        fc.assert(
          fc.property(
            arbLines(),
            arbLines(),
            fc.option(arbLineKey(), { nil: undefined }),
            (ours, theirs, lineKey) => {
              // Act
              const result = sut(ours, theirs, lineKey ?? undefined);
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
        const sut = classify;
        fc.assert(
          fc.property(
            arbLines(),
            arbLines(),
            fc.option(arbLineKey(), { nil: undefined }),
            (ours, theirs, lineKey) => {
              // Act
              const result = sut(ours, theirs, lineKey ?? undefined);
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

  describe('Given a caller supplying a hop-to-hop hash cache (one side, both sides, or neither)', () => {
    describe('When diffPresplitLines is given precomputed hashes instead of hashing from scratch', () => {
      it('Then the diff is identical to the from-scratch call in every combination', () => {
        // Arrange
        const sut = diffPresplitLines;
        fc.assert(
          fc.property(
            arbLines(),
            arbLines(),
            fc.option(arbLineKey(), { nil: undefined }),
            (ours, theirs, lineKey) => {
              const key = lineKey ?? undefined;
              const options: LineDiffOptions | undefined =
                key === undefined ? undefined : { lineKey: key };
              const oursHashes = hashLineSide(ours, key);
              const theirsHashes = hashLineSide(theirs, key);

              // Act
              const fromScratch = sut(ours, theirs, options);
              const bothPrecomputed = sut(ours, theirs, options, {
                ours: oursHashes,
                theirs: theirsHashes,
              });
              const oursOnlyPrecomputed = sut(ours, theirs, options, {
                ours: oursHashes,
              });
              const theirsOnlyPrecomputed = sut(ours, theirs, options, {
                theirs: theirsHashes,
              });

              // Assert
              expect(bothPrecomputed).toEqual(fromScratch);
              expect(oursOnlyPrecomputed).toEqual(fromScratch);
              expect(theirsOnlyPrecomputed).toEqual(fromScratch);
            },
          ),
          { numRuns: 100 },
        );
      });
    });
  });

  describe('Given arbitrary ours/theirs line arrays and an optional line key', () => {
    describe('When classifyLines assigns class ids', () => {
      it('Then ids are identical to an independent reference djb2 classifier', () => {
        // Arrange
        const sut = classify;
        fc.assert(
          fc.property(
            arbLines(),
            arbLines(),
            fc.option(arbLineKey(), { nil: undefined }),
            (ours, theirs, lineKey) => {
              const key = lineKey ?? undefined;

              // Act
              const result = sut(ours, theirs, key);
              const oracle = referenceClassify(ours, theirs, key);

              // Assert
              expect(Array.from(result.ours)).toEqual(oracle.ours);
              expect(Array.from(result.theirs)).toEqual(oracle.theirs);
              expect(result.classCount).toBe(oracle.classCount);
            },
          ),
          { numRuns: 100 },
        );
      });
    });
  });
});
