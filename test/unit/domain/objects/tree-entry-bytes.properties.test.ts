/**
 * Property tests for matchesDotgitAlias.
 *
 * Lens 2 (compositional matcher) fits: a needle variant followed by a tail is
 * an alias exactly when git's UTF-8 picker reads the whole tail as accepted
 * ignorable sequences, a slash always closes the name after a needle variant,
 * and neither arm reads past a sequence the picker rejects.
 *
 * Lens 3 (total function over an algebraic grammar) fits: any bytes and any
 * alias name yield a boolean without throwing.
 *
 * Lens 1 (round-trip pair) does not fit — the matcher has no serialise/parse
 * counterpart. Lens 4 (idempotence / 1:1 syntactic↔semantic count) does not
 * fit either — there is no re-parse step to compare against.
 */
import fc from 'fast-check';
import { describe, it } from 'vitest';
import {
  gitPickerSequenceLength,
  gitPickerValidPrefix,
} from '../../../../src/domain/objects/encoding.js';
import { matchesDotgitAlias } from '../../../../src/domain/objects/tree-entry-bytes.js';
import {
  arbDotgitAliasName,
  arbHfsIgnorableBytes,
  arbHfsNeedleVariant,
  arbPickerAcceptedSequences,
  arbPickerRejectedSequence,
  arbRawBytes,
} from './arbitraries.js';

const COMPOSITION_NUM_RUNS = 100;
const TOTAL_FUNCTION_NUM_RUNS = 100;
const TAIL_MIN_LENGTH = 1;
const TAIL_MAX_LENGTH = 4;
const SUFFIX_MAX_LENGTH = 8;
const MAX_TRAILING_SEQUENCES = 2;
const BYTE_MAX = 0xff;
const SLASH = 0x2f;
const NTFS_AND_NAME_TERMINATORS: readonly number[] = [
  0x00, // NUL cannot appear in a tree name
  0x20, // space
  0x2e, // dot
  0x2f, // slash
  0x3a, // colon
  0x5c, // backslash
];
const IGNORABLE_THREE_BYTE_LENGTH = 3;
const IGNORABLE_RANGES: readonly (readonly [number, number])[] = [
  [0x200c, 0x200f],
  [0x202a, 0x202e],
  [0x206a, 0x206f],
  [0xfeff, 0xfeff],
];

const encoder = new TextEncoder();
const IGNORABLE_SEQUENCES: readonly string[] = IGNORABLE_RANGES.flatMap(([low, high]) =>
  Array.from({ length: high - low + 1 }, (_, offset) =>
    [...encoder.encode(String.fromCodePoint(low + offset))].join(','),
  ),
);

const isIgnorableOnly = (bytes: Uint8Array): boolean => {
  let at = 0;
  while (at < bytes.length) {
    const length = gitPickerSequenceLength(bytes, at);
    const sequence = bytes.subarray(at, at + length).join(',');
    if (length !== IGNORABLE_THREE_BYTE_LENGTH || !IGNORABLE_SEQUENCES.includes(sequence)) {
      return false;
    }
    at += length;
  }
  return true;
};

const join = (...parts: readonly Uint8Array[]): Uint8Array =>
  Uint8Array.from(parts.flatMap((part) => [...part]));

const arbTailByte = (): fc.Arbitrary<number> =>
  fc.integer({ min: 0, max: BYTE_MAX }).filter((byte) => !NTFS_AND_NAME_TERMINATORS.includes(byte));

const arbRawTail = (maxLength: number): fc.Arbitrary<Uint8Array> =>
  fc.array(arbTailByte(), { maxLength }).map((bytes) => Uint8Array.from(bytes));

// Raw bytes almost never spell an ignorable sequence, so half the tails are
// built from whole ignorable sequences, optionally followed by raw bytes.
const arbTail = (): fc.Arbitrary<Uint8Array> =>
  fc.oneof(
    arbRawTail(TAIL_MAX_LENGTH).filter((tail) => tail.length >= TAIL_MIN_LENGTH),
    fc
      .tuple(
        fc.array(arbHfsIgnorableBytes(), {
          minLength: TAIL_MIN_LENGTH,
          maxLength: MAX_TRAILING_SEQUENCES,
        }),
        arbRawTail(TAIL_MAX_LENGTH),
      )
      .map(([hidden, raw]) => join(...hidden, raw)),
  );

describe('Given an arbitrary alias, a needle variant and a tail of 1-4 arbitrary bytes', () => {
  describe('When matched as a whole name', () => {
    it('Then it is an alias iff git ignores the whole picker-valid prefix of the tail', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(
          arbDotgitAliasName().chain((alias) =>
            fc.tuple(fc.constant(alias), arbHfsNeedleVariant(alias), arbTail()),
          ),
          ([alias, needle, tail]) => {
            const name = join(needle, tail);
            const sut = matchesDotgitAlias;

            const result = sut(name, 0, name.length, alias);

            return result === isIgnorableOnly(tail.subarray(0, gitPickerValidPrefix(tail)));
          },
        ),
        { numRuns: COMPOSITION_NUM_RUNS },
      );
    });
  });
});

describe('Given an arbitrary alias, a needle variant, ignorable sequences and a slash', () => {
  describe('When matched as a whole name followed by arbitrary bytes', () => {
    it('Then the slash ends the name and it is always an alias', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(
          arbDotgitAliasName().chain((alias) =>
            fc.tuple(
              fc.constant(alias),
              arbHfsNeedleVariant(alias),
              fc.array(arbHfsIgnorableBytes(), { maxLength: MAX_TRAILING_SEQUENCES }),
              arbRawBytes(SUFFIX_MAX_LENGTH),
            ),
          ),
          ([alias, needle, hidden, rest]) => {
            const name = join(needle, ...hidden, Uint8Array.of(SLASH), rest);
            const sut = matchesDotgitAlias;

            const result = sut(name, 0, name.length, alias);

            return result === true;
          },
        ),
        { numRuns: COMPOSITION_NUM_RUNS },
      );
    });
  });
});

describe('Given an arbitrary prefix, a picker-rejected sequence and two independent suffixes', () => {
  describe('When each whole name is matched', () => {
    it('Then both verdicts agree because nothing past the rejection is read', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(
          arbDotgitAliasName().chain((alias) =>
            fc.tuple(
              fc.constant(alias),
              fc.oneof(arbHfsNeedleVariant(alias), arbPickerAcceptedSequences()),
              arbPickerRejectedSequence(),
              arbRawBytes(SUFFIX_MAX_LENGTH),
              arbRawBytes(SUFFIX_MAX_LENGTH),
            ),
          ),
          ([alias, prefix, rejected, suffixX, suffixY]) => {
            const nameX = join(prefix, rejected, suffixX);
            const nameY = join(prefix, rejected, suffixY);
            const sut = matchesDotgitAlias;

            const resultX = sut(nameX, 0, nameX.length, alias);
            const resultY = sut(nameY, 0, nameY.length, alias);

            return resultX === resultY;
          },
        ),
        { numRuns: COMPOSITION_NUM_RUNS },
      );
    });
  });
});

describe('Given arbitrary bytes and an arbitrary alias name', () => {
  describe('When matched over the whole buffer', () => {
    it('Then it returns a boolean and never throws', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(arbRawBytes(), arbDotgitAliasName(), (bytes, alias) => {
          const sut = matchesDotgitAlias;

          const result = sut(bytes, 0, bytes.length, alias);

          return typeof result === 'boolean';
        }),
        { numRuns: TOTAL_FUNCTION_NUM_RUNS },
      );
    });
  });
});
