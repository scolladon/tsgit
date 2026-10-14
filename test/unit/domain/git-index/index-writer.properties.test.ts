import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { IndexEntry } from '../../../../src/domain/git-index/index-entry.js';
import { STAGE0_FLAGS } from '../../../../src/domain/git-index/index-entry.js';
import { compareEntryPath } from '../../../../src/domain/git-index/index-writer.js';
import { compareBytes, encode } from '../../../../src/domain/objects/encoding.js';
import type { FilePath, ObjectId } from '../../../../src/domain/objects/index.js';
import { FILE_MODE } from '../../../../src/domain/objects/index.js';

const NUM_RUNS = 200;

function entryAt(path: string): IndexEntry {
  return {
    ctimeSeconds: 0,
    ctimeNanoseconds: 0,
    mtimeSeconds: 0,
    mtimeNanoseconds: 0,
    dev: 0,
    ino: 0,
    mode: FILE_MODE.REGULAR,
    uid: 0,
    gid: 0,
    fileSize: 0,
    id: 'a'.repeat(40) as ObjectId,
    flags: STAGE0_FLAGS,
    path: path as FilePath,
  };
}

const MAX_CODE_POINT = 0x10ffff;
const SURROGATES = { min: 0xd800, max: 0xdfff };

// Boundary characters make shared prefixes and cross-plane first differences
// likely; the code-point branch covers the rest of the range minus lone
// surrogates, which have no UTF-8 form.
const arbUnit = fc.oneof(
  fc.constantFrom('a', 'b', '/', '\u07ff', '\ud7ff', '\ue000', '\uffff', '\u{10000}', '\u{10ffff}'),
  fc
    .integer({ min: 0, max: MAX_CODE_POINT })
    .filter((cp) => cp < SURROGATES.min || cp > SURROGATES.max)
    .map((cp) => String.fromCodePoint(cp)),
);
const arbPathText = fc.string({ unit: arbUnit, maxLength: 6 });

describe('compareEntryPath properties', () => {
  describe('Given arbitrary well-formed strings a and b', () => {
    describe('When comparing their entries', () => {
      it('Then the sign equals the sign of the UTF-8 byte comparison', () => {
        fc.assert(
          fc.property(arbPathText, arbPathText, (a, b) => {
            // Arrange
            const left = entryAt(a);
            const right = entryAt(b);

            // Act
            const sut = compareEntryPath;
            const result = sut(left, right);

            // Assert
            expect(Math.sign(result)).toBe(Math.sign(compareBytes(encode(a), encode(b))));
          }),
          { numRuns: NUM_RUNS },
        );
      });
    });
  });
});
