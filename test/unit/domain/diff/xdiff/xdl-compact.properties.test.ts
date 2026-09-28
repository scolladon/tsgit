import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { diffLines } from '../../../../../src/domain/diff/line-diff.js';

// Arbitrary line bodies drawn from a small, collision-prone alphabet so
// repeated content (the substance compaction slides on) is common at a small
// array size — mirroring xdl-classify.properties.test.ts's approach.
const LINE_BODIES = ['a', 'b', 'c', 'd'] as const;

function arbLines(): fc.Arbitrary<string> {
  return fc
    .array(fc.constantFrom(...LINE_BODIES), { minLength: 0, maxLength: 8 })
    .map((bodies) => bodies.map((b) => `${b}\n`).join(''));
}

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

function multiset(lines: ReadonlyArray<Uint8Array>): ReadonlyArray<string> {
  const decoder = new TextDecoder();
  return lines.map((line) => decoder.decode(line)).sort();
}

describe('diffLines compaction properties', () => {
  describe('Given arbitrary ours/theirs line bodies', () => {
    describe('When diffLines runs compaction over the raw Myers script', () => {
      it('Then the added/deleted line counts are unchanged from the raw script’s', () => {
        // Arrange
        const sut = diffLines;
        fc.assert(
          fc.property(arbLines(), arbLines(), (oursText, theirsText) => {
            // Act
            const result = sut(enc(oursText), enc(theirsText));

            // Assert — every hunk kind partitions oursLines/theirsLines exactly once
            let oursCovered = 0;
            let theirsCovered = 0;
            for (const hunk of result.hunks) {
              if (hunk.kind !== 'theirs-only') oursCovered += hunk.oursEnd - hunk.oursStart;
              if (hunk.kind !== 'ours-only') theirsCovered += hunk.theirsEnd - hunk.theirsStart;
            }
            expect(oursCovered).toBe(result.oursLines.length);
            expect(theirsCovered).toBe(result.theirsLines.length);
          }),
          { numRuns: 100 },
        );
      });

      it('Then the multiset of common lines is unchanged and hunks reconstruct both sides', () => {
        // Arrange
        const sut = diffLines;
        fc.assert(
          fc.property(arbLines(), arbLines(), (oursText, theirsText) => {
            // Act
            const result = sut(enc(oursText), enc(theirsText));

            // Assert — walking the hunks in order reproduces oursLines/theirsLines
            const decoder = new TextDecoder();
            const reconstructedOurs: string[] = [];
            const reconstructedTheirs: string[] = [];
            for (const hunk of result.hunks) {
              for (let i = hunk.oursStart; i < hunk.oursEnd; i++) {
                reconstructedOurs.push(decoder.decode(result.oursLines[i]!));
              }
              for (let j = hunk.theirsStart; j < hunk.theirsEnd; j++) {
                reconstructedTheirs.push(decoder.decode(result.theirsLines[j]!));
              }
            }
            expect(reconstructedOurs.join('')).toBe(oursText);
            expect(reconstructedTheirs.join('')).toBe(theirsText);
          }),
          { numRuns: 100 },
        );
      });

      it('Then common-hunk lines are byte-equal on both sides (no lineKey)', () => {
        // Arrange
        const sut = diffLines;
        fc.assert(
          fc.property(arbLines(), arbLines(), (oursText, theirsText) => {
            // Act
            const result = sut(enc(oursText), enc(theirsText));

            // Assert
            for (const hunk of result.hunks) {
              if (hunk.kind !== 'common') continue;
              const oursSlice = result.oursLines.slice(hunk.oursStart, hunk.oursEnd);
              const theirsSlice = result.theirsLines.slice(hunk.theirsStart, hunk.theirsEnd);
              expect(multiset(oursSlice)).toEqual(multiset(theirsSlice));
            }
          }),
          { numRuns: 100 },
        );
      });
    });
  });
});
