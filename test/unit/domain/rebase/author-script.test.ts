import { describe, expect, it } from 'vitest';
import type { TsgitError } from '../../../../src/domain/error.js';
import {
  type AuthorIdentity,
  parseAuthorScript,
  serializeAuthorScript,
} from '../../../../src/domain/rebase/index.js';

const ADA: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

describe('rebase author-script', () => {
  describe('Given serializeAuthorScript', () => {
    describe('When given a plain identity', () => {
      it('Then emits the three GIT_AUTHOR_* lines with an `@<unix> <tz>` date', () => {
        // Arrange + Act
        const sut = serializeAuthorScript(ADA);

        // Assert
        expect(sut).toBe(
          "GIT_AUTHOR_NAME='Ada'\nGIT_AUTHOR_EMAIL='ada@example.com'\nGIT_AUTHOR_DATE='@1700000000 +0000'\n",
        );
      });
    });

    describe('When a field contains a single quote', () => {
      it("Then escapes it git's sq_quote way (`'` → `'\\''`)", () => {
        // Arrange
        const quotedId: AuthorIdentity = { ...ADA, name: "O'Neil" };

        // Act
        const sut = serializeAuthorScript(quotedId);

        // Assert
        expect(sut).toContain("GIT_AUTHOR_NAME='O'\\''Neil'\n");
      });
    });

    describe('When the timezone is negative', () => {
      it('Then preserves the signed offset verbatim', () => {
        // Arrange + Act
        const sut = serializeAuthorScript({ ...ADA, timezoneOffset: '-0530' });

        // Assert
        expect(sut).toContain("GIT_AUTHOR_DATE='@1700000000 -0530'\n");
      });
    });
  });

  describe('Given parseAuthorScript', () => {
    describe('When given a serialized script', () => {
      it('Then round-trips to the identity', () => {
        // Arrange + Act
        const sut = parseAuthorScript(serializeAuthorScript(ADA));

        // Assert
        expect(sut).toEqual(ADA);
      });
    });

    describe('When a field carries an escaped single quote', () => {
      it('Then unescapes it', () => {
        // Arrange
        const quotedId: AuthorIdentity = { ...ADA, name: "O'Neil" };

        // Act
        const sut = parseAuthorScript(serializeAuthorScript(quotedId));

        // Assert
        expect(sut.name).toBe("O'Neil");
      });
    });

    describe('When the GIT_AUTHOR_NAME line is missing', () => {
      it('Then throws INVALID_IDENTITY', () => {
        // Arrange + Act
        let caught: TsgitError | undefined;
        try {
          parseAuthorScript(
            "GIT_AUTHOR_EMAIL='ada@example.com'\nGIT_AUTHOR_DATE='@1700000000 +0000'\n",
          );
        } catch (err) {
          caught = err as TsgitError;
        }

        // Assert
        expect(caught?.data).toMatchObject({
          code: 'INVALID_IDENTITY',
          reason: 'missing author-script key',
        });
      });
    });

    describe('When the GIT_AUTHOR_EMAIL line is missing', () => {
      it('Then throws INVALID_IDENTITY', () => {
        // Arrange + Act
        let caught: TsgitError | undefined;
        try {
          parseAuthorScript("GIT_AUTHOR_NAME='Ada'\nGIT_AUTHOR_DATE='@1700000000 +0000'\n");
        } catch (err) {
          caught = err as TsgitError;
        }

        // Assert
        expect(caught?.data.code).toBe('INVALID_IDENTITY');
      });
    });

    describe('When the GIT_AUTHOR_DATE line is missing', () => {
      it('Then throws INVALID_IDENTITY', () => {
        // Arrange + Act
        let caught: TsgitError | undefined;
        try {
          parseAuthorScript("GIT_AUTHOR_NAME='Ada'\nGIT_AUTHOR_EMAIL='ada@example.com'\n");
        } catch (err) {
          caught = err as TsgitError;
        }

        // Assert
        expect(caught?.data.code).toBe('INVALID_IDENTITY');
      });
    });

    describe('When the date lacks the `@` prefix', () => {
      it('Then throws INVALID_IDENTITY', () => {
        // Arrange + Act
        let caught: TsgitError | undefined;
        try {
          parseAuthorScript(
            "GIT_AUTHOR_NAME='Ada'\nGIT_AUTHOR_EMAIL='ada@example.com'\nGIT_AUTHOR_DATE='1700000000 +0000'\n",
          );
        } catch (err) {
          caught = err as TsgitError;
        }

        // Assert
        expect(caught?.data).toMatchObject({
          code: 'INVALID_IDENTITY',
          reason: 'author-script date lacks the `@` prefix',
        });
      });
    });

    describe('When a value is not single-quoted', () => {
      it('Then throws INVALID_IDENTITY', () => {
        // Arrange + Act
        let caught: TsgitError | undefined;
        try {
          parseAuthorScript(
            "GIT_AUTHOR_NAME=Ada\nGIT_AUTHOR_EMAIL='ada@example.com'\nGIT_AUTHOR_DATE='@1700000000 +0000'\n",
          );
        } catch (err) {
          caught = err as TsgitError;
        }

        // Assert
        expect(caught?.data).toMatchObject({
          code: 'INVALID_IDENTITY',
          reason: 'author-script value is not single-quoted',
        });
      });
    });

    describe('When a value has only an opening quote', () => {
      it('Then throws INVALID_IDENTITY (no closing quote)', () => {
        // Arrange + Act
        let caught: TsgitError | undefined;
        try {
          parseAuthorScript(
            "GIT_AUTHOR_NAME='Ada\nGIT_AUTHOR_EMAIL='ada@example.com'\nGIT_AUTHOR_DATE='@1700000000 +0000'\n",
          );
        } catch (err) {
          caught = err as TsgitError;
        }

        // Assert
        expect(caught?.data.code).toBe('INVALID_IDENTITY');
      });
    });

    describe('When a value is a lone quote (too short to be a quoted pair)', () => {
      it('Then throws INVALID_IDENTITY', () => {
        // Arrange + Act
        let caught: TsgitError | undefined;
        try {
          parseAuthorScript(
            "GIT_AUTHOR_NAME='\nGIT_AUTHOR_EMAIL='ada@example.com'\nGIT_AUTHOR_DATE='@1700000000 +0000'\n",
          );
        } catch (err) {
          caught = err as TsgitError;
        }

        // Assert
        expect(caught?.data.code).toBe('INVALID_IDENTITY');
      });
    });

    describe('When a value ends with a quote but does not open with one', () => {
      it('Then throws INVALID_IDENTITY (a trailing quote alone is not sq-quoting)', () => {
        // Arrange + Act
        let caught: TsgitError | undefined;
        try {
          parseAuthorScript(
            "GIT_AUTHOR_NAME=Ada'\nGIT_AUTHOR_EMAIL='ada@example.com'\nGIT_AUTHOR_DATE='@1700000000 +0000'\n",
          );
        } catch (err) {
          caught = err as TsgitError;
        }

        // Assert
        expect(caught?.data).toMatchObject({
          code: 'INVALID_IDENTITY',
          reason: 'author-script value is not single-quoted',
        });
      });
    });

    describe('When the timestamp is not a number', () => {
      it('Then throws INVALID_IDENTITY', () => {
        // Arrange + Act
        let caught: TsgitError | undefined;
        try {
          parseAuthorScript(
            "GIT_AUTHOR_NAME='Ada'\nGIT_AUTHOR_EMAIL='ada@example.com'\nGIT_AUTHOR_DATE='@12x +0000'\n",
          );
        } catch (err) {
          caught = err as TsgitError;
        }

        // Assert
        expect(caught?.data).toMatchObject({
          code: 'INVALID_IDENTITY',
          reason: 'invalid author-script timestamp',
        });
      });
    });

    describe('When the date carries no timezone offset', () => {
      it('Then throws INVALID_IDENTITY (offset is absent)', () => {
        // Arrange + Act
        let caught: TsgitError | undefined;
        try {
          parseAuthorScript(
            "GIT_AUTHOR_NAME='Ada'\nGIT_AUTHOR_EMAIL='ada@example.com'\nGIT_AUTHOR_DATE='@1700000000'\n",
          );
        } catch (err) {
          caught = err as TsgitError;
        }

        // Assert
        expect(caught?.data.code).toBe('INVALID_IDENTITY');
      });
    });

    describe('When the timezone offset is malformed', () => {
      it('Then throws INVALID_IDENTITY (offset is present but not [+-]dddd)', () => {
        // Arrange + Act
        let caught: TsgitError | undefined;
        try {
          parseAuthorScript(
            "GIT_AUTHOR_NAME='Ada'\nGIT_AUTHOR_EMAIL='ada@example.com'\nGIT_AUTHOR_DATE='@1700000000 +00'\n",
          );
        } catch (err) {
          caught = err as TsgitError;
        }

        // Assert
        expect(caught?.data).toMatchObject({
          code: 'INVALID_IDENTITY',
          reason: 'invalid author-script timezone offset',
        });
      });
    });

    describe('When the timezone offset carries leading noise before a valid suffix', () => {
      it('Then throws INVALID_IDENTITY (the offset must start at the sign, not merely end in one)', () => {
        // Arrange + Act
        let caught: TsgitError | undefined;
        try {
          parseAuthorScript(
            "GIT_AUTHOR_NAME='Ada'\nGIT_AUTHOR_EMAIL='ada@example.com'\nGIT_AUTHOR_DATE='@1700000000 0+0000'\n",
          );
        } catch (err) {
          caught = err as TsgitError;
        }

        // Assert
        expect(caught?.data).toMatchObject({
          code: 'INVALID_IDENTITY',
          reason: 'invalid author-script timezone offset',
        });
      });
    });

    describe('When the timezone offset has an extra digit past the four', () => {
      it('Then throws INVALID_IDENTITY (the offset must end after exactly four digits)', () => {
        // Arrange + Act
        let caught: TsgitError | undefined;
        try {
          parseAuthorScript(
            "GIT_AUTHOR_NAME='Ada'\nGIT_AUTHOR_EMAIL='ada@example.com'\nGIT_AUTHOR_DATE='@1700000000 +00000'\n",
          );
        } catch (err) {
          caught = err as TsgitError;
        }

        // Assert
        expect(caught?.data).toMatchObject({
          code: 'INVALID_IDENTITY',
          reason: 'invalid author-script timezone offset',
        });
      });
    });
  });
});
