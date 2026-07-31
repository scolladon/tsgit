import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  BINARY_DETECTION_BYTES,
  isBinary,
  splitLines,
} from '../../../../src/domain/diff/line-diff.js';
import {
  createLineDigestScanner,
  type LineDigestScanner,
} from '../../../../src/domain/diff/line-digest-scanner.js';
import {
  digestIsBlank,
  type LineDigest,
  type LineKey,
} from '../../../../src/domain/diff/whitespace.js';
import { arbLineKey } from './arbitraries.js';
import { expectedDigest } from './digest-oracle.js';

// The scanner's whole alphabet in miniature: two hard bytes, both whitespace
// bytes, the CR that may or may not be a terminator, the LF that ends a line,
// and the NUL that flips the binary verdict.
const SCANNER_BYTES = [0x61, 0x62, 0x20, 0x09, 0x0d, 0x0a, 0x00] as const;
const PAD_BYTE = 0x61;
// A pad long enough to walk the NUL-detection budget up to (and past) its
// ceiling, so a NUL in the trailing core lands on either side of the window
// boundary and `scanForNul`'s remaining-budget arithmetic actually decides.
const PAD_SPREAD = 8;
const CORE_MAX = 48;

interface ScannerFeed {
  readonly blob: Uint8Array;
  readonly chunks: readonly Uint8Array[];
}

function arbBlob(): fc.Arbitrary<Uint8Array> {
  const padding = fc.oneof(
    fc.constant(0),
    fc.integer({
      min: BINARY_DETECTION_BYTES - PAD_SPREAD,
      max: BINARY_DETECTION_BYTES + PAD_SPREAD,
    }),
  );
  const core = fc.array(fc.constantFrom(...SCANNER_BYTES), { minLength: 0, maxLength: CORE_MAX });
  return fc.tuple(padding, core).map(([padLength, coreBytes]) => {
    const blob = new Uint8Array(padLength + coreBytes.length).fill(PAD_BYTE, 0, padLength);
    blob.set(coreBytes, padLength);
    return blob;
  });
}

/** Cut offsets over a blob — uniform ones plus ones drawn from the tail, where
 *  the NUL window boundary and every line break live. */
function arbSplitOffsets(length: number): fc.Arbitrary<readonly number[]> {
  const tailStart = Math.max(0, length - CORE_MAX - 2 * PAD_SPREAD);
  return fc
    .array(
      fc.oneof(fc.integer({ min: 0, max: length }), fc.integer({ min: tailStart, max: length })),
      { maxLength: 6 },
    )
    .map((offsets) => [...new Set(offsets)].sort((a, b) => a - b));
}

function arbScannerFeed(): fc.Arbitrary<ScannerFeed> {
  return arbBlob().chain((blob) =>
    arbSplitOffsets(blob.length).map((offsets) => {
      const cuts = [...offsets, blob.length];
      const chunks: Uint8Array[] = [];
      let start = 0;
      for (const cut of cuts) {
        chunks.push(blob.subarray(start, cut));
        start = cut;
      }
      return { blob, chunks };
    }),
  );
}

/** Drives the documented protocol: push a chunk, drain every digest it
 *  completes, push the next, then `end()` and drain the tail. */
function drainFed(sut: LineDigestScanner, chunks: readonly Uint8Array[]): LineDigest[] {
  const digests: LineDigest[] = [];
  const collect = (): void => {
    for (let step = sut.next(); step.kind === 'digest'; step = sut.next()) {
      digests.push(step.digest);
    }
  };
  for (const chunk of chunks) {
    sut.push(chunk);
    collect();
  }
  sut.end();
  collect();
  return digests;
}

/** The independent oracle: split the whole blob into lines, digest each one
 *  through `normalizeLine` + the reference fold, drop the blanks the scanner
 *  would skip. */
function oracleDigests(
  blob: Uint8Array,
  key: LineKey,
  ignoreBlankLines: boolean,
): ReadonlyArray<LineDigest> {
  const digests = splitLines(blob).map((line) => expectedDigest(line, key));
  return ignoreBlankLines ? digests.filter((digest) => !digestIsBlank(digest)) : digests;
}

describe('line digest scanner properties', () => {
  // Lens 4 (idempotence / counting invariant): the same bytes fed in any
  // chunking must re-parse to the same digest sequence, and must charge the
  // NUL-detection budget the same way. The chunk-split arithmetic in
  // `scanForNul` is the only part of the scanner a single-chunk feed cannot
  // reach at all.
  describe('Given an arbitrary blob over {a, b, SP, TAB, CR, LF, NUL} cut at arbitrary offsets', () => {
    describe('When the scanner drains the split chunks and, separately, the whole blob', () => {
      it('Then both drains equal the per-line oracle and both binary flags equal the whole-blob sniff', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(
            arbScannerFeed(),
            arbLineKey(),
            fc.boolean(),
            ({ blob, chunks }, key, ignoreBlankLines) => {
              const splitFed = createLineDigestScanner(key, ignoreBlankLines);
              const wholeFed = createLineDigestScanner(key, ignoreBlankLines);

              const splitDigests = drainFed(splitFed, chunks);
              const wholeDigests = drainFed(wholeFed, [blob]);

              const binary = isBinary(blob);
              expect(splitFed.binary).toBe(binary);
              expect(wholeFed.binary).toBe(binary);
              // A binary side stops emitting the moment the flag is observed,
              // which is a different line for a split feed than for a whole
              // one — only the flag itself is split-invariant there.
              if (binary) return;
              expect(splitDigests).toEqual(wholeDigests);
              expect(splitDigests).toEqual(oracleDigests(blob, key, ignoreBlankLines));
            },
          ),
          { numRuns: 200 },
        );
      });
    });
  });
});
