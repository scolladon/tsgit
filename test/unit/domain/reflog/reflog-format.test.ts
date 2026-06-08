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
        const sut = ENTRY;

        // Act
        const line = serializeReflogLine(sut);

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
        const sut: ReflogEntry = {
          ...ENTRY,
          oldId: ZERO_OID,
          message: 'commit (initial): add readme',
        };

        // Act
        const line = serializeReflogLine(sut);

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
        const sut: ReflogEntry = { ...ENTRY, message: '' };

        // Act
        const line = serializeReflogLine(sut);

        // Assert
        expect(line.endsWith('+0000\n')).toBe(true);
        expect(line.includes('\t')).toBe(false);
      });
    });
  });

  describe('Given a message containing LF', () => {
    describe('When serializing', () => {
      it('Then throws INVALID_REFLOG_ENTRY', () => {
        // Arrange
        const sut: ReflogEntry = { ...ENTRY, message: 'first\nsecond' };

        // Act & Assert
        expectInvalidReflogEntry(() => serializeReflogLine(sut), 'message contains a line break');
      });
    });
  });

  describe('Given a message containing CR', () => {
    describe('When serializing', () => {
      it('Then throws INVALID_REFLOG_ENTRY', () => {
        // Arrange
        const sut: ReflogEntry = { ...ENTRY, message: 'first\rsecond' };

        // Act & Assert
        expectInvalidReflogEntry(() => serializeReflogLine(sut), 'message contains a line break');
      });
    });
  });
});

describe('parseReflogLine', () => {
  describe('Given a well-formed line', () => {
    describe('When parsing', () => {
      it('Then returns the entry with all fields', () => {
        // Arrange
        const sut = `${OID_A} ${OID_B} Ada Lovelace <ada@example.com> 1716240000 +0000\tcommit: second`;

        // Act
        const entry = parseReflogLine(sut);

        // Assert
        expect(entry).toEqual(ENTRY);
      });
    });
  });

  describe('Given a line with an empty message', () => {
    describe('When parsing', () => {
      it('Then message is the empty string', () => {
        // Arrange
        const sut = `${OID_A} ${OID_B} Ada Lovelace <ada@example.com> 1716240000 +0000\t`;

        // Act
        const entry = parseReflogLine(sut);

        // Assert
        expect(entry.message).toBe('');
      });
    });
  });

  describe('Given a message containing spaces', () => {
    describe('When parsing', () => {
      it('Then the whole message after TAB is kept', () => {
        // Arrange
        const sut = `${OID_A} ${OID_B} Ada Lovelace <ada@example.com> 1716240000 +0000\tmerge topic: Fast-forward`;

        // Act
        const entry = parseReflogLine(sut);

        // Assert
        expect(entry.message).toBe('merge topic: Fast-forward');
      });
    });
  });

  describe('Given an identity whose name contains spaces', () => {
    describe('When parsing', () => {
      it('Then the identity round-trips', () => {
        // Arrange
        const sut = `${OID_A} ${OID_B} Ada Augusta Lovelace <ada@example.com> 1716240000 +0000\tx`;

        // Act
        const entry = parseReflogLine(sut);

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
        const sut = `${OID_A} ${OID_B} Ada <ada@example.com> 1716240000 +0000`;

        // Act
        const entry = parseReflogLine(sut);

        // Assert
        expect(entry.message).toBe('');
        expect(entry.identity.name).toBe('Ada');
      });
    });
  });

  describe('Given a line with a short old OID', () => {
    describe('When parsing', () => {
      it('Then throws INVALID_REFLOG_ENTRY', () => {
        // Arrange
        const sut = `${'a'.repeat(39)} ${OID_B} Ada <ada@example.com> 1716240000 +0000\tx`;

        // Act & Assert — a 39-char OID shifts the index-40 separator off; the
        // separator guard fires before OID validation.
        expectInvalidReflogEntry(() => parseReflogLine(sut), 'misplaced field separator');
      });
    });
  });

  describe('Given a line with a non-hex new OID', () => {
    describe('When parsing', () => {
      it('Then throws INVALID_REFLOG_ENTRY', () => {
        // Arrange
        const sut = `${OID_A} ${'g'.repeat(40)} Ada <ada@example.com> 1716240000 +0000\tx`;

        // Act & Assert
        expectInvalidReflogEntry(() => parseReflogLine(sut), 'invalid object id');
      });
    });
  });

  describe('Given a line whose field-separator at index 40 is not a space', () => {
    describe('When parsing', () => {
      it('Then throws INVALID_REFLOG_ENTRY', () => {
        // Arrange — replace the separator between old and new OID with a non-space.
        const sut = `${OID_A}X${OID_B} Ada <ada@example.com> 1716240000 +0000\tx`;

        // Act & Assert
        expectInvalidReflogEntry(() => parseReflogLine(sut), 'misplaced field separator');
      });
    });
  });

  describe('Given a line whose field-separator at index 81 is not a space', () => {
    describe('When parsing', () => {
      it('Then throws INVALID_REFLOG_ENTRY', () => {
        // Arrange — replace the separator between new OID and identity with a non-space.
        const sut = `${OID_A} ${OID_B}X Ada <ada@example.com> 1716240000 +0000\tx`;

        // Act & Assert
        expectInvalidReflogEntry(() => parseReflogLine(sut), 'misplaced field separator');
      });
    });
  });

  describe('Given a line with an unparseable identity', () => {
    describe('When parsing', () => {
      it('Then throws INVALID_REFLOG_ENTRY', () => {
        // Arrange — identity lacks the angle-bracketed email.
        const sut = `${OID_A} ${OID_B} no-brackets 1716240000 +0000\tx`;

        // Act & Assert
        expectInvalidReflogEntry(() => parseReflogLine(sut), 'invalid identity');
      });
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
        const sut = `${serializeReflogLine(first)}${serializeReflogLine(second)}`;

        // Act
        const entries = parseReflog(sut);

        // Assert
        expect(entries).toEqual([first, second]);
      });
    });
  });

  describe('Given a reflog file with a trailing blank line', () => {
    describe('When parsing', () => {
      it('Then the blank line is tolerated', () => {
        // Arrange
        const sut = `${serializeReflogLine(ENTRY)}`;

        // Act
        const entries = parseReflog(sut);

        // Assert
        expect(entries).toEqual([ENTRY]);
      });
    });
  });

  describe('Given an empty string', () => {
    describe('When parsing', () => {
      it('Then returns an empty array', () => {
        // Arrange
        const sut = '';

        // Act
        const entries = parseReflog(sut);

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
        const sut = `${serializeReflogLine(ENTRY)}garbage line\n`;

        // Act & Assert
        expectInvalidReflogEntry(() => parseReflog(sut), 'misplaced field separator');
      });
    });
  });
});

describe('sanitizeReflogMessage', () => {
  describe('Given a message with embedded LF', () => {
    describe('When sanitizing', () => {
      it('Then the LF becomes a space', () => {
        // Arrange
        const sut = 'first\nsecond';

        // Act
        const result = sanitizeReflogMessage(sut);

        // Assert
        expect(result).toBe('first second');
      });
    });
  });

  describe('Given a message with embedded CR', () => {
    describe('When sanitizing', () => {
      it('Then the CR becomes a space', () => {
        // Arrange
        const sut = 'first\rsecond';

        // Act
        const result = sanitizeReflogMessage(sut);

        // Assert
        expect(result).toBe('first second');
      });
    });
  });

  describe('Given a message with leading and trailing whitespace', () => {
    describe('When sanitizing', () => {
      it('Then it is trimmed', () => {
        // Arrange
        const sut = '  padded message  ';

        // Act
        const result = sanitizeReflogMessage(sut);

        // Assert
        expect(result).toBe('padded message');
      });
    });
  });

  describe('Given a CRLF sequence', () => {
    describe('When sanitizing', () => {
      it('Then it collapses to a single space', () => {
        // Arrange
        const sut = 'before\r\nafter';

        // Act
        const result = sanitizeReflogMessage(sut);

        // Assert
        expect(result).toBe('before after');
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
          fc.property(arbEntry, (sut) => {
            // Act
            const recovered = parseReflogLine(serializeReflogLine(sut).replace(/\n$/, ''));

            // Assert
            expect(recovered).toEqual(sut);
          }),
        );
      });
    });
  });
});
