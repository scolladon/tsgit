import { describe, expect, it } from 'vitest';
import {
  exceedsMaxCommitMessageBytes,
  exceedsMaxIndexBytes,
  exceedsMaxPackIdxBytes,
  exceedsMaxPeelDepth,
  exceedsMaxSymbolicDepth,
  exceedsMaxTreeDepth,
  exceedsMaxTreeEntries,
  exceedsMaxWalkSeeds,
  hasDeclaredId,
  hasHeaderInjectionChars,
  isContainedRefSegment,
  isEmptyFrom,
  isGitlink,
  isHead,
  isInvalidExtraHeaderKey,
  looksLikeObjectId,
  MAX_PACK_IDX_BYTES,
  messageContainsNul,
  REASON_EXTRA_HEADER_KEY_INVALID,
  REASON_INDEX_CHECKSUM_MISMATCH,
  REASON_INDEX_EXCEEDS_MAX,
  REASON_MESSAGE_CONTAINS_NUL,
  REASON_MESSAGE_EXCEEDS_MAX,
  REASON_PACK_IDX_EXCEEDS_MAX,
  REASON_TARGET_ESCAPES_GIT_DIR,
  REASON_WALK_EMPTY_FROM,
  REASON_WALK_TOO_MANY_SEEDS,
} from '../../../../src/application/primitives/validators.js';

describe('isEmptyFrom', () => {
  it('Given empty array, Then returns true', () => {
    // Arrange
    // Assert
    expect(isEmptyFrom([])).toBe(true);
  });
  it('Given one-element array, Then returns false', () => {
    // Arrange
    // Assert
    expect(isEmptyFrom(['a'])).toBe(false);
  });
});

describe('exceedsMaxWalkSeeds boundary triple', () => {
  it('Given 1023 elements (just-under MAX_WALK_SEEDS), Then returns false', () => {
    // Arrange
    // Assert
    expect(exceedsMaxWalkSeeds(new Array(1023).fill(0))).toBe(false);
  });
  it('Given 1024 elements (at cap), Then returns false', () => {
    // Arrange
    // Assert
    expect(exceedsMaxWalkSeeds(new Array(1024).fill(0))).toBe(false);
  });
  it('Given 1025 elements (just-over cap), Then returns true', () => {
    // Arrange
    // Assert
    expect(exceedsMaxWalkSeeds(new Array(1025).fill(0))).toBe(true);
  });
});

describe('messageContainsNul', () => {
  it('Given a NUL byte anywhere in the string, Then returns true', () => {
    // Arrange
    // Assert
    expect(messageContainsNul('a\0b')).toBe(true);
  });
  it('Given a clean message, Then returns false', () => {
    // Arrange
    // Assert
    expect(messageContainsNul('hello world')).toBe(false);
  });
  it('Given an empty string, Then returns false', () => {
    // Arrange
    // Assert
    expect(messageContainsNul('')).toBe(false);
  });
});

describe('exceedsMaxCommitMessageBytes boundary triple', () => {
  it('Given message of 16 MiB − 1 bytes (just-under), Then returns false', () => {
    // Arrange
    // Assert
    expect(exceedsMaxCommitMessageBytes('x'.repeat(16 * 1024 * 1024 - 1))).toBe(false);
  });
  it('Given message of exactly 16 MiB (at cap), Then returns false', () => {
    // Arrange
    // Assert
    expect(exceedsMaxCommitMessageBytes('x'.repeat(16 * 1024 * 1024))).toBe(false);
  });
  it('Given message of 16 MiB + 1 bytes (just-over), Then returns true', () => {
    // Arrange
    // Assert
    expect(exceedsMaxCommitMessageBytes('x'.repeat(16 * 1024 * 1024 + 1))).toBe(true);
  });
});

describe('exceedsMaxIndexBytes boundary triple', () => {
  it('Given size 256 MiB − 1 (just-under), Then returns false', () => {
    // Arrange
    // Assert
    expect(exceedsMaxIndexBytes(256 * 1024 * 1024 - 1)).toBe(false);
  });
  it('Given size 256 MiB (at cap), Then returns false', () => {
    // Arrange
    // Assert
    expect(exceedsMaxIndexBytes(256 * 1024 * 1024)).toBe(false);
  });
  it('Given size 256 MiB + 1 (just-over), Then returns true', () => {
    // Arrange
    // Assert
    expect(exceedsMaxIndexBytes(256 * 1024 * 1024 + 1)).toBe(true);
  });
});

describe('exceedsMaxSymbolicDepth boundary triple (default cap = 5)', () => {
  it('Given depth 4 (just-under), Then returns false', () => {
    // Arrange
    // Assert
    expect(exceedsMaxSymbolicDepth(4)).toBe(false);
  });
  it('Given depth 5 (at cap), Then returns false', () => {
    // Arrange
    // Assert
    expect(exceedsMaxSymbolicDepth(5)).toBe(false);
  });
  it('Given depth 6 (just-over), Then returns true', () => {
    // Arrange
    // Assert
    expect(exceedsMaxSymbolicDepth(6)).toBe(true);
  });
  it('Given depth 6 with custom cap 10, Then returns false (cap override works)', () => {
    // Arrange
    // Assert
    expect(exceedsMaxSymbolicDepth(6, 10)).toBe(false);
  });
});

describe('exceedsMaxPeelDepth boundary triple (default cap = 5)', () => {
  it('Given depth 4, Then returns false', () => {
    // Arrange
    // Assert
    expect(exceedsMaxPeelDepth(4)).toBe(false);
  });
  it('Given depth 5, Then returns false', () => {
    // Arrange
    // Assert
    expect(exceedsMaxPeelDepth(5)).toBe(false);
  });
  it('Given depth 6, Then returns true', () => {
    // Arrange
    // Assert
    expect(exceedsMaxPeelDepth(6)).toBe(true);
  });
});

describe('isContainedRefSegment', () => {
  it('Given "refs/heads/main", Then returns true (baseline accept)', () => {
    // Arrange
    // Assert
    expect(isContainedRefSegment('refs/heads/main')).toBe(true);
  });
  it('Given "HEAD", Then returns true', () => {
    // Arrange
    // Assert
    expect(isContainedRefSegment('HEAD')).toBe(true);
  });
  it('Given a name starting with /, Then returns false (absolute)', () => {
    // Arrange
    // Assert
    expect(isContainedRefSegment('/etc/passwd')).toBe(false);
  });
  it('Given a name containing backslash, Then returns false (Windows drive)', () => {
    // Arrange
    // Assert
    expect(isContainedRefSegment('refs\\heads\\main')).toBe(false);
  });
  it('Given a name containing colon, Then returns false (UNC/drive)', () => {
    // Arrange
    // Assert
    expect(isContainedRefSegment('C:/foo')).toBe(false);
  });
  it('Given a name containing .., Then returns false (traversal)', () => {
    // Arrange
    // Assert
    expect(isContainedRefSegment('refs/../escape')).toBe(false);
  });
});

describe('isHead', () => {
  it('Given "HEAD", Then returns true', () => {
    // Arrange
    // Assert
    expect(isHead('HEAD')).toBe(true);
  });
  it('Given "refs/heads/main", Then returns false', () => {
    // Arrange
    // Assert
    expect(isHead('refs/heads/main')).toBe(false);
  });
  it('Given "head" (lowercase), Then returns false (case-sensitive)', () => {
    // Arrange
    // Assert
    expect(isHead('head')).toBe(false);
  });
});

describe('isGitlink', () => {
  it('Given "160000", Then returns true', () => {
    // Arrange
    // Assert
    expect(isGitlink('160000')).toBe(true);
  });
  it('Given "100644" (blob), Then returns false', () => {
    // Arrange
    // Assert
    expect(isGitlink('100644')).toBe(false);
  });
  it('Given "040000" (tree), Then returns false', () => {
    // Arrange
    // Assert
    expect(isGitlink('040000')).toBe(false);
  });
});

describe('exceedsMaxTreeDepth boundary triple', () => {
  it('Given depth 4 with cap 5, Then returns false', () => {
    // Arrange
    // Assert
    expect(exceedsMaxTreeDepth(4, 5)).toBe(false);
  });
  it('Given depth 5 with cap 5, Then returns false (at)', () => {
    // Arrange
    // Assert
    expect(exceedsMaxTreeDepth(5, 5)).toBe(false);
  });
  it('Given depth 6 with cap 5, Then returns true', () => {
    // Arrange
    // Assert
    expect(exceedsMaxTreeDepth(6, 5)).toBe(true);
  });
});

describe('exceedsMaxTreeEntries boundary triple', () => {
  it('Given count 2 with cap 3, Then returns false', () => {
    // Arrange
    // Assert
    expect(exceedsMaxTreeEntries(2, 3)).toBe(false);
  });
  it('Given count 3 with cap 3, Then returns false (at)', () => {
    // Arrange
    // Assert
    expect(exceedsMaxTreeEntries(3, 3)).toBe(false);
  });
  it('Given count 4 with cap 3, Then returns true', () => {
    // Arrange
    // Assert
    expect(exceedsMaxTreeEntries(4, 3)).toBe(true);
  });
});

describe('looksLikeObjectId', () => {
  it('Given a 40-char hex string, Then returns true (SHA1)', () => {
    // Arrange
    // Assert
    expect(looksLikeObjectId('0123456789abcdef0123456789abcdef01234567')).toBe(true);
  });
  it('Given a 64-char hex string, Then returns true (SHA256)', () => {
    // Arrange
    // Assert
    expect(looksLikeObjectId('a'.repeat(64))).toBe(true);
  });
  it('Given a 39-char hex string, Then returns false (too short)', () => {
    // Arrange
    // Assert
    expect(looksLikeObjectId('0'.repeat(39))).toBe(false);
  });
  it('Given a 41-char hex string, Then returns false (not SHA1 or SHA256)', () => {
    // Arrange
    // Assert
    expect(looksLikeObjectId('0'.repeat(41))).toBe(false);
  });
  it('Given 40 chars with uppercase, Then returns false (only lowercase accepted)', () => {
    // Arrange
    // Assert
    expect(looksLikeObjectId('A'.repeat(40))).toBe(false);
  });
  it('Given a ref-like string, Then returns false', () => {
    // Arrange
    // Assert
    expect(looksLikeObjectId('refs/heads/main')).toBe(false);
  });
  it('Given an empty string, Then returns false', () => {
    // Arrange
    // Assert
    expect(looksLikeObjectId('')).toBe(false);
  });
});

describe('hasDeclaredId', () => {
  it('Given an empty string, Then returns false', () => {
    // Arrange
    // Assert
    expect(hasDeclaredId('')).toBe(false);
  });
  it('Given a hex id, Then returns true', () => {
    // Arrange
    // Assert
    expect(hasDeclaredId('0'.repeat(40))).toBe(true);
  });
});

describe('isInvalidExtraHeaderKey', () => {
  it('Given a clean key like "mergetag", Then returns false', () => {
    // Arrange
    // Assert
    expect(isInvalidExtraHeaderKey('mergetag')).toBe(false);
  });
  it('Given an empty key, Then returns true', () => {
    // Arrange
    // Assert
    expect(isInvalidExtraHeaderKey('')).toBe(true);
  });
  it('Given a key with NUL, Then returns true', () => {
    // Arrange
    // Assert
    expect(isInvalidExtraHeaderKey('a\0b')).toBe(true);
  });
  it('Given a key with CR, Then returns true', () => {
    // Arrange
    // Assert
    expect(isInvalidExtraHeaderKey('a\rb')).toBe(true);
  });
  it('Given a key with LF, Then returns true', () => {
    // Arrange
    // Assert
    expect(isInvalidExtraHeaderKey('a\nb')).toBe(true);
  });
  it('Given a key with a space, Then returns true (space is the key/value separator)', () => {
    // Arrange
    // Assert
    expect(isInvalidExtraHeaderKey('two words')).toBe(true);
  });
  it('Given a key with a tab, Then returns true', () => {
    // Arrange
    // Assert
    expect(isInvalidExtraHeaderKey('a\tb')).toBe(true);
  });
});

describe('hasHeaderInjectionChars', () => {
  it('Given a clean value, When hasHeaderInjectionChars, Then returns false', () => {
    // Arrange & Act
    const sut = hasHeaderInjectionChars('a clean header value');

    // Assert
    expect(sut).toBe(false);
  });

  it('Given a value containing NUL, When hasHeaderInjectionChars, Then returns true', () => {
    // Arrange
    // Assert
    expect(hasHeaderInjectionChars('a\0b')).toBe(true);
  });

  it('Given a value containing CR, When hasHeaderInjectionChars, Then returns true', () => {
    // Arrange
    // Assert
    expect(hasHeaderInjectionChars('a\rb')).toBe(true);
  });

  it('Given a value containing a double LF, When hasHeaderInjectionChars, Then returns true', () => {
    // Arrange
    // Assert
    expect(hasHeaderInjectionChars('a\n\nb')).toBe(true);
  });

  it('Given a value with a LEADING LF only (no trailing LF), When hasHeaderInjectionChars, Then returns true', () => {
    // Arrange
    // Isolates the `value.startsWith(\'\\n\')` operand: trailing is false here,
    // so an `&&` mutant or a dropped startsWith operand would return false.
    const sut = hasHeaderInjectionChars('\nabc');

    // Assert
    expect(sut).toBe(true);
  });

  it('Given a value with a TRAILING LF only (no leading LF), When hasHeaderInjectionChars, Then returns true', () => {
    // Arrange
    // Isolates the `value.endsWith(\'\\n\')` operand: leading is false here,
    // so an `&&` mutant or a dropped endsWith operand would return false.
    const sut = hasHeaderInjectionChars('abc\n');

    // Assert
    expect(sut).toBe(true);
  });

  it('Given a value with an INTERIOR single LF only, When hasHeaderInjectionChars, Then returns false', () => {
    // Arrange
    // No NUL/CR, no `\n\n`, not leading/trailing — every guard must be false.
    const sut = hasHeaderInjectionChars('a\nb');

    // Assert
    expect(sut).toBe(false);
  });
});

describe('exceedsMaxPackIdxBytes boundary triple', () => {
  it('Given size MAX_PACK_IDX_BYTES − 1 (just-under), Then returns false', () => {
    // Arrange
    // Assert
    expect(exceedsMaxPackIdxBytes(MAX_PACK_IDX_BYTES - 1)).toBe(false);
  });
  it('Given size MAX_PACK_IDX_BYTES (at cap), Then returns false', () => {
    // Arrange
    // Assert
    expect(exceedsMaxPackIdxBytes(MAX_PACK_IDX_BYTES)).toBe(false);
  });
  it('Given size MAX_PACK_IDX_BYTES + 1 (just-over), Then returns true', () => {
    // Arrange
    // Assert
    expect(exceedsMaxPackIdxBytes(MAX_PACK_IDX_BYTES + 1)).toBe(true);
  });
});

describe('error-reason constants are stable identifiers', () => {
  it('REASON_WALK_EMPTY_FROM matches expected string', () => {
    // Arrange
    // Assert
    expect(REASON_WALK_EMPTY_FROM).toBe('empty from');
  });
  it('REASON_WALK_TOO_MANY_SEEDS matches expected string', () => {
    // Arrange
    // Assert
    expect(REASON_WALK_TOO_MANY_SEEDS).toBe('too many seeds');
  });
  it('REASON_MESSAGE_CONTAINS_NUL matches expected string', () => {
    // Arrange
    // Assert
    expect(REASON_MESSAGE_CONTAINS_NUL).toBe('message contains NUL');
  });
  it('REASON_MESSAGE_EXCEEDS_MAX matches expected string', () => {
    // Arrange
    // Assert
    expect(REASON_MESSAGE_EXCEEDS_MAX).toBe('message exceeds 16 MiB');
  });
  it('REASON_INDEX_EXCEEDS_MAX matches expected string', () => {
    // Arrange
    // Assert
    expect(REASON_INDEX_EXCEEDS_MAX).toBe('index file exceeds 256 MiB');
  });
  it('REASON_TARGET_ESCAPES_GIT_DIR matches expected string', () => {
    // Arrange
    // Assert
    expect(REASON_TARGET_ESCAPES_GIT_DIR).toBe('target escapes gitDir');
  });
  it('REASON_INDEX_CHECKSUM_MISMATCH matches expected string', () => {
    // Arrange
    // Assert
    expect(REASON_INDEX_CHECKSUM_MISMATCH).toBe('index trailer checksum mismatch');
  });
  it('REASON_PACK_IDX_EXCEEDS_MAX matches expected string', () => {
    // Arrange
    // Assert
    expect(REASON_PACK_IDX_EXCEEDS_MAX).toBe('pack .idx file exceeds 64 MiB');
  });
  it('REASON_EXTRA_HEADER_KEY_INVALID matches expected string', () => {
    // Arrange
    // Assert
    expect(REASON_EXTRA_HEADER_KEY_INVALID).toBe('extraHeader key contains forbidden characters');
  });
});
