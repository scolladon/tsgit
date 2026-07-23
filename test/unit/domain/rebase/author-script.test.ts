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

    describe('When given a malformed author script', () => {
      it.each([
        {
          label: 'the GIT_AUTHOR_NAME line is missing',
          text: "GIT_AUTHOR_EMAIL='ada@example.com'\nGIT_AUTHOR_DATE='@1700000000 +0000'\n",
          expected: { code: 'INVALID_IDENTITY', reason: 'missing author-script key' },
        },
        {
          label: 'the GIT_AUTHOR_EMAIL line is missing',
          text: "GIT_AUTHOR_NAME='Ada'\nGIT_AUTHOR_DATE='@1700000000 +0000'\n",
          expected: { code: 'INVALID_IDENTITY' },
        },
        {
          label: 'the GIT_AUTHOR_DATE line is missing',
          text: "GIT_AUTHOR_NAME='Ada'\nGIT_AUTHOR_EMAIL='ada@example.com'\n",
          expected: { code: 'INVALID_IDENTITY' },
        },
        {
          label: 'the date lacks the `@` prefix',
          text: "GIT_AUTHOR_NAME='Ada'\nGIT_AUTHOR_EMAIL='ada@example.com'\nGIT_AUTHOR_DATE='1700000000 +0000'\n",
          expected: {
            code: 'INVALID_IDENTITY',
            reason: 'author-script date lacks the `@` prefix',
          },
        },
        {
          label: 'a value is not single-quoted',
          text: "GIT_AUTHOR_NAME=Ada\nGIT_AUTHOR_EMAIL='ada@example.com'\nGIT_AUTHOR_DATE='@1700000000 +0000'\n",
          expected: {
            code: 'INVALID_IDENTITY',
            reason: 'author-script value is not single-quoted',
          },
        },
        {
          label: 'a value has only an opening quote (no closing quote)',
          text: "GIT_AUTHOR_NAME='Ada\nGIT_AUTHOR_EMAIL='ada@example.com'\nGIT_AUTHOR_DATE='@1700000000 +0000'\n",
          expected: { code: 'INVALID_IDENTITY' },
        },
        {
          label: 'a value is a lone quote (too short to be a quoted pair)',
          text: "GIT_AUTHOR_NAME='\nGIT_AUTHOR_EMAIL='ada@example.com'\nGIT_AUTHOR_DATE='@1700000000 +0000'\n",
          expected: { code: 'INVALID_IDENTITY' },
        },
        {
          label:
            'a value ends with a quote but does not open with one (a trailing quote alone is not sq-quoting)',
          text: "GIT_AUTHOR_NAME=Ada'\nGIT_AUTHOR_EMAIL='ada@example.com'\nGIT_AUTHOR_DATE='@1700000000 +0000'\n",
          expected: {
            code: 'INVALID_IDENTITY',
            reason: 'author-script value is not single-quoted',
          },
        },
        {
          label: 'the timestamp is not a number',
          text: "GIT_AUTHOR_NAME='Ada'\nGIT_AUTHOR_EMAIL='ada@example.com'\nGIT_AUTHOR_DATE='@12x +0000'\n",
          expected: { code: 'INVALID_IDENTITY', reason: 'invalid author-script timestamp' },
        },
        {
          label: 'the date carries no timezone offset',
          text: "GIT_AUTHOR_NAME='Ada'\nGIT_AUTHOR_EMAIL='ada@example.com'\nGIT_AUTHOR_DATE='@1700000000'\n",
          expected: { code: 'INVALID_IDENTITY' },
        },
        {
          label: 'the timezone offset is malformed (present but not [+-]dddd)',
          text: "GIT_AUTHOR_NAME='Ada'\nGIT_AUTHOR_EMAIL='ada@example.com'\nGIT_AUTHOR_DATE='@1700000000 +00'\n",
          expected: {
            code: 'INVALID_IDENTITY',
            reason: 'invalid author-script timezone offset',
          },
        },
        {
          label:
            'the timezone offset carries leading noise before a valid suffix (must start at the sign, not merely end in one)',
          text: "GIT_AUTHOR_NAME='Ada'\nGIT_AUTHOR_EMAIL='ada@example.com'\nGIT_AUTHOR_DATE='@1700000000 0+0000'\n",
          expected: {
            code: 'INVALID_IDENTITY',
            reason: 'invalid author-script timezone offset',
          },
        },
        {
          label:
            'the timezone offset has an extra digit past the four (must end after exactly four digits)',
          text: "GIT_AUTHOR_NAME='Ada'\nGIT_AUTHOR_EMAIL='ada@example.com'\nGIT_AUTHOR_DATE='@1700000000 +00000'\n",
          expected: {
            code: 'INVALID_IDENTITY',
            reason: 'invalid author-script timezone offset',
          },
        },
      ])('Then throws INVALID_IDENTITY when $label', ({ text, expected }) => {
        // Arrange + Act
        let caught: TsgitError | undefined;
        try {
          parseAuthorScript(text);
        } catch (err) {
          caught = err as TsgitError;
        }

        // Assert
        expect(caught?.data).toMatchObject(expected);
      });
    });
  });
});
