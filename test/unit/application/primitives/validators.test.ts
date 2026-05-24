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
  it('Given empty array, When invoked, Then returns true', () => {
    // Arrange
    const sut = isEmptyFrom([]);

    // Assert
    expect(sut).toBe(true);
  });
  it('Given one-element array, When invoked, Then returns false', () => {
    // Arrange
    const sut = isEmptyFrom(['a']);

    // Assert
    expect(sut).toBe(false);
  });
});

describe('exceedsMaxWalkSeeds boundary triple', () => {
  it('Given 1023 elements (just-under MAX_WALK_SEEDS), When invoked, Then returns false', () => {
    // Arrange
    const sut = exceedsMaxWalkSeeds(new Array(1023).fill(0));

    // Assert
    expect(sut).toBe(false);
  });
  it('Given 1024 elements (at cap), When invoked, Then returns false', () => {
    // Arrange
    const sut = exceedsMaxWalkSeeds(new Array(1024).fill(0));

    // Assert
    expect(sut).toBe(false);
  });
  it('Given 1025 elements (just-over cap), When invoked, Then returns true', () => {
    // Arrange
    const sut = exceedsMaxWalkSeeds(new Array(1025).fill(0));

    // Assert
    expect(sut).toBe(true);
  });
});

describe('messageContainsNul', () => {
  it('Given a NUL byte anywhere in the string, When invoked, Then returns true', () => {
    // Arrange
    const sut = messageContainsNul('a\0b');

    // Assert
    expect(sut).toBe(true);
  });
  it('Given a clean message, When invoked, Then returns false', () => {
    // Arrange
    const sut = messageContainsNul('hello world');

    // Assert
    expect(sut).toBe(false);
  });
  it('Given an empty string, When invoked, Then returns false', () => {
    // Arrange
    const sut = messageContainsNul('');

    // Assert
    expect(sut).toBe(false);
  });
});

describe('exceedsMaxCommitMessageBytes boundary triple', () => {
  it('Given message of 16 MiB − 1 bytes (just-under), When invoked, Then returns false', () => {
    // Arrange
    const sut = exceedsMaxCommitMessageBytes('x'.repeat(16 * 1024 * 1024 - 1));

    // Assert
    expect(sut).toBe(false);
  });
  it('Given message of exactly 16 MiB (at cap), When invoked, Then returns false', () => {
    // Arrange
    const sut = exceedsMaxCommitMessageBytes('x'.repeat(16 * 1024 * 1024));

    // Assert
    expect(sut).toBe(false);
  });
  it('Given message of 16 MiB + 1 bytes (just-over), When invoked, Then returns true', () => {
    // Arrange
    const sut = exceedsMaxCommitMessageBytes('x'.repeat(16 * 1024 * 1024 + 1));

    // Assert
    expect(sut).toBe(true);
  });
});

describe('exceedsMaxIndexBytes boundary triple', () => {
  it('Given size 256 MiB − 1 (just-under), When invoked, Then returns false', () => {
    // Arrange
    const sut = exceedsMaxIndexBytes(256 * 1024 * 1024 - 1);

    // Assert
    expect(sut).toBe(false);
  });
  it('Given size 256 MiB (at cap), When invoked, Then returns false', () => {
    // Arrange
    const sut = exceedsMaxIndexBytes(256 * 1024 * 1024);

    // Assert
    expect(sut).toBe(false);
  });
  it('Given size 256 MiB + 1 (just-over), When invoked, Then returns true', () => {
    // Arrange
    const sut = exceedsMaxIndexBytes(256 * 1024 * 1024 + 1);

    // Assert
    expect(sut).toBe(true);
  });
});

describe('exceedsMaxSymbolicDepth boundary triple (default cap = 5)', () => {
  it('Given depth 4 (just-under), When invoked, Then returns false', () => {
    // Arrange
    const sut = exceedsMaxSymbolicDepth(4);

    // Assert
    expect(sut).toBe(false);
  });
  it('Given depth 5 (at cap), When invoked, Then returns false', () => {
    // Arrange
    const sut = exceedsMaxSymbolicDepth(5);

    // Assert
    expect(sut).toBe(false);
  });
  it('Given depth 6 (just-over), When invoked, Then returns true', () => {
    // Arrange
    const sut = exceedsMaxSymbolicDepth(6);

    // Assert
    expect(sut).toBe(true);
  });
  it('Given depth 6 with custom cap 10, When invoked, Then returns false (cap override works)', () => {
    // Arrange
    const sut = exceedsMaxSymbolicDepth(6, 10);

    // Assert
    expect(sut).toBe(false);
  });
});

describe('exceedsMaxPeelDepth boundary triple (default cap = 5)', () => {
  it('Given depth 4, When invoked, Then returns false', () => {
    // Arrange
    const sut = exceedsMaxPeelDepth(4);

    // Assert
    expect(sut).toBe(false);
  });
  it('Given depth 5, When invoked, Then returns false', () => {
    // Arrange
    const sut = exceedsMaxPeelDepth(5);

    // Assert
    expect(sut).toBe(false);
  });
  it('Given depth 6, When invoked, Then returns true', () => {
    // Arrange
    const sut = exceedsMaxPeelDepth(6);

    // Assert
    expect(sut).toBe(true);
  });
});

describe('isContainedRefSegment', () => {
  it('Given "refs/heads/main", When invoked, Then returns true (baseline accept)', () => {
    // Arrange
    const sut = isContainedRefSegment('refs/heads/main');

    // Assert
    expect(sut).toBe(true);
  });
  it('Given "HEAD", When invoked, Then returns true', () => {
    // Arrange
    const sut = isContainedRefSegment('HEAD');

    // Assert
    expect(sut).toBe(true);
  });
  it('Given a name starting with /, When invoked, Then returns false (absolute)', () => {
    // Arrange
    const sut = isContainedRefSegment('/etc/passwd');

    // Assert
    expect(sut).toBe(false);
  });
  it('Given a name containing backslash, When invoked, Then returns false (Windows drive)', () => {
    // Arrange
    const sut = isContainedRefSegment('refs\\heads\\main');

    // Assert
    expect(sut).toBe(false);
  });
  it('Given a name containing colon, When invoked, Then returns false (UNC/drive)', () => {
    // Arrange
    const sut = isContainedRefSegment('C:/foo');

    // Assert
    expect(sut).toBe(false);
  });
  it('Given a name containing .., When invoked, Then returns false (traversal)', () => {
    // Arrange
    const sut = isContainedRefSegment('refs/../escape');

    // Assert
    expect(sut).toBe(false);
  });
});

describe('isHead', () => {
  it('Given "HEAD", When invoked, Then returns true', () => {
    // Arrange
    const sut = isHead('HEAD');

    // Assert
    expect(sut).toBe(true);
  });
  it('Given "refs/heads/main", When invoked, Then returns false', () => {
    // Arrange
    const sut = isHead('refs/heads/main');

    // Assert
    expect(sut).toBe(false);
  });
  it('Given "head" (lowercase), When invoked, Then returns false (case-sensitive)', () => {
    // Arrange
    const sut = isHead('head');

    // Assert
    expect(sut).toBe(false);
  });
});

describe('isGitlink', () => {
  it('Given "160000", When invoked, Then returns true', () => {
    // Arrange
    const sut = isGitlink('160000');

    // Assert
    expect(sut).toBe(true);
  });
  it('Given "100644" (blob), When invoked, Then returns false', () => {
    // Arrange
    const sut = isGitlink('100644');

    // Assert
    expect(sut).toBe(false);
  });
  it('Given "040000" (tree), When invoked, Then returns false', () => {
    // Arrange
    const sut = isGitlink('040000');

    // Assert
    expect(sut).toBe(false);
  });
});

describe('exceedsMaxTreeDepth boundary triple', () => {
  it('Given depth 4 with cap 5, When invoked, Then returns false', () => {
    // Arrange
    const sut = exceedsMaxTreeDepth(4, 5);

    // Assert
    expect(sut).toBe(false);
  });
  it('Given depth 5 with cap 5, When invoked, Then returns false (at)', () => {
    // Arrange
    const sut = exceedsMaxTreeDepth(5, 5);

    // Assert
    expect(sut).toBe(false);
  });
  it('Given depth 6 with cap 5, When invoked, Then returns true', () => {
    // Arrange
    const sut = exceedsMaxTreeDepth(6, 5);

    // Assert
    expect(sut).toBe(true);
  });
});

describe('exceedsMaxTreeEntries boundary triple', () => {
  it('Given count 2 with cap 3, When invoked, Then returns false', () => {
    // Arrange
    const sut = exceedsMaxTreeEntries(2, 3);

    // Assert
    expect(sut).toBe(false);
  });
  it('Given count 3 with cap 3, When invoked, Then returns false (at)', () => {
    // Arrange
    const sut = exceedsMaxTreeEntries(3, 3);

    // Assert
    expect(sut).toBe(false);
  });
  it('Given count 4 with cap 3, When invoked, Then returns true', () => {
    // Arrange
    const sut = exceedsMaxTreeEntries(4, 3);

    // Assert
    expect(sut).toBe(true);
  });
});

describe('looksLikeObjectId', () => {
  it('Given a 40-char hex string, When invoked, Then returns true (SHA1)', () => {
    // Arrange
    const sut = looksLikeObjectId('0123456789abcdef0123456789abcdef01234567');

    // Assert
    expect(sut).toBe(true);
  });
  it('Given a 64-char hex string, When invoked, Then returns true (SHA256)', () => {
    // Arrange
    const sut = looksLikeObjectId('a'.repeat(64));

    // Assert
    expect(sut).toBe(true);
  });
  it('Given a 39-char hex string, When invoked, Then returns false (too short)', () => {
    // Arrange
    const sut = looksLikeObjectId('0'.repeat(39));

    // Assert
    expect(sut).toBe(false);
  });
  it('Given a 41-char hex string, When invoked, Then returns false (not SHA1 or SHA256)', () => {
    // Arrange
    const sut = looksLikeObjectId('0'.repeat(41));

    // Assert
    expect(sut).toBe(false);
  });
  it('Given 40 chars with uppercase, When invoked, Then returns false (only lowercase accepted)', () => {
    // Arrange
    const sut = looksLikeObjectId('A'.repeat(40));

    // Assert
    expect(sut).toBe(false);
  });
  it('Given a ref-like string, When invoked, Then returns false', () => {
    // Arrange
    const sut = looksLikeObjectId('refs/heads/main');

    // Assert
    expect(sut).toBe(false);
  });
  it('Given an empty string, When invoked, Then returns false', () => {
    // Arrange
    const sut = looksLikeObjectId('');

    // Assert
    expect(sut).toBe(false);
  });
});

describe('hasDeclaredId', () => {
  it('Given an empty string, When invoked, Then returns false', () => {
    // Arrange
    const sut = hasDeclaredId('');

    // Assert
    expect(sut).toBe(false);
  });
  it('Given a hex id, When invoked, Then returns true', () => {
    // Arrange
    const sut = hasDeclaredId('0'.repeat(40));

    // Assert
    expect(sut).toBe(true);
  });
});

describe('isInvalidExtraHeaderKey', () => {
  it('Given a clean key like "mergetag", When invoked, Then returns false', () => {
    // Arrange
    const sut = isInvalidExtraHeaderKey('mergetag');

    // Assert
    expect(sut).toBe(false);
  });
  it('Given an empty key, When invoked, Then returns true', () => {
    // Arrange
    const sut = isInvalidExtraHeaderKey('');

    // Assert
    expect(sut).toBe(true);
  });
  it('Given a key with NUL, When invoked, Then returns true', () => {
    // Arrange
    const sut = isInvalidExtraHeaderKey('a\0b');

    // Assert
    expect(sut).toBe(true);
  });
  it('Given a key with CR, When invoked, Then returns true', () => {
    // Arrange
    const sut = isInvalidExtraHeaderKey('a\rb');

    // Assert
    expect(sut).toBe(true);
  });
  it('Given a key with LF, When invoked, Then returns true', () => {
    // Arrange
    const sut = isInvalidExtraHeaderKey('a\nb');

    // Assert
    expect(sut).toBe(true);
  });
  it('Given a key with a space, When invoked, Then returns true (space is the key/value separator)', () => {
    // Arrange
    const sut = isInvalidExtraHeaderKey('two words');

    // Assert
    expect(sut).toBe(true);
  });
  it('Given a key with a tab, When invoked, Then returns true', () => {
    // Arrange
    const sut = isInvalidExtraHeaderKey('a\tb');

    // Assert
    expect(sut).toBe(true);
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
    const sut = hasHeaderInjectionChars('a\0b');

    // Assert
    expect(sut).toBe(true);
  });

  it('Given a value containing CR, When hasHeaderInjectionChars, Then returns true', () => {
    // Arrange
    const sut = hasHeaderInjectionChars('a\rb');

    // Assert
    expect(sut).toBe(true);
  });

  it('Given a value containing a double LF, When hasHeaderInjectionChars, Then returns true', () => {
    // Arrange
    const sut = hasHeaderInjectionChars('a\n\nb');

    // Assert
    expect(sut).toBe(true);
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
  it('Given size MAX_PACK_IDX_BYTES − 1 (just-under), When invoked, Then returns false', () => {
    // Arrange
    const sut = exceedsMaxPackIdxBytes(MAX_PACK_IDX_BYTES - 1);

    // Assert
    expect(sut).toBe(false);
  });
  it('Given size MAX_PACK_IDX_BYTES (at cap), When invoked, Then returns false', () => {
    // Arrange
    const sut = exceedsMaxPackIdxBytes(MAX_PACK_IDX_BYTES);

    // Assert
    expect(sut).toBe(false);
  });
  it('Given size MAX_PACK_IDX_BYTES + 1 (just-over), When invoked, Then returns true', () => {
    // Arrange
    const sut = exceedsMaxPackIdxBytes(MAX_PACK_IDX_BYTES + 1);

    // Assert
    expect(sut).toBe(true);
  });
});

describe('error-reason constants are stable identifiers', () => {
  it('Given the REASON_WALK_EMPTY_FROM constant, When read, Then matches expected string', () => {
    // Arrange + Assert
    expect(REASON_WALK_EMPTY_FROM).toBe('empty from');
  });
  it('Given the REASON_WALK_TOO_MANY_SEEDS constant, When read, Then matches expected string', () => {
    // Arrange + Assert
    expect(REASON_WALK_TOO_MANY_SEEDS).toBe('too many seeds');
  });
  it('Given the REASON_MESSAGE_CONTAINS_NUL constant, When read, Then matches expected string', () => {
    // Arrange + Assert
    expect(REASON_MESSAGE_CONTAINS_NUL).toBe('message contains NUL');
  });
  it('Given the REASON_MESSAGE_EXCEEDS_MAX constant, When read, Then matches expected string', () => {
    // Arrange + Assert
    expect(REASON_MESSAGE_EXCEEDS_MAX).toBe('message exceeds 16 MiB');
  });
  it('Given the REASON_INDEX_EXCEEDS_MAX constant, When read, Then matches expected string', () => {
    // Arrange + Assert
    expect(REASON_INDEX_EXCEEDS_MAX).toBe('index file exceeds 256 MiB');
  });
  it('Given the REASON_TARGET_ESCAPES_GIT_DIR constant, When read, Then matches expected string', () => {
    // Arrange + Assert
    expect(REASON_TARGET_ESCAPES_GIT_DIR).toBe('target escapes gitDir');
  });
  it('Given the REASON_INDEX_CHECKSUM_MISMATCH constant, When read, Then matches expected string', () => {
    // Arrange + Assert
    expect(REASON_INDEX_CHECKSUM_MISMATCH).toBe('index trailer checksum mismatch');
  });
  it('Given the REASON_PACK_IDX_EXCEEDS_MAX constant, When read, Then matches expected string', () => {
    // Arrange + Assert
    expect(REASON_PACK_IDX_EXCEEDS_MAX).toBe('pack .idx file exceeds 64 MiB');
  });
  it('Given the REASON_EXTRA_HEADER_KEY_INVALID constant, When read, Then matches expected string', () => {
    // Arrange + Assert
    expect(REASON_EXTRA_HEADER_KEY_INVALID).toBe('extraHeader key contains forbidden characters');
  });
});
