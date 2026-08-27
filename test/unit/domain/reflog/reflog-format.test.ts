import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { TsgitError } from '../../../../src/domain/error.js';
import type { AuthorIdentity } from '../../../../src/domain/objects/index.js';
import { ObjectId, ZERO_OID } from '../../../../src/domain/objects/index.js';
import type { ReflogEntry } from '../../../../src/domain/reflog/reflog-entry.js';
import {
  parseReflog,
  parseReflogLine,
  sanitizeReflogMessage,
  serializeReflogLine,
} from '../../../../src/domain/reflog/reflog-format.js';

const OID_A = ObjectId.from('a'.repeat(40));
const OID_B = ObjectId.from('b'.repeat(40));

const IDENTITY: AuthorIdentity = {
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  timestamp: 1716240000,
  timezoneOffset: '+0000',
};

const ENTRY: ReflogEntry = {
  oldId: OID_A,
  newId: OID_B,
  identity: IDENTITY,
  message: 'commit: second',
};

function expectInvalidReflogEntry(act: () => unknown, expectedReason: string): void {
  try {
    act();
    expect.fail('expected INVALID_REFLOG_ENTRY');
  } catch (err) {
    expect(err).toBeInstanceOf(TsgitError);
    expect((err as TsgitError).data).toEqual({
      code: 'INVALID_REFLOG_ENTRY',
      reason: expectedReason,
    });
  }
}

describe('serializeReflogLine', () => {
  describe('Given an entry', () => {
    describe('When serializing', () => {
      it('Then produces an LF-terminated old/new/identity TAB message line', () => {
        // Arrange
        const entry = ENTRY;

        // Act
        const line = serializeReflogLine(entry, 40);

        // Assert
        expect(line).toBe(
          `${OID_A} ${OID_B} Ada Lovelace <ada@example.com> 1716240000 +0000\tcommit: second\n`,
        );
      });
    });
  });

  describe('Given a first entry with ZERO_OID old id', () => {
    describe('When serializing', () => {
      it('Then the old field is 40 zeros', () => {
        // Arrange
        const entry: ReflogEntry = {
          ...ENTRY,
          oldId: ZERO_OID,
          message: 'commit (initial): add readme',
        };

        // Act
        const line = serializeReflogLine(entry, 40);

        // Assert
        expect(line.startsWith(`${ZERO_OID} ${OID_B} `)).toBe(true);
      });
    });
  });

  describe('Given an empty message', () => {
    describe('When serializing', () => {
      it('Then no TAB is written before the line feed', () => {
        // Arrange — git appends the TAB + message only when the message is
        // non-empty (`if (msg && *msg)`); an empty message ends at the timezone.
        const entry: ReflogEntry = { ...ENTRY, message: '' };

        // Act
        const line = serializeReflogLine(entry, 40);

        // Assert
        expect(line.endsWith('+0000\n')).toBe(true);
        expect(line.includes('\t')).toBe(false);
      });
    });
  });

  describe('Given a message containing a line break', () => {
    describe('When serializing', () => {
      it.each([
        { message: 'first\nsecond', label: 'an LF' },
        { message: 'first\rsecond', label: 'a CR' },
      ])('Then throws INVALID_REFLOG_ENTRY for $label', ({ message }) => {
        // Arrange
        const entry: ReflogEntry = { ...ENTRY, message };

        // Act & Assert
        expectInvalidReflogEntry(
          () => serializeReflogLine(entry, 40),
          'message contains a line break',
        );
      });
    });
  });

  describe('Given an old id shorter than the repository hex width', () => {
    describe('When serializing at hexLength 64', () => {
      it('Then throws INVALID_REFLOG_ENTRY', () => {
        // Arrange — OID_A/OID_B are 40-hex (SHA-1 width); the repo is SHA-256.
        const entry: ReflogEntry = { ...ENTRY, oldId: OID_A };

        // Act & Assert
        expectInvalidReflogEntry(
          () => serializeReflogLine(entry, 64),
          'object id does not match the repository oid width',
        );
      });
    });
  });

  describe('Given a new id shorter than the repository hex width', () => {
    describe('When serializing at hexLength 64', () => {
      it('Then throws INVALID_REFLOG_ENTRY', () => {
        // Arrange — the old id alone is 64-hex; the new id is still 40-hex,
        // proving the `||` guard's second arm fires independently of the first.
        const entry: ReflogEntry = {
          ...ENTRY,
          oldId: ObjectId.from('a'.repeat(64)),
          newId: OID_B,
        };

        // Act & Assert
        expectInvalidReflogEntry(
          () => serializeReflogLine(entry, 64),
          'object id does not match the repository oid width',
        );
      });
    });
  });
});

describe('parseReflogLine', () => {
  describe('Given a well-formed line', () => {
    describe('When parsing', () => {
      it('Then returns the entry with all fields', () => {
        // Arrange
        const line = `${OID_A} ${OID_B} Ada Lovelace <ada@example.com> 1716240000 +0000\tcommit: second`;

        // Act
        const entry = parseReflogLine(line, 40);

        // Assert
        expect(entry).toEqual(ENTRY);
      });
    });
  });

  describe('Given a line with an empty message', () => {
    describe('When parsing', () => {
      it('Then message is the empty string', () => {
        // Arrange
        const line = `${OID_A} ${OID_B} Ada Lovelace <ada@example.com> 1716240000 +0000\t`;

        // Act
        const entry = parseReflogLine(line, 40);

        // Assert
        expect(entry.message).toBe('');
      });
    });
  });

  describe('Given a message containing spaces', () => {
    describe('When parsing', () => {
      it('Then the whole message after TAB is kept', () => {
        // Arrange
        const line = `${OID_A} ${OID_B} Ada Lovelace <ada@example.com> 1716240000 +0000\tmerge topic: Fast-forward`;

        // Act
        const entry = parseReflogLine(line, 40);

        // Assert
        expect(entry.message).toBe('merge topic: Fast-forward');
      });
    });
  });

  describe('Given an identity whose name contains spaces', () => {
    describe('When parsing', () => {
      it('Then the identity round-trips', () => {
        // Arrange
        const line = `${OID_A} ${OID_B} Ada Augusta Lovelace <ada@example.com> 1716240000 +0000\tx`;

        // Act
        const entry = parseReflogLine(line, 40);

        // Assert
        expect(entry.identity.name).toBe('Ada Augusta Lovelace');
      });
    });
  });

  describe('Given a tab-less line with a valid committer', () => {
    describe('When parsing', () => {
      it('Then the message is empty', () => {
        // Arrange — git writes an empty-message reflog entry with no TAB; the
        // committer runs to the end of the line.
        const line = `${OID_A} ${OID_B} Ada <ada@example.com> 1716240000 +0000`;

        // Act
        const entry = parseReflogLine(line, 40);

        // Assert
        expect(entry.message).toBe('');
        expect(entry.identity.name).toBe('Ada');
      });
    });
  });

  describe('Given a malformed line', () => {
    describe('When parsing', () => {
      it.each([
        {
          line: `${'a'.repeat(39)} ${OID_B} Ada <ada@example.com> 1716240000 +0000\tx`,
          reason: 'misplaced field separator',
          // a 39-char OID shifts the index-40 separator off; the separator
          // guard fires before OID validation.
          label: 'a short old OID',
        },
        {
          line: `${OID_A} ${'g'.repeat(40)} Ada <ada@example.com> 1716240000 +0000\tx`,
          reason: 'invalid object id',
          label: 'a non-hex new OID',
        },
        {
          line: `${OID_A}X${OID_B} Ada <ada@example.com> 1716240000 +0000\tx`,
          reason: 'misplaced field separator',
          label: 'a non-space field-separator at index 40 (between old and new OID)',
        },
        {
          line: `${OID_A} ${OID_B}X Ada <ada@example.com> 1716240000 +0000\tx`,
          reason: 'misplaced field separator',
          label: 'a non-space field-separator at index 81 (between new OID and identity)',
        },
        {
          line: `${OID_A} ${OID_B} no-brackets 1716240000 +0000\tx`,
          reason: 'invalid identity',
          label: 'an unparseable identity (no angle-bracketed email)',
        },
      ])('Then throws INVALID_REFLOG_ENTRY for $label', ({ line, reason }) => {
        // Arrange & Act & Assert
        expectInvalidReflogEntry(() => parseReflogLine(line, 40), reason);
      });
    });
  });

  describe('Given a malformed identity in a reflog line', () => {
    describe('When parsing', () => {
      it('Then it throws a TsgitError, not a bare Error', () => {
        // Arrange — `parseIdentity` rejects this: no angle-bracketed email.
        const line = `${OID_A} ${OID_B} no-brackets 1716240000 +0000\tx`;

        // Act
        let result: unknown;
        try {
          parseReflogLine(line, 40);
        } catch (error) {
          result = error;
        }

        // Assert
        expect(result).toBeInstanceOf(TsgitError);
        expect((result as TsgitError).data.code).toBe('INVALID_REFLOG_ENTRY');
      });
    });
  });
});

// ---------------------------------------------------------------------------
// SHA-256 (hexLength 64) — git-written literal bytes, captured from
// `git init --object-format=sha256; git commit` (real git 2.55.0, signing
// off). A round-trip through tsgit's own serialize/parse proves nothing here
// (both sides would agree on a shared bug); only git-written bytes do.
// ---------------------------------------------------------------------------

const SHA256_COMMIT_OID = ObjectId.from(
  '0e3459f47ec2fad125795139fdcfdb3e37bd10b3a19e1d5f423476371a28d0e5',
);
const SHA256_ZERO_OID = ObjectId.from('0'.repeat(64));

describe('Given a git-written SHA-256 reflog line', () => {
  describe('When parseReflogLine reads it at hexLength 64', () => {
    it('Then oldId, newId, identity and message match', () => {
      // Arrange — literal bytes from .git/logs/HEAD in a real
      // `git init --object-format=sha256` repository's first commit.
      const line =
        `${SHA256_ZERO_OID} ${SHA256_COMMIT_OID} Ada Lovelace <ada@example.com> ` +
        '1716240000 +0000\tcommit (initial): first commit';

      // Act
      const entry = parseReflogLine(line, 64);

      // Assert
      expect(entry).toEqual({
        oldId: SHA256_ZERO_OID,
        newId: SHA256_COMMIT_OID,
        identity: {
          name: 'Ada Lovelace',
          email: 'ada@example.com',
          timestamp: 1716240000,
          timezoneOffset: '+0000',
        },
        message: 'commit (initial): first commit',
      });
    });
  });
});

describe('Given a create entry in a SHA-256 repository', () => {
  describe('When serializeReflogLine writes it', () => {
    it('Then the old id is 64 zeros and the bytes equal git’s literal line', () => {
      // Arrange
      const entry: ReflogEntry = {
        oldId: SHA256_ZERO_OID,
        newId: SHA256_COMMIT_OID,
        identity: {
          name: 'Ada Lovelace',
          email: 'ada@example.com',
          timestamp: 1716240000,
          timezoneOffset: '+0000',
        },
        message: 'commit (initial): first commit',
      };

      // Act
      const line = serializeReflogLine(entry, 64);

      // Assert — byte-equal to the literal git-written line (LF appended)
      expect(line).toBe(
        `${SHA256_ZERO_OID} ${SHA256_COMMIT_OID} Ada Lovelace <ada@example.com> ` +
          '1716240000 +0000\tcommit (initial): first commit\n',
      );
    });
  });
});

describe('parseReflog', () => {
  describe('Given a multi-line reflog file', () => {
    describe('When parsing', () => {
      it('Then returns entries oldest-first', () => {
        // Arrange
        const first: ReflogEntry = { ...ENTRY, oldId: ZERO_OID, message: 'commit (initial): a' };
        const second: ReflogEntry = { ...ENTRY, message: 'commit: b' };
        const content = `${serializeReflogLine(first, 40)}${serializeReflogLine(second, 40)}`;

        // Act
        const entries = parseReflog(content, 40);

        // Assert
        expect(entries).toEqual([first, second]);
      });
    });
  });

  describe('Given a reflog file with a trailing blank line', () => {
    describe('When parsing', () => {
      it('Then the blank line is tolerated', () => {
        // Arrange
        const content = `${serializeReflogLine(ENTRY, 40)}`;

        // Act
        const entries = parseReflog(content, 40);

        // Assert
        expect(entries).toEqual([ENTRY]);
      });
    });
  });

  describe('Given an empty string', () => {
    describe('When parsing', () => {
      it('Then returns an empty array', () => {
        // Arrange
        const content = '';

        // Act
        const entries = parseReflog(content, 40);

        // Assert
        expect(entries).toEqual([]);
      });
    });
  });

  describe('Given a reflog file with a malformed line', () => {
    describe('When parsing', () => {
      it('Then throws INVALID_REFLOG_ENTRY', () => {
        // Arrange — a tab-less garbage line is now read as an empty-message
        // entry, so it fails on the misplaced field separator (too short for
        // the index-40 space) rather than a missing tab.
        const content = `${serializeReflogLine(ENTRY, 40)}garbage line\n`;

        // Act & Assert
        expectInvalidReflogEntry(() => parseReflog(content, 40), 'misplaced field separator');
      });
    });
  });
});

describe('sanitizeReflogMessage', () => {
  describe('Given a message needing sanitization', () => {
    describe('When sanitizing', () => {
      it.each([
        {
          message: 'first\nsecond',
          expected: 'first second',
          label: 'an embedded LF becomes a space',
        },
        {
          message: 'first\rsecond',
          expected: 'first second',
          label: 'an embedded CR becomes a space',
        },
        {
          message: '  padded message  ',
          expected: 'padded message',
          label: 'leading and trailing whitespace is trimmed',
        },
        {
          message: 'before\r\nafter',
          expected: 'before after',
          label: 'a CRLF sequence collapses to a single space',
        },
      ])('Then $label', ({ message, expected }) => {
        // Arrange & Act
        const result = sanitizeReflogMessage(message);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });
});

describe('reflog line round-trip property', () => {
  const arbHex = (length: number): fc.Arbitrary<string> =>
    fc
      .array(fc.constantFrom(...'0123456789abcdef'.split('')), {
        minLength: length,
        maxLength: length,
      })
      .map((chars) => chars.join(''));

  // Identity name/email exclude angle brackets, control chars, and the
  // surrounding-space ambiguity parseIdentity strips; messages exclude CR/LF
  // and the framing whitespace sanitizeReflogMessage trims.
  const arbSafeText = fc
    .string({ minLength: 1, maxLength: 20 })
    .filter((s) => !/[\n\r<>]/.test(s) && s.trim() === s);

  const arbEntry: fc.Arbitrary<ReflogEntry> = fc.record({
    oldId: arbHex(40).map((h) => ObjectId.from(h)),
    newId: arbHex(40).map((h) => ObjectId.from(h)),
    identity: fc.record({
      name: arbSafeText,
      email: arbSafeText,
      timestamp: fc.integer({ min: 0, max: 4_000_000_000 }),
      timezoneOffset: fc.constantFrom('+0000', '-0500', '+0900', '+0530'),
    }),
    message: fc.string({ maxLength: 30 }).filter((s) => !/[\n\r]/.test(s) && s.trim() === s),
  });

  describe('Given an arbitrary valid entry', () => {
    describe('When serialize then parse', () => {
      it('Then the entry is recovered', () => {
        // Arrange
        fc.assert(
          fc.property(arbEntry, (entry) => {
            // Act
            const recovered = parseReflogLine(
              serializeReflogLine(entry, 40).replace(/\n$/, ''),
              40,
            );

            // Assert
            expect(recovered).toEqual(entry);
          }),
        );
      });
    });
  });
});
