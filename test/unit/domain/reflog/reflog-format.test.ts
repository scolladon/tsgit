import { describe, expect, it } from 'vitest';
import { TsgitError } from '../../../../src/domain/error.js';
import type { AuthorIdentity } from '../../../../src/domain/objects/index.js';
import { ObjectId, ZERO_OID } from '../../../../src/domain/objects/index.js';
import type { ReflogEntry } from '../../../../src/domain/reflog/reflog-entry.js';
import {
  parseReflog,
  parseReflogBytes,
  parseReflogLenient,
  parseReflogLenientBytes,
  parseReflogLine,
  sanitizeReflogMessage,
  serializeReflogLine,
  serializeReflogRewriteLine,
  serializeReflogRewriteLineBytes,
} from '../../../../src/domain/reflog/reflog-format.js';

const ENCODER = new TextEncoder();

/**
 * Builds a Uint8Array from a mix of ASCII strings (UTF-8 encoded) and raw
 * byte values, so a test can drop a specific non-UTF-8 byte (e.g. a latin1
 * 0xE9) at an exact position without fighting string-literal escaping.
 */
function bytesFrom(...parts: ReadonlyArray<string | number>): Uint8Array {
  const chunks = parts.map((part) =>
    typeof part === 'number' ? Uint8Array.of(part) : ENCODER.encode(part),
  );
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

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

  describe('Given an entry whose identity timestamp is zero', () => {
    describe('When serializing', () => {
      it('Then throws INVALID_REFLOG_ENTRY', () => {
        // Arrange
        const entry: ReflogEntry = { ...ENTRY, identity: { ...IDENTITY, timestamp: 0 } };

        // Act & Assert
        expectInvalidReflogEntry(
          () => serializeReflogLine(entry, 40),
          'timestamp must be non-zero',
        );
      });
    });
  });
});

describe('serializeReflogRewriteLine', () => {
  describe('Given an empty message', () => {
    describe('When serializing', () => {
      it('Then a trailing TAB is written before the line feed', () => {
        // Arrange — git's expire/delete rewrite writer always emits the TAB,
        // even for an empty message (unlike the append writer).
        const entry: ReflogEntry = { ...ENTRY, message: '' };

        // Act
        const line = serializeReflogRewriteLine(entry, 40);

        // Assert
        expect(line).toBe(`${OID_A} ${OID_B} Ada Lovelace <ada@example.com> 1716240000 +0000\t\n`);
      });
    });
  });

  describe('Given a non-empty message', () => {
    describe('When serializing', () => {
      it('Then the bytes are identical to serializeReflogLine', () => {
        // Arrange
        const entry = ENTRY;

        // Act
        const rewriteLine = serializeReflogRewriteLine(entry, 40);

        // Assert
        expect(rewriteLine).toBe(serializeReflogLine(entry, 40));
      });
    });
  });

  describe('Given a message containing an LF', () => {
    describe('When serializing', () => {
      it('Then throws INVALID_REFLOG_ENTRY', () => {
        // Arrange
        const entry: ReflogEntry = { ...ENTRY, message: 'first\nsecond' };

        // Act & Assert
        expectInvalidReflogEntry(
          () => serializeReflogRewriteLine(entry, 40),
          'message contains a line break',
        );
      });
    });
  });

  describe('Given a message carrying a bare CR', () => {
    describe('When serializing', () => {
      it('Then the CR is emitted verbatim in the message bytes', () => {
        // Arrange — a CRLF reflog file parses to messages with a trailing \r;
        // git's rewrite writes that byte back untouched (measured, 2.55.0).
        const entry: ReflogEntry = { ...ENTRY, message: 'crlf tail\r' };

        // Act
        const result = serializeReflogRewriteLine(entry, 40);

        // Assert
        expect(result.endsWith('\tcrlf tail\r\n')).toBe(true);
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
          () => serializeReflogRewriteLine(entry, 64),
          'object id does not match the repository oid width',
        );
      });
    });
  });

  describe('Given an entry whose identity timestamp is zero', () => {
    describe('When serializing', () => {
      it('Then throws INVALID_REFLOG_ENTRY', () => {
        // Arrange
        const entry: ReflogEntry = { ...ENTRY, identity: { ...IDENTITY, timestamp: 0 } };

        // Act & Assert
        expectInvalidReflogEntry(
          () => serializeReflogRewriteLine(entry, 40),
          'timestamp must be non-zero',
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

  describe('Given a reflog line whose timestamp is zero', () => {
    describe('When parsing', () => {
      it('Then throws INVALID_REFLOG_ENTRY with the zero-timestamp reason', () => {
        // Arrange
        const line = `${OID_A} ${OID_B} Ada <ada@example.com> 0 +0000\tcommit: x`;

        // Act & Assert
        expectInvalidReflogEntry(() => parseReflogLine(line, 40), 'zero timestamp');
      });
    });
  });

  describe('Given a reflog line whose timestamp is not a number', () => {
    describe('When parsing', () => {
      it('Then throws INVALID_REFLOG_ENTRY with the invalid-identity reason', () => {
        // Arrange — a distinct guard from the zero-timestamp one: neither
        // test can pass by the other guard firing instead.
        const line = `${OID_A} ${OID_B} Ada <ada@example.com> not-a-number +0200\tcommit: x`;

        // Act & Assert
        expectInvalidReflogEntry(() => parseReflogLine(line, 40), 'invalid identity');
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

  describe('Given a reflog file whose final line has no terminating LF', () => {
    describe('When parsing', () => {
      it('Then the unterminated entry is dropped rather than throwing', () => {
        // Arrange
        const first: ReflogEntry = { ...ENTRY, oldId: ZERO_OID, message: 'commit (initial): a' };
        const second: ReflogEntry = { ...ENTRY, message: 'commit: b' };
        const third: ReflogEntry = { ...ENTRY, message: 'commit: c' };
        const content =
          `${serializeReflogLine(first, 40)}${serializeReflogLine(second, 40)}` +
          serializeReflogLine(third, 40).replace(/\n$/, '');

        // Act
        const entries = parseReflog(content, 40);

        // Assert
        expect(entries).toEqual([first, second]);
      });
    });
  });

  describe('Given a reflog file that is a single unterminated line', () => {
    describe('When parsing', () => {
      it('Then returns an empty array', () => {
        // Arrange
        const content = 'garbage line';

        // Act
        const entries = parseReflog(content, 40);

        // Assert
        expect(entries).toEqual([]);
      });
    });
  });
});

describe('parseReflogLenient', () => {
  describe('Given a reflog file with a garbage line between two valid entries', () => {
    describe('When parsing', () => {
      it('Then the garbage line is skipped and both valid entries are returned', () => {
        // Arrange — pinned against git 2.55.0: `git gc --prune=now` keeps an
        // object reachable only through a valid entry that shares a reflog
        // file with a garbage line (`for_each_reflog_ent` skips the bad
        // line rather than discarding the whole file).
        const first: ReflogEntry = { ...ENTRY, oldId: ZERO_OID, message: 'commit (initial): a' };
        const second: ReflogEntry = { ...ENTRY, message: 'commit: b' };
        const content = `${serializeReflogLine(first, 40)}garbage line\n${serializeReflogLine(second, 40)}`;

        // Act
        const entries = parseReflogLenient(content, 40);

        // Assert
        expect(entries).toEqual([first, second]);
      });
    });
  });

  describe('Given a well-formed multi-line reflog file', () => {
    describe('When parsing', () => {
      it('Then returns every entry oldest-first, same as parseReflog', () => {
        // Arrange
        const first: ReflogEntry = { ...ENTRY, oldId: ZERO_OID, message: 'commit (initial): a' };
        const second: ReflogEntry = { ...ENTRY, message: 'commit: b' };
        const content = `${serializeReflogLine(first, 40)}${serializeReflogLine(second, 40)}`;

        // Act
        const entries = parseReflogLenient(content, 40);

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
        const entries = parseReflogLenient(content, 40);

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
        const entries = parseReflogLenient(content, 40);

        // Assert
        expect(entries).toEqual([]);
      });
    });
  });

  describe('Given a reflog file with ONLY a garbage line', () => {
    describe('When parsing', () => {
      it('Then returns an empty array rather than throwing', () => {
        // Arrange
        const content = 'garbage line\n';

        // Act
        const entries = parseReflogLenient(content, 40);

        // Assert
        expect(entries).toEqual([]);
      });
    });
  });

  describe('Given a reflog file whose final line has no terminating LF', () => {
    describe('When parseReflogLenient parses it', () => {
      it('Then the unterminated entry is absent and the terminated ones survive', () => {
        // Arrange
        const first: ReflogEntry = { ...ENTRY, oldId: ZERO_OID, message: 'commit (initial): a' };
        const second: ReflogEntry = { ...ENTRY, message: 'commit: b' };
        const third: ReflogEntry = { ...ENTRY, message: 'commit: c' };
        const content =
          `${serializeReflogLine(first, 40)}${serializeReflogLine(second, 40)}` +
          serializeReflogLine(third, 40).replace(/\n$/, '');

        // Act
        const entries = parseReflogLenient(content, 40);

        // Assert
        expect(entries).toEqual([first, second]);
      });
    });
  });

  describe('Given a reflog file that is a single VALID unterminated line', () => {
    describe('When parsing', () => {
      it('Then returns an empty array — the LF rule alone drops it', () => {
        // Arrange — a line the per-line predicate would ACCEPT, so only the
        // file-level must-end-with-LF rule can be responsible for the drop
        // (a garbage line here would pass with or without that rule).
        const content = serializeReflogLine(ENTRY, 40).slice(0, -1);

        // Act
        const entries = parseReflogLenient(content, 40);

        // Assert
        expect(entries).toEqual([]);
      });
    });
  });
});

describe('parseReflogBytes', () => {
  describe('Given a line whose identity name and message each carry a non-UTF-8 byte', () => {
    describe('When parsing', () => {
      it('Then the display strings carry U+FFFD and raw carries the exact on-disk bytes', () => {
        // Arrange — a latin1 0xE9 ("é" in ISO-8859-1) is not valid UTF-8 on
        // its own, in both the identity name and the message.
        const line = bytesFrom(
          `${OID_A} ${OID_B} Ad`,
          0xe9,
          ' Lovelace <ada@example.com> 1716240000 +0000\tcommit: caf',
          0xe9,
          '\n',
        );

        // Act
        const entries = parseReflogBytes(line, 40);

        // Assert
        expect(entries).toHaveLength(1);
        const sut = entries[0] as ReflogEntry;
        expect(sut.identity.name).toBe('Ad� Lovelace');
        expect(sut.message).toBe('commit: caf�');
        expect(sut.raw?.identity).toEqual(bytesFrom('Ad', 0xe9, ' Lovelace <ada@example.com>'));
        expect(sut.raw?.message).toEqual(bytesFrom('commit: caf', 0xe9));
      });
    });
  });

  describe('Given a line whose identity name carries a legitimate multi-byte UTF-8 character', () => {
    describe('When parsing', () => {
      it('Then the character decodes correctly rather than mojibake', () => {
        // Arrange — "é" as a valid 2-byte UTF-8 sequence (0xC3 0xA9), not a
        // corruption; the byte parser must decode it, not latin1-mangle it.
        const line = bytesFrom(
          `${OID_A} ${OID_B} Café Owner <ada@example.com> 1716240000 +0000\tx\n`,
        );

        // Act
        const entries = parseReflogBytes(line, 40);

        // Assert
        expect(entries[0]?.identity.name).toBe('Café Owner');
      });
    });
  });

  describe('Given a tab-less line (empty message)', () => {
    describe('When parsing', () => {
      it('Then raw.message is empty and the display message is the empty string', () => {
        // Arrange
        const line = bytesFrom(`${OID_A} ${OID_B} Ada <ada@example.com> 1716240000 +0000\n`);

        // Act
        const entries = parseReflogBytes(line, 40);

        // Assert
        const sut = entries[0] as ReflogEntry;
        expect(sut.message).toBe('');
        expect(sut.raw?.message).toEqual(new Uint8Array(0));
      });
    });
  });

  describe('Given a trailing blank line', () => {
    describe('When parsing', () => {
      it('Then the blank line is tolerated', () => {
        // Arrange
        const line = bytesFrom(`${OID_A} ${OID_B} Ada <ada@example.com> 1716240000 +0000\tx\n`);

        // Act
        const entries = parseReflogBytes(line, 40);

        // Assert
        expect(entries).toHaveLength(1);
      });
    });
  });

  describe('Given a reflog file with a malformed line', () => {
    describe('When parsing', () => {
      it('Then throws INVALID_REFLOG_ENTRY', () => {
        // Arrange
        const line = bytesFrom(
          `${OID_A} ${OID_B} Ada <ada@example.com> 1716240000 +0000\tx\n`,
          'garbage line\n',
        );

        // Act & Assert
        expectInvalidReflogEntry(() => parseReflogBytes(line, 40), 'misplaced field separator');
      });
    });
  });

  describe('Given a line whose timestamp is zero', () => {
    describe('When parsing', () => {
      it('Then throws INVALID_REFLOG_ENTRY with the zero-timestamp reason', () => {
        // Arrange — the strict byte parser reuses parseReflogLine's grammar,
        // so the zero-timestamp refusal is reachable through it directly.
        const line = bytesFrom(`${OID_A} ${OID_B} Ada <ada@example.com> 0 +0000\tcommit: x\n`);

        // Act & Assert
        expectInvalidReflogEntry(() => parseReflogBytes(line, 40), 'zero timestamp');
      });
    });
  });
});

describe('parseReflogLenientBytes', () => {
  describe('Given a garbage line between two valid entries', () => {
    describe('When parsing', () => {
      it('Then the garbage line is skipped and both valid entries carry their raw bytes', () => {
        // Arrange
        const line = bytesFrom(
          `${OID_A} ${OID_B} Ada <ada@example.com> 1716240000 +0000\tfirst\n`,
          'garbage line\n',
          `${OID_B} ${OID_A} Ada <ada@example.com> 1716240000 +0000\tsecond\n`,
        );

        // Act
        const entries = parseReflogLenientBytes(line, 40);

        // Assert
        expect(entries.map((e) => e.message)).toEqual(['first', 'second']);
        expect(entries[0]?.raw).toBeDefined();
        expect(entries[1]?.raw).toBeDefined();
      });
    });
  });

  describe('Given a line whose misplaced separator falls at the old/new id boundary', () => {
    describe('When parsing', () => {
      it('Then the line is skipped without constructing an error', () => {
        // Arrange — the SP at index 40 (old/new id boundary) is replaced,
        // isolating this guard from the second separator check.
        const line = bytesFrom(
          `${'a'.repeat(40)}X${'b'.repeat(40)} Ada <ada@example.com> 1716240000 +0000\tx\n`,
        );

        // Act
        const entries = parseReflogLenientBytes(line, 40);

        // Assert
        expect(entries).toEqual([]);
      });
    });
  });

  describe('Given a line whose misplaced separator falls at the new-id/identity boundary', () => {
    describe('When parsing', () => {
      it('Then the line is skipped without constructing an error', () => {
        // Arrange — the SP at index 81 (new id/identity boundary) is
        // replaced while the old/new id boundary stays correct, isolating
        // this guard from the first separator check.
        const line = bytesFrom(`${OID_A} ${OID_B}X Ada <ada@example.com> 1716240000 +0000\tx\n`);

        // Act
        const entries = parseReflogLenientBytes(line, 40);

        // Assert
        expect(entries).toEqual([]);
      });
    });
  });

  describe('Given a line that passes the cheap separator pre-check but fails deeper validation', () => {
    describe('When parsing', () => {
      it('Then the line is skipped', () => {
        // Arrange — non-hex characters in the old id; both separator
        // positions are correct, so this only fails inside parseReflogLine.
        const line = bytesFrom(
          `${'g'.repeat(40)} ${OID_B} Ada <ada@example.com> 1716240000 +0000\tx\n`,
        );

        // Act
        const entries = parseReflogLenientBytes(line, 40);

        // Assert
        expect(entries).toEqual([]);
      });
    });
  });

  describe('Given a trailing blank line', () => {
    describe('When parsing', () => {
      it('Then the blank line is tolerated', () => {
        // Arrange
        const line = bytesFrom(`${OID_A} ${OID_B} Ada <ada@example.com> 1716240000 +0000\tx\n`);

        // Act
        const entries = parseReflogLenientBytes(line, 40);

        // Assert
        expect(entries).toHaveLength(1);
      });
    });
  });

  describe('Given a line whose timestamp is zero', () => {
    describe('When parsing', () => {
      it('Then the line is skipped rather than throwing', () => {
        // Arrange — the isolated lenient-path counterpart to the strict
        // zero-timestamp refusal above.
        const line = bytesFrom(`${OID_A} ${OID_B} Ada <ada@example.com> 0 +0000\tcommit: x\n`);

        // Act
        const entries = parseReflogLenientBytes(line, 40);

        // Assert
        expect(entries).toEqual([]);
      });
    });
  });

  describe('Given a `>` inside the identity name', () => {
    describe('When parsing', () => {
      it('Then the name is kept up to the LAST `>`, matching the string-tier parser', () => {
        // Arrange — pinned against the string-tier divergence from git: the
        // byte tier must not change which lines tsgit accepts or how it
        // splits the identity.
        const line = bytesFrom(
          `${OID_A} ${OID_B} x>y <probe@example.com> 1700000002 +0200\tcommit: c2\n`,
        );

        // Act
        const entries = parseReflogLenientBytes(line, 40);

        // Assert
        expect(entries[0]?.identity.name).toBe('x>y');
        expect(entries[0]?.identity.email).toBe('probe@example.com');
      });
    });
  });
});

describe('serializeReflogRewriteLineBytes', () => {
  describe('Given an entry parsed from bytes carrying raw slices', () => {
    describe('When serializing', () => {
      it('Then the original on-disk bytes are re-emitted exactly', () => {
        // Arrange
        const original = bytesFrom(
          `${OID_A} ${OID_B} Ad`,
          0xe9,
          ' Lovelace <ada@example.com> 1716240000 +0000\tcommit: caf',
          0xe9,
          '\n',
        );
        const [sut] = parseReflogBytes(original, 40);

        // Act
        const rewritten = serializeReflogRewriteLineBytes(sut as ReflogEntry, 40);

        // Assert
        expect(rewritten).toEqual(original);
      });
    });
  });

  describe('Given an entry with no raw slices', () => {
    describe('When serializing', () => {
      it('Then it falls back to the UTF-8-encoded string rewrite serializer', () => {
        // Arrange
        const entry: ReflogEntry = { ...ENTRY, message: '' };

        // Act
        const result = serializeReflogRewriteLineBytes(entry, 40);

        // Assert
        expect(result).toEqual(new TextEncoder().encode(serializeReflogRewriteLine(entry, 40)));
      });
    });
  });

  describe('Given an entry whose identity timestamp is zero', () => {
    describe('When serializing with raw slices present', () => {
      it('Then throws INVALID_REFLOG_ENTRY', () => {
        // Arrange
        const original = bytesFrom(`${OID_A} ${OID_B} Ada <ada@example.com> 1716240000 +0000\tx\n`);
        const [parsed] = parseReflogBytes(original, 40);
        const entry: ReflogEntry = {
          ...(parsed as ReflogEntry),
          identity: { ...(parsed as ReflogEntry).identity, timestamp: 0 },
        };

        // Act & Assert
        expectInvalidReflogEntry(
          () => serializeReflogRewriteLineBytes(entry, 40),
          'timestamp must be non-zero',
        );
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
