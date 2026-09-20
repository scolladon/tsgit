import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  feedParseAcceptance,
  needsParentLookups,
  parseAcceptanceVerdict,
  startParseAcceptance,
} from '../../../../src/domain/objects/parse-acceptance.js';
import {
  arbCutPoints,
  arbParseAcceptanceCase,
  arbParseAcceptanceRawCase,
  splitAtCuts,
} from './arbitraries.js';

const scanWhole = (
  objectType: 'commit' | 'tag',
  hexLength: 40 | 64,
  body: Uint8Array,
): ReturnType<typeof startParseAcceptance> =>
  feedParseAcceptance(startParseAcceptance(objectType, hexLength), body);

const scanChunked = (
  objectType: 'commit' | 'tag',
  hexLength: 40 | 64,
  chunks: ReadonlyArray<Uint8Array>,
): ReturnType<typeof startParseAcceptance> =>
  chunks.reduce(
    (scan, chunk) => feedParseAcceptance(scan, chunk),
    startParseAcceptance(objectType, hexLength),
  );

describe('parse-acceptance properties', () => {
  describe('Given an arbitrary commit or tag body and an arbitrary chunk partition of it', () => {
    describe('When the same bytes are fed whole vs. chunk by chunk', () => {
      it('Then the verdict and needsParentLookups agree regardless of the split', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(
            arbParseAcceptanceCase().chain((testCase) =>
              arbCutPoints(testCase.body.length).map((cuts) => ({ ...testCase, cuts })),
            ),
            ({ objectType, hexLength, body, cuts }) => {
              const whole = scanWhole(objectType, hexLength, body);
              const chunked = scanChunked(objectType, hexLength, splitAtCuts(body, cuts));

              expect(needsParentLookups(chunked)).toBe(needsParentLookups(whole));
              for (const parentLookups of ['checked', 'skipped'] as const) {
                expect(parseAcceptanceVerdict(chunked, { parentLookups })).toEqual(
                  parseAcceptanceVerdict(whole, { parentLookups }),
                );
              }
            },
          ),
          { numRuns: 100 },
        );
      });
    });
  });

  describe('Given arbitrary bytes and an arbitrary chunk partition, with no grammar shape at all', () => {
    describe('When feedParseAcceptance is fed each chunk in turn', () => {
      it('Then it never throws', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(
            arbParseAcceptanceRawCase().chain((testCase) =>
              arbCutPoints(testCase.body.length).map((cuts) => ({ ...testCase, cuts })),
            ),
            ({ objectType, hexLength, body, cuts }) => {
              expect(() =>
                scanChunked(objectType, hexLength, splitAtCuts(body, cuts)),
              ).not.toThrow();
              for (const parentLookups of ['checked', 'skipped'] as const) {
                const scan = scanChunked(objectType, hexLength, splitAtCuts(body, cuts));
                expect(() => parseAcceptanceVerdict(scan, { parentLookups })).not.toThrow();
              }
            },
          ),
          { numRuns: 200 },
        );
      });
    });
  });
});
