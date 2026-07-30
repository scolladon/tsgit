import { describe, expect, it } from 'vitest';

import {
  MAX_SHALLOW_ENTRIES,
  parseShallowFile,
} from '../../../../../src/application/primitives/internal/parse-shallow.js';
import {
  REASON_SHALLOW_BAD_LINE,
  REASON_SHALLOW_TOO_MANY_ENTRIES,
} from '../../../../../src/application/primitives/validators.js';
import { TsgitError } from '../../../../../src/domain/index.js';
import { ObjectId } from '../../../../../src/domain/objects/object-id.js';

const OID_A = ObjectId.from('a'.repeat(40));
const OID_B = ObjectId.from('b'.repeat(40));

const expectBadLine = (raw: string, lineNumber: number): void => {
  try {
    parseShallowFile(raw);
    throw new Error('expected throw');
  } catch (err) {
    // Assert
    expect(err).toBeInstanceOf(TsgitError);
    if (!(err instanceof TsgitError)) throw err;
    expect(err.data.code).toBe('SHALLOW_FILE_MALFORMED');
    expect(err.data.code === 'SHALLOW_FILE_MALFORMED' && err.data.reason).toBe(
      REASON_SHALLOW_BAD_LINE,
    );
    expect(err.data.code === 'SHALLOW_FILE_MALFORMED' && err.data.lineNumber).toBe(lineNumber);
  }
};

describe('parseShallowFile', () => {
  describe('Given a canonical single-oid shallow file', () => {
    describe('When parseShallowFile runs', () => {
      it('Then it returns that one oid', () => {
        // Arrange
        const sut = parseShallowFile;
        const raw = `${OID_A}\n`;

        // Act
        const result = sut(raw);

        // Assert
        expect(result).toEqual([OID_A]);
      });
    });
  });

  describe('Given a 0-byte shallow file', () => {
    describe('When parseShallowFile runs', () => {
      it('Then it returns zero lines (no refusal)', () => {
        // Arrange
        const sut = parseShallowFile;

        // Act
        const result = sut('');

        // Assert
        expect(result).toEqual([]);
      });
    });
  });

  describe('Given a shallow file with no trailing newline', () => {
    describe('When parseShallowFile runs', () => {
      it('Then it returns that one oid', () => {
        // Arrange
        const sut = parseShallowFile;

        // Act
        const result = sut(OID_A);

        // Assert
        expect(result).toEqual([OID_A]);
      });
    });
  });

  describe('Given a shallow file with a CRLF-terminated oid line', () => {
    describe('When parseShallowFile runs', () => {
      it('Then it returns that one oid, ignoring the trailing CR', () => {
        // Arrange
        const sut = parseShallowFile;
        const raw = `${OID_A}\r\n`;

        // Act
        const result = sut(raw);

        // Assert
        expect(result).toEqual([OID_A]);
      });
    });
  });

  describe('Given a shallow file with trailing junk after the oid', () => {
    describe('When parseShallowFile runs', () => {
      it('Then it returns that one oid, ignoring the junk', () => {
        // Arrange
        const sut = parseShallowFile;
        const raw = `${OID_A} trailing junk\n`;

        // Act
        const result = sut(raw);

        // Assert
        expect(result).toEqual([OID_A]);
      });
    });
  });

  describe('Given a shallow file with an uppercase oid', () => {
    describe('When parseShallowFile runs', () => {
      it('Then it returns the oid normalised to lowercase', () => {
        // Arrange
        const sut = parseShallowFile;
        const raw = `${OID_A.toUpperCase()}\n`;

        // Act
        const result = sut(raw);

        // Assert
        expect(result).toEqual([OID_A]);
      });
    });
  });

  describe('Given a shallow file with duplicate and unsorted oids', () => {
    describe('When parseShallowFile runs', () => {
      it('Then it returns each parsed line in file order, duplicates included', () => {
        // Arrange — de-duplication and sorting are the caller's Set, not this parser's job.
        const sut = parseShallowFile;
        const raw = `${OID_B}\n${OID_A}\n${OID_A}\n`;

        // Act
        const result = sut(raw);

        // Assert
        expect(result).toEqual([OID_B, OID_A, OID_A]);
      });
    });
  });

  describe('Given a shallow file with a leading blank line', () => {
    describe('When parseShallowFile runs', () => {
      it('Then it refuses at line 1', () => {
        // Arrange
        const raw = `\n${OID_A}\n`;

        // Act & Assert
        expectBadLine(raw, 1);
      });
    });
  });

  describe('Given a shallow file with an embedded blank line', () => {
    describe('When parseShallowFile runs', () => {
      it('Then it refuses at line 2', () => {
        // Arrange
        const raw = `${OID_A}\n\n${OID_B}\n`;

        // Act & Assert
        expectBadLine(raw, 2);
      });
    });
  });

  describe('Given a shallow file with a trailing blank line at EOF', () => {
    describe('When parseShallowFile runs', () => {
      it('Then it refuses at line 2', () => {
        // Arrange
        const raw = `${OID_A}\n\n`;

        // Act & Assert
        expectBadLine(raw, 2);
      });
    });
  });

  describe('Given a shallow file with a non-oid line', () => {
    describe('When parseShallowFile runs', () => {
      it('Then it refuses at line 1', () => {
        // Arrange
        const raw = `not-an-oid\n${OID_A}\n`;

        // Act & Assert
        expectBadLine(raw, 1);
      });
    });
  });

  describe('Given a shallow file with a 39-character short oid line', () => {
    describe('When parseShallowFile runs', () => {
      it('Then it refuses at line 1', () => {
        // Arrange
        const raw = `${'a'.repeat(39)}\n`;

        // Act & Assert
        expectBadLine(raw, 1);
      });
    });
  });

  describe('Given a shallow file with more entries than MAX_SHALLOW_ENTRIES', () => {
    describe('When parseShallowFile runs', () => {
      it('Then it refuses at the first line beyond the cap', () => {
        // Arrange
        const raw = `${OID_A}\n`.repeat(MAX_SHALLOW_ENTRIES + 1);

        // Act
        let caught: unknown;
        try {
          parseShallowFile(raw);
          throw new Error('expected throw');
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        if (!(caught instanceof TsgitError)) throw caught;
        expect(caught.data.code).toBe('SHALLOW_FILE_MALFORMED');
        expect(caught.data.code === 'SHALLOW_FILE_MALFORMED' && caught.data.reason).toBe(
          REASON_SHALLOW_TOO_MANY_ENTRIES,
        );
        expect(caught.data.code === 'SHALLOW_FILE_MALFORMED' && caught.data.lineNumber).toBe(
          MAX_SHALLOW_ENTRIES + 1,
        );
      });
    });
  });

  describe('Given a shallow file with exactly MAX_SHALLOW_ENTRIES entries', () => {
    describe('When parseShallowFile runs', () => {
      it('Then it accepts all of them', () => {
        // Arrange
        const raw = `${OID_A}\n`.repeat(MAX_SHALLOW_ENTRIES);

        // Act
        const result = parseShallowFile(raw);

        // Assert
        expect(result.length).toBe(MAX_SHALLOW_ENTRIES);
      });
    });
  });
});
