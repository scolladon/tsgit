/**
 * Property tests for verifyPath / isDotGitAlias.
 *
 * Lens 3 (total function over an algebraic grammar) fits directly: verifyPath
 * must never throw for any string/FileMode pair, and must always return a
 * VerifyPathRejection or undefined.
 *
 * Lens 2 (compositional matcher) partially fits isDotGitAlias: joining two
 * non-alias components with a backslash never produces an alias, and only a
 * codepoint from the closed ignorable set can hide inside the HFS `.g<CP>it`
 * form — any other codepoint keeps it accepted.
 *
 * Lens 1 (round-trip pair) does not fit — verifyPath has no serialise/decode
 * counterpart to round-trip against. Lens 4 (idempotence / 1:1 syntactic↔
 * semantic count) does not fit either — there is no re-parse step, and the
 * alias families are already exhaustively enumerated by the example matrix
 * rather than counted from a syntactic feature.
 */
import fc from 'fast-check';
import { describe, it } from 'vitest';
import { FILE_MODE, type FileMode } from '../../../../src/domain/objects/file-mode.js';
import {
  gitPickerValidPrefix,
  isDotGitAlias,
  type VerifyPathRejection,
  verifyPath,
} from '../../../../src/domain/path/verify-path.js';
import {
  arbComponentPair,
  arbIgnorableCodepoint,
  arbSafeAsciiPath,
  arbStringWithIgnorableCodepoint,
} from './arbitraries.js';

const TOTAL_FUNCTION_NUM_RUNS = 100;
const COMPOSITION_NUM_RUNS = 100;

// Non-ignorable printable ASCII — none of it falls inside the HFS ignorable
// codepoint ranges (all above 0x7e), so it is safe filler for the insertion
// property below regardless of which character is drawn.
const PRINTABLE_ASCII_MIN = 0x21;
const PRINTABLE_ASCII_MAX = 0x7e;

const VERIFY_PATH_REJECTIONS: ReadonlySet<VerifyPathRejection> = new Set([
  'absolute-path',
  'empty-segment',
  'dot-segment',
  'dotdot-segment',
  'dotgit-alias',
  'dotgit-ntfs-alias',
  'dotgit-ntfs-stream',
  'dotgit-hfs-alias',
  'gitmodules-not-regular',
]);

function arbFileMode(): fc.Arbitrary<FileMode> {
  return fc.constantFrom(...Object.values(FILE_MODE));
}

function isValidRejectionOrUndefined(result: VerifyPathRejection | undefined): boolean {
  return result === undefined || VERIFY_PATH_REJECTIONS.has(result);
}

describe('Given an arbitrary string and file mode', () => {
  describe('When verifyPath is called', () => {
    it('Then it never throws and always returns a rejection reason or undefined', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(
          fc.oneof(fc.string(), arbStringWithIgnorableCodepoint()),
          arbFileMode(),
          (path, mode) => isValidRejectionOrUndefined(verifyPath(path, mode)),
        ),
        { numRuns: TOTAL_FUNCTION_NUM_RUNS },
      );
    });
  });
});

describe('Given two arbitrary alias-adjacent path components, neither itself a .git alias', () => {
  describe('When they are joined with a backslash', () => {
    it('Then the joined component is still not a .git alias', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(arbComponentPair(), ([left, right]) => {
          fc.pre(!isDotGitAlias(left) && !isDotGitAlias(right));
          return !isDotGitAlias(`${left}\\${right}`);
        }),
        { numRuns: COMPOSITION_NUM_RUNS },
      );
    });
  });
});

describe('Given the HFS `.git` alias split as `.g` and `it`', () => {
  describe('When an arbitrary non-ignorable codepoint is inserted between them', () => {
    it('Then the resulting component is still accepted (only the closed ignorable set hides inside the alias)', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(
          fc.integer({ min: PRINTABLE_ASCII_MIN, max: PRINTABLE_ASCII_MAX }),
          (codepoint) => {
            const inserted = String.fromCodePoint(codepoint);
            return !isDotGitAlias(`.g${inserted}it`);
          },
        ),
        { numRuns: COMPOSITION_NUM_RUNS },
      );
    });
  });

  describe('When an arbitrary codepoint from the closed ignorable set is inserted between them', () => {
    it('Then the resulting component is always rejected as a dotgit-hfs-alias', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(arbIgnorableCodepoint(), (codepoint) => {
          const inserted = String.fromCodePoint(codepoint);
          return isDotGitAlias(`.g${inserted}it`);
        }),
        { numRuns: COMPOSITION_NUM_RUNS },
      );
    });
  });
});

describe('Given an arbitrary non-empty path built only from safe (non-alias) ASCII components', () => {
  describe('When verified at the regular-file mode', () => {
    it('Then it is always accepted', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(arbSafeAsciiPath(), (path) => {
          fc.pre(path !== '');
          return verifyPath(path, FILE_MODE.REGULAR) === undefined;
        }),
        { numRuns: COMPOSITION_NUM_RUNS },
      );
    });
  });
});

const HFS_TAIL_MAX_LENGTH = 4;
const BYTE_MAX = 0xff;
const NUL = 0x00;
const SLASH = 0x2f;
const DOT = 0x2e;
const SPACE = 0x20;
const DOTGIT_BYTES = [0x2e, 0x67, 0x69, 0x74];
const IGNORABLE_BYTE_SEQUENCES: readonly (readonly number[])[] = [
  [0xe2, 0x80, 0x8c],
  [0xe2, 0x80, 0x8d],
  [0xe2, 0x80, 0x8e],
  [0xe2, 0x80, 0x8f],
  [0xef, 0xbb, 0xbf],
];

// Dot and space are the NTFS trailing-strip characters: their verdicts belong
// to the NTFS arm, not to the HFS tail rule this property pins.
const EXCLUDED_TAIL_BYTES: readonly number[] = [SLASH, NUL, DOT, SPACE];

const arbTailByte = (): fc.Arbitrary<number> =>
  fc.integer({ min: 0, max: BYTE_MAX }).filter((byte) => !EXCLUDED_TAIL_BYTES.includes(byte));

const isIgnorableOnly = (tail: readonly number[]): boolean => {
  let at = 0;
  while (at < tail.length) {
    const match = IGNORABLE_BYTE_SEQUENCES.find((sequence) =>
      sequence.every((byte, offset) => tail[at + offset] === byte),
    );
    if (match === undefined) return false;
    at += match.length;
  }
  return true;
};

const decodesToIgnorableOnly = (tail: readonly number[]): boolean => {
  const validPrefix = gitPickerValidPrefix(Uint8Array.from(tail));
  return isIgnorableOnly(tail.slice(0, validPrefix));
};

describe('Given the component bytes .git followed by 1-4 arbitrary bytes', () => {
  describe('When verified with the raw bytes', () => {
    it('Then it is a dotgit-hfs-alias iff git ignores the whole tail', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(
          fc.array(arbTailByte(), { minLength: 1, maxLength: HFS_TAIL_MAX_LENGTH }),
          (tail) => {
            const bytes = Uint8Array.from([...DOTGIT_BYTES, ...tail]);
            const view = new TextDecoder().decode(bytes);
            const verdict = verifyPath(view, FILE_MODE.REGULAR, bytes);
            return (verdict === 'dotgit-hfs-alias') === decodesToIgnorableOnly(tail);
          },
        ),
        { numRuns: COMPOSITION_NUM_RUNS },
      );
    });
  });
});
