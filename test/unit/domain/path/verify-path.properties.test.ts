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
