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
  describe('Given empty array', () => {
    describe('When invoked', () => {
      it('Then returns true', () => {
        // Arrange
        const sut = isEmptyFrom([]);

        // Assert
        expect(sut).toBe(true);
      });
    });
  });
  describe('Given one-element array', () => {
    describe('When invoked', () => {
      it('Then returns false', () => {
        // Arrange
        const sut = isEmptyFrom(['a']);

        // Assert
        expect(sut).toBe(false);
      });
    });
  });
});

describe('exceedsMaxWalkSeeds boundary triple', () => {
  describe('Given 1023 elements (just-under MAX_WALK_SEEDS)', () => {
    describe('When invoked', () => {
      it('Then returns false', () => {
        // Arrange
        const sut = exceedsMaxWalkSeeds(new Array(1023).fill(0));

        // Assert
        expect(sut).toBe(false);
      });
    });
  });
  describe('Given 1024 elements (at cap)', () => {
    describe('When invoked', () => {
      it('Then returns false', () => {
        // Arrange
        const sut = exceedsMaxWalkSeeds(new Array(1024).fill(0));

        // Assert
        expect(sut).toBe(false);
      });
    });
  });
  describe('Given 1025 elements (just-over cap)', () => {
    describe('When invoked', () => {
      it('Then returns true', () => {
        // Arrange
        const sut = exceedsMaxWalkSeeds(new Array(1025).fill(0));

        // Assert
        expect(sut).toBe(true);
      });
    });
  });
});

describe('messageContainsNul', () => {
  describe('Given a NUL byte anywhere in the string', () => {
    describe('When invoked', () => {
      it('Then returns true', () => {
        // Arrange
        const sut = messageContainsNul('a\0b');

        // Assert
        expect(sut).toBe(true);
      });
    });
  });
  describe('Given a clean message', () => {
    describe('When invoked', () => {
      it('Then returns false', () => {
        // Arrange
        const sut = messageContainsNul('hello world');

        // Assert
        expect(sut).toBe(false);
      });
    });
  });
  describe('Given an empty string', () => {
    describe('When invoked', () => {
      it('Then returns false', () => {
        // Arrange
        const sut = messageContainsNul('');

        // Assert
        expect(sut).toBe(false);
      });
    });
  });
});

describe('exceedsMaxCommitMessageBytes boundary triple', () => {
  describe('Given message of 16 MiB − 1 bytes (just-under)', () => {
    describe('When invoked', () => {
      it('Then returns false', () => {
        // Arrange
        const sut = exceedsMaxCommitMessageBytes('x'.repeat(16 * 1024 * 1024 - 1));

        // Assert
        expect(sut).toBe(false);
      });
    });
  });
  describe('Given message of exactly 16 MiB (at cap)', () => {
    describe('When invoked', () => {
      it('Then returns false', () => {
        // Arrange
        const sut = exceedsMaxCommitMessageBytes('x'.repeat(16 * 1024 * 1024));

        // Assert
        expect(sut).toBe(false);
      });
    });
  });
  describe('Given message of 16 MiB + 1 bytes (just-over)', () => {
    describe('When invoked', () => {
      it('Then returns true', () => {
        // Arrange
        const sut = exceedsMaxCommitMessageBytes('x'.repeat(16 * 1024 * 1024 + 1));

        // Assert
        expect(sut).toBe(true);
      });
    });
  });
});

describe('exceedsMaxIndexBytes boundary triple', () => {
  describe('Given size 256 MiB − 1 (just-under)', () => {
    describe('When invoked', () => {
      it('Then returns false', () => {
        // Arrange
        const sut = exceedsMaxIndexBytes(256 * 1024 * 1024 - 1);

        // Assert
        expect(sut).toBe(false);
      });
    });
  });
  describe('Given size 256 MiB (at cap)', () => {
    describe('When invoked', () => {
      it('Then returns false', () => {
        // Arrange
        const sut = exceedsMaxIndexBytes(256 * 1024 * 1024);

        // Assert
        expect(sut).toBe(false);
      });
    });
  });
  describe('Given size 256 MiB + 1 (just-over)', () => {
    describe('When invoked', () => {
      it('Then returns true', () => {
        // Arrange
        const sut = exceedsMaxIndexBytes(256 * 1024 * 1024 + 1);

        // Assert
        expect(sut).toBe(true);
      });
    });
  });
});

describe('exceedsMaxSymbolicDepth boundary triple (default cap = 5)', () => {
  describe('Given depth 4 (just-under)', () => {
    describe('When invoked', () => {
      it('Then returns false', () => {
        // Arrange
        const sut = exceedsMaxSymbolicDepth(4);

        // Assert
        expect(sut).toBe(false);
      });
    });
  });
  describe('Given depth 5 (at cap)', () => {
    describe('When invoked', () => {
      it('Then returns false', () => {
        // Arrange
        const sut = exceedsMaxSymbolicDepth(5);

        // Assert
        expect(sut).toBe(false);
      });
    });
  });
  describe('Given depth 6 (just-over)', () => {
    describe('When invoked', () => {
      it('Then returns true', () => {
        // Arrange
        const sut = exceedsMaxSymbolicDepth(6);

        // Assert
        expect(sut).toBe(true);
      });
    });
  });
  describe('Given depth 6 with custom cap 10', () => {
    describe('When invoked', () => {
      it('Then returns false (cap override works)', () => {
        // Arrange
        const sut = exceedsMaxSymbolicDepth(6, 10);

        // Assert
        expect(sut).toBe(false);
      });
    });
  });
});

describe('exceedsMaxPeelDepth boundary triple (default cap = 5)', () => {
  describe('Given depth 4', () => {
    describe('When invoked', () => {
      it('Then returns false', () => {
        // Arrange
        const sut = exceedsMaxPeelDepth(4);

        // Assert
        expect(sut).toBe(false);
      });
    });
  });
  describe('Given depth 5', () => {
    describe('When invoked', () => {
      it('Then returns false', () => {
        // Arrange
        const sut = exceedsMaxPeelDepth(5);

        // Assert
        expect(sut).toBe(false);
      });
    });
  });
  describe('Given depth 6', () => {
    describe('When invoked', () => {
      it('Then returns true', () => {
        // Arrange
        const sut = exceedsMaxPeelDepth(6);

        // Assert
        expect(sut).toBe(true);
      });
    });
  });
});

describe('isContainedRefSegment', () => {
  describe('Given "refs/heads/main"', () => {
    describe('When invoked', () => {
      it('Then returns true (baseline accept)', () => {
        // Arrange
        const sut = isContainedRefSegment('refs/heads/main');

        // Assert
        expect(sut).toBe(true);
      });
    });
  });
  describe('Given "HEAD"', () => {
    describe('When invoked', () => {
      it('Then returns true', () => {
        // Arrange
        const sut = isContainedRefSegment('HEAD');

        // Assert
        expect(sut).toBe(true);
      });
    });
  });
  describe('Given a name starting with /', () => {
    describe('When invoked', () => {
      it('Then returns false (absolute)', () => {
        // Arrange
        const sut = isContainedRefSegment('/etc/passwd');

        // Assert
        expect(sut).toBe(false);
      });
    });
  });
  describe('Given a name containing backslash', () => {
    describe('When invoked', () => {
      it('Then returns false (Windows drive)', () => {
        // Arrange
        const sut = isContainedRefSegment('refs\\heads\\main');

        // Assert
        expect(sut).toBe(false);
      });
    });
  });
  describe('Given a name containing colon', () => {
    describe('When invoked', () => {
      it('Then returns false (UNC/drive)', () => {
        // Arrange
        const sut = isContainedRefSegment('C:/foo');

        // Assert
        expect(sut).toBe(false);
      });
    });
  });
  describe('Given a name containing ..', () => {
    describe('When invoked', () => {
      it('Then returns false (traversal)', () => {
        // Arrange
        const sut = isContainedRefSegment('refs/../escape');

        // Assert
        expect(sut).toBe(false);
      });
    });
  });
});

describe('isHead', () => {
  describe('Given "HEAD"', () => {
    describe('When invoked', () => {
      it('Then returns true', () => {
        // Arrange
        const sut = isHead('HEAD');

        // Assert
        expect(sut).toBe(true);
      });
    });
  });
  describe('Given "refs/heads/main"', () => {
    describe('When invoked', () => {
      it('Then returns false', () => {
        // Arrange
        const sut = isHead('refs/heads/main');

        // Assert
        expect(sut).toBe(false);
      });
    });
  });
  describe('Given "head" (lowercase)', () => {
    describe('When invoked', () => {
      it('Then returns false (case-sensitive)', () => {
        // Arrange
        const sut = isHead('head');

        // Assert
        expect(sut).toBe(false);
      });
    });
  });
});

describe('isGitlink', () => {
  describe('Given "160000"', () => {
    describe('When invoked', () => {
      it('Then returns true', () => {
        // Arrange
        const sut = isGitlink('160000');

        // Assert
        expect(sut).toBe(true);
      });
    });
  });
  describe('Given "100644" (blob)', () => {
    describe('When invoked', () => {
      it('Then returns false', () => {
        // Arrange
        const sut = isGitlink('100644');

        // Assert
        expect(sut).toBe(false);
      });
    });
  });
  describe('Given "040000" (tree)', () => {
    describe('When invoked', () => {
      it('Then returns false', () => {
        // Arrange
        const sut = isGitlink('040000');

        // Assert
        expect(sut).toBe(false);
      });
    });
  });
});

describe('exceedsMaxTreeDepth boundary triple', () => {
  describe('Given depth 4 with cap 5', () => {
    describe('When invoked', () => {
      it('Then returns false', () => {
        // Arrange
        const sut = exceedsMaxTreeDepth(4, 5);

        // Assert
        expect(sut).toBe(false);
      });
    });
  });
  describe('Given depth 5 with cap 5', () => {
    describe('When invoked', () => {
      it('Then returns false (at)', () => {
        // Arrange
        const sut = exceedsMaxTreeDepth(5, 5);

        // Assert
        expect(sut).toBe(false);
      });
    });
  });
  describe('Given depth 6 with cap 5', () => {
    describe('When invoked', () => {
      it('Then returns true', () => {
        // Arrange
        const sut = exceedsMaxTreeDepth(6, 5);

        // Assert
        expect(sut).toBe(true);
      });
    });
  });
});

describe('exceedsMaxTreeEntries boundary triple', () => {
  describe('Given count 2 with cap 3', () => {
    describe('When invoked', () => {
      it('Then returns false', () => {
        // Arrange
        const sut = exceedsMaxTreeEntries(2, 3);

        // Assert
        expect(sut).toBe(false);
      });
    });
  });
  describe('Given count 3 with cap 3', () => {
    describe('When invoked', () => {
      it('Then returns false (at)', () => {
        // Arrange
        const sut = exceedsMaxTreeEntries(3, 3);

        // Assert
        expect(sut).toBe(false);
      });
    });
  });
  describe('Given count 4 with cap 3', () => {
    describe('When invoked', () => {
      it('Then returns true', () => {
        // Arrange
        const sut = exceedsMaxTreeEntries(4, 3);

        // Assert
        expect(sut).toBe(true);
      });
    });
  });
});

describe('looksLikeObjectId', () => {
  describe('Given a 40-char hex string', () => {
    describe('When invoked', () => {
      it('Then returns true (SHA1)', () => {
        // Arrange
        const sut = looksLikeObjectId('0123456789abcdef0123456789abcdef01234567');

        // Assert
        expect(sut).toBe(true);
      });
    });
  });
  describe('Given a 64-char hex string', () => {
    describe('When invoked', () => {
      it('Then returns true (SHA256)', () => {
        // Arrange
        const sut = looksLikeObjectId('a'.repeat(64));

        // Assert
        expect(sut).toBe(true);
      });
    });
  });
  describe('Given a 39-char hex string', () => {
    describe('When invoked', () => {
      it('Then returns false (too short)', () => {
        // Arrange
        const sut = looksLikeObjectId('0'.repeat(39));

        // Assert
        expect(sut).toBe(false);
      });
    });
  });
  describe('Given a 41-char hex string', () => {
    describe('When invoked', () => {
      it('Then returns false (not SHA1 or SHA256)', () => {
        // Arrange
        const sut = looksLikeObjectId('0'.repeat(41));

        // Assert
        expect(sut).toBe(false);
      });
    });
  });
  describe('Given 40 chars with uppercase', () => {
    describe('When invoked', () => {
      it('Then returns false (only lowercase accepted)', () => {
        // Arrange
        const sut = looksLikeObjectId('A'.repeat(40));

        // Assert
        expect(sut).toBe(false);
      });
    });
  });
  describe('Given a ref-like string', () => {
    describe('When invoked', () => {
      it('Then returns false', () => {
        // Arrange
        const sut = looksLikeObjectId('refs/heads/main');

        // Assert
        expect(sut).toBe(false);
      });
    });
  });
  describe('Given an empty string', () => {
    describe('When invoked', () => {
      it('Then returns false', () => {
        // Arrange
        const sut = looksLikeObjectId('');

        // Assert
        expect(sut).toBe(false);
      });
    });
  });
});

describe('hasDeclaredId', () => {
  describe('Given an empty string', () => {
    describe('When invoked', () => {
      it('Then returns false', () => {
        // Arrange
        const sut = hasDeclaredId('');

        // Assert
        expect(sut).toBe(false);
      });
    });
  });
  describe('Given a hex id', () => {
    describe('When invoked', () => {
      it('Then returns true', () => {
        // Arrange
        const sut = hasDeclaredId('0'.repeat(40));

        // Assert
        expect(sut).toBe(true);
      });
    });
  });
});

describe('isInvalidExtraHeaderKey', () => {
  describe('Given a clean key like "mergetag"', () => {
    describe('When invoked', () => {
      it('Then returns false', () => {
        // Arrange
        const sut = isInvalidExtraHeaderKey('mergetag');

        // Assert
        expect(sut).toBe(false);
      });
    });
  });
  describe('Given an empty key', () => {
    describe('When invoked', () => {
      it('Then returns true', () => {
        // Arrange
        const sut = isInvalidExtraHeaderKey('');

        // Assert
        expect(sut).toBe(true);
      });
    });
  });
  describe('Given a key with NUL', () => {
    describe('When invoked', () => {
      it('Then returns true', () => {
        // Arrange
        const sut = isInvalidExtraHeaderKey('a\0b');

        // Assert
        expect(sut).toBe(true);
      });
    });
  });
  describe('Given a key with CR', () => {
    describe('When invoked', () => {
      it('Then returns true', () => {
        // Arrange
        const sut = isInvalidExtraHeaderKey('a\rb');

        // Assert
        expect(sut).toBe(true);
      });
    });
  });
  describe('Given a key with LF', () => {
    describe('When invoked', () => {
      it('Then returns true', () => {
        // Arrange
        const sut = isInvalidExtraHeaderKey('a\nb');

        // Assert
        expect(sut).toBe(true);
      });
    });
  });
  describe('Given a key with a space', () => {
    describe('When invoked', () => {
      it('Then returns true (space is the key/value separator)', () => {
        // Arrange
        const sut = isInvalidExtraHeaderKey('two words');

        // Assert
        expect(sut).toBe(true);
      });
    });
  });
  describe('Given a key with a tab', () => {
    describe('When invoked', () => {
      it('Then returns true', () => {
        // Arrange
        const sut = isInvalidExtraHeaderKey('a\tb');

        // Assert
        expect(sut).toBe(true);
      });
    });
  });
});

describe('hasHeaderInjectionChars', () => {
  describe('Given a clean value', () => {
    describe('When hasHeaderInjectionChars', () => {
      it('Then returns false', () => {
        // Arrange & Act
        const sut = hasHeaderInjectionChars('a clean header value');

        // Assert
        expect(sut).toBe(false);
      });
    });
  });

  describe('Given a value containing NUL', () => {
    describe('When hasHeaderInjectionChars', () => {
      it('Then returns true', () => {
        // Arrange
        const sut = hasHeaderInjectionChars('a\0b');

        // Assert
        expect(sut).toBe(true);
      });
    });
  });

  describe('Given a value containing CR', () => {
    describe('When hasHeaderInjectionChars', () => {
      it('Then returns true', () => {
        // Arrange
        const sut = hasHeaderInjectionChars('a\rb');

        // Assert
        expect(sut).toBe(true);
      });
    });
  });

  describe('Given a value containing a double LF', () => {
    describe('When hasHeaderInjectionChars', () => {
      it('Then returns true', () => {
        // Arrange
        const sut = hasHeaderInjectionChars('a\n\nb');

        // Assert
        expect(sut).toBe(true);
      });
    });
  });

  describe('Given a value with a LEADING LF only (no trailing LF)', () => {
    describe('When hasHeaderInjectionChars', () => {
      it('Then returns true', () => {
        // Arrange
        // Isolates the `value.startsWith(\'\\n\')` operand: trailing is false here,
        // so an `&&` mutant or a dropped startsWith operand would return false.
        const sut = hasHeaderInjectionChars('\nabc');

        // Assert
        expect(sut).toBe(true);
      });
    });
  });

  describe('Given a value with a TRAILING LF only (no leading LF)', () => {
    describe('When hasHeaderInjectionChars', () => {
      it('Then returns true', () => {
        // Arrange
        // Isolates the `value.endsWith(\'\\n\')` operand: leading is false here,
        // so an `&&` mutant or a dropped endsWith operand would return false.
        const sut = hasHeaderInjectionChars('abc\n');

        // Assert
        expect(sut).toBe(true);
      });
    });
  });

  describe('Given a value with an INTERIOR single LF only', () => {
    describe('When hasHeaderInjectionChars', () => {
      it('Then returns false', () => {
        // Arrange
        // No NUL/CR, no `\n\n`, not leading/trailing — every guard must be false.
        const sut = hasHeaderInjectionChars('a\nb');

        // Assert
        expect(sut).toBe(false);
      });
    });
  });
});

describe('exceedsMaxPackIdxBytes boundary triple', () => {
  describe('Given size MAX_PACK_IDX_BYTES − 1 (just-under)', () => {
    describe('When invoked', () => {
      it('Then returns false', () => {
        // Arrange
        const sut = exceedsMaxPackIdxBytes(MAX_PACK_IDX_BYTES - 1);

        // Assert
        expect(sut).toBe(false);
      });
    });
  });
  describe('Given size MAX_PACK_IDX_BYTES (at cap)', () => {
    describe('When invoked', () => {
      it('Then returns false', () => {
        // Arrange
        const sut = exceedsMaxPackIdxBytes(MAX_PACK_IDX_BYTES);

        // Assert
        expect(sut).toBe(false);
      });
    });
  });
  describe('Given size MAX_PACK_IDX_BYTES + 1 (just-over)', () => {
    describe('When invoked', () => {
      it('Then returns true', () => {
        // Arrange
        const sut = exceedsMaxPackIdxBytes(MAX_PACK_IDX_BYTES + 1);

        // Assert
        expect(sut).toBe(true);
      });
    });
  });
});

describe('error-reason constants are stable identifiers', () => {
  describe('Given the REASON_WALK_EMPTY_FROM constant', () => {
    describe('When read', () => {
      it('Then matches expected string', () => {
        // Arrange + Assert
        expect(REASON_WALK_EMPTY_FROM).toBe('empty from');
      });
    });
  });
  describe('Given the REASON_WALK_TOO_MANY_SEEDS constant', () => {
    describe('When read', () => {
      it('Then matches expected string', () => {
        // Arrange + Assert
        expect(REASON_WALK_TOO_MANY_SEEDS).toBe('too many seeds');
      });
    });
  });
  describe('Given the REASON_MESSAGE_CONTAINS_NUL constant', () => {
    describe('When read', () => {
      it('Then matches expected string', () => {
        // Arrange + Assert
        expect(REASON_MESSAGE_CONTAINS_NUL).toBe('message contains NUL');
      });
    });
  });
  describe('Given the REASON_MESSAGE_EXCEEDS_MAX constant', () => {
    describe('When read', () => {
      it('Then matches expected string', () => {
        // Arrange + Assert
        expect(REASON_MESSAGE_EXCEEDS_MAX).toBe('message exceeds 16 MiB');
      });
    });
  });
  describe('Given the REASON_INDEX_EXCEEDS_MAX constant', () => {
    describe('When read', () => {
      it('Then matches expected string', () => {
        // Arrange + Assert
        expect(REASON_INDEX_EXCEEDS_MAX).toBe('index file exceeds 256 MiB');
      });
    });
  });
  describe('Given the REASON_TARGET_ESCAPES_GIT_DIR constant', () => {
    describe('When read', () => {
      it('Then matches expected string', () => {
        // Arrange + Assert
        expect(REASON_TARGET_ESCAPES_GIT_DIR).toBe('target escapes gitDir');
      });
    });
  });
  describe('Given the REASON_INDEX_CHECKSUM_MISMATCH constant', () => {
    describe('When read', () => {
      it('Then matches expected string', () => {
        // Arrange + Assert
        expect(REASON_INDEX_CHECKSUM_MISMATCH).toBe('index trailer checksum mismatch');
      });
    });
  });
  describe('Given the REASON_PACK_IDX_EXCEEDS_MAX constant', () => {
    describe('When read', () => {
      it('Then matches expected string', () => {
        // Arrange + Assert
        expect(REASON_PACK_IDX_EXCEEDS_MAX).toBe('pack .idx file exceeds 64 MiB');
      });
    });
  });
  describe('Given the REASON_EXTRA_HEADER_KEY_INVALID constant', () => {
    describe('When read', () => {
      it('Then matches expected string', () => {
        // Arrange + Assert
        expect(REASON_EXTRA_HEADER_KEY_INVALID).toBe(
          'extraHeader key contains forbidden characters',
        );
      });
    });
  });
});
