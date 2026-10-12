import { describe, expect, it } from 'vitest';
import { splitIdentLine } from '../../../../src/domain/pretty/ident.js';

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array | undefined): string | undefined =>
  bytes === undefined ? undefined : new TextDecoder().decode(bytes);

const split = (line: string) => {
  const sut = splitIdentLine;
  const parts = sut(encode(line));
  return {
    name: decode(parts.name),
    mail: decode(parts.mail),
    date: decode(parts.date),
    tz: decode(parts.tz),
  };
};

describe('splitIdentLine', () => {
  describe('Given a well-formed ident line (Pin S fixture)', () => {
    describe('When splitting it', () => {
      it('Then every part is returned', () => {
        // Arrange
        const line = 'A U Thor <author@example.com> 1700000200 +0545';

        // Act
        const result = split(line);

        // Assert
        expect(result).toEqual({
          name: 'A U Thor',
          mail: 'author@example.com',
          date: '1700000200',
          tz: '+0545',
        });
      });
    });
  });

  describe('Given an ident line without the closing angle bracket', () => {
    describe('When splitting it', () => {
      it('Then no part is returned', () => {
        // Arrange
        const line = 'N <m 5 +0100';

        // Act
        const result = split(line);

        // Assert
        expect(result).toEqual({
          name: undefined,
          mail: undefined,
          date: undefined,
          tz: undefined,
        });
      });
    });
  });

  describe('Given an ident line without the opening angle bracket', () => {
    describe('When splitting it', () => {
      it('Then no part is returned', () => {
        // Arrange
        const line = 'N m> 5 +0100';

        // Act
        const result = split(line);

        // Assert
        expect(result).toEqual({
          name: undefined,
          mail: undefined,
          date: undefined,
          tz: undefined,
        });
      });
    });
  });

  describe('Given an ident line without a date', () => {
    describe('When splitting it', () => {
      it('Then name and mail are returned and date and tz are not', () => {
        // Arrange
        const line = 'N <m>';

        // Act
        const result = split(line);

        // Assert
        expect(result).toEqual({ name: 'N', mail: 'm', date: undefined, tz: undefined });
      });
    });
  });

  describe('Given a timezone without a sign', () => {
    describe('When splitting it', () => {
      it('Then date and tz are not returned', () => {
        // Arrange
        const line = 'N <m> 123 0100';

        // Act
        const result = split(line);

        // Assert
        expect(result).toEqual({ name: 'N', mail: 'm', date: undefined, tz: undefined });
      });
    });
  });

  describe('Given a timezone with no date before it', () => {
    describe('When splitting it', () => {
      it('Then name and mail are returned and date and tz are not', () => {
        // Arrange
        const line = 'N <m> +0100';

        // Act
        const result = split(line);

        // Assert
        expect(result).toEqual({ name: 'N', mail: 'm', date: undefined, tz: undefined });
      });
    });
  });

  describe('Given a sign without digits in the timezone', () => {
    describe('When splitting it', () => {
      it('Then date and tz are not returned', () => {
        // Arrange
        const line = 'N <m> 5 +x';

        // Act
        const result = split(line);

        // Assert
        expect(result.date).toBeUndefined();
        expect(result.tz).toBeUndefined();
      });
    });
  });

  describe('Given a date followed by a non-digit and non-space byte', () => {
    describe('When splitting it', () => {
      it('Then date and tz are not returned', () => {
        // Arrange
        const line = 'N <m> 12x +0100';

        // Act
        const result = split(line);

        // Assert
        expect(result.date).toBeUndefined();
        expect(result.tz).toBeUndefined();
      });
    });
  });

  describe('Given extra whitespace around the parts', () => {
    describe('When splitting it', () => {
      it('Then trailing name space and spaces before date and tz are trimmed, leading name space is kept', () => {
        // Arrange
        const line = '  N  M  <m>  123   +0100';

        // Act
        const result = split(line);

        // Assert
        expect(result).toEqual({ name: '  N  M', mail: 'm', date: '123', tz: '+0100' });
      });
    });
  });

  describe('Given a mail with no name', () => {
    describe('When splitting it', () => {
      it('Then the name is empty', () => {
        // Arrange
        const line = '<m> 5 +0100';

        // Act
        const result = split(line);

        // Assert
        expect(result).toEqual({ name: '', mail: 'm', date: '5', tz: '+0100' });
      });
    });
  });

  describe('Given a name that is only whitespace before the angle bracket', () => {
    describe('When splitting it', () => {
      it('Then the name is empty', () => {
        // Arrange
        const line = '   <m> 5 +0100';

        // Act
        const result = split(line);

        // Assert
        expect(result.name).toBe('');
      });
    });
  });

  describe('Given a tab between date and timezone and no space after the closing bracket', () => {
    describe('When splitting it', () => {
      it('Then date and tz are found', () => {
        // Arrange
        const line = 'N <m>5\t+0100';

        // Act
        const result = split(line);

        // Assert
        expect(result).toEqual({ name: 'N', mail: 'm', date: '5', tz: '+0100' });
      });
    });
  });

  describe('Given a timezone with trailing junk and a second angle pair', () => {
    describe('When splitting it', () => {
      it('Then the mail ends at the first closing bracket and the date follows the last one', () => {
        // Arrange
        const line = 'N <a> x <b> 5 -01x junk';

        // Act
        const result = split(line);

        // Assert
        expect(result).toEqual({ name: 'N', mail: 'a', date: '5', tz: '-01' });
      });
    });
  });

  describe('Given an empty line', () => {
    describe('When splitting it', () => {
      it('Then no part is returned', () => {
        // Arrange
        const line = '';

        // Act
        const result = split(line);

        // Assert
        expect(result).toEqual({
          name: undefined,
          mail: undefined,
          date: undefined,
          tz: undefined,
        });
      });
    });
  });
});
