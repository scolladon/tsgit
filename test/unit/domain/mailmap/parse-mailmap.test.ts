import { describe, expect, it } from 'vitest';
import { parseMailmap } from '../../../../src/domain/mailmap/parse-mailmap.js';

describe('parseMailmap', () => {
  describe('Given the four line forms, When parsing', () => {
    it('Then each form yields its rule', () => {
      // Arrange
      const sut = parseMailmap;
      const text = [
        'Proper Name <commit@email>',
        '<proper@email> <commit@email>',
        'Proper Name <proper@email> <commit@email>',
        'Proper Name <proper@email> Commit Name <commit@email>',
      ].join('\n');

      // Act
      const result = sut(text);

      // Assert
      expect(result).toEqual([
        { newName: 'Proper Name', oldEmail: 'commit@email' },
        { newEmail: 'proper@email', oldEmail: 'commit@email' },
        { newName: 'Proper Name', newEmail: 'proper@email', oldEmail: 'commit@email' },
        {
          newName: 'Proper Name',
          newEmail: 'proper@email',
          oldName: 'Commit Name',
          oldEmail: 'commit@email',
        },
      ]);
    });
  });

  describe('Given a comment line, When parsing', () => {
    it('Then it is skipped', () => {
      // Arrange
      const sut = parseMailmap;

      // Act
      const result = sut('# Name <a@b>\nName <a@b>');

      // Assert
      expect(result).toEqual([{ newName: 'Name', oldEmail: 'a@b' }]);
    });
  });

  describe('Given a hash that is not the first byte, When parsing', () => {
    it('Then the line is kept and the hash belongs to the name', () => {
      // Arrange
      const sut = parseMailmap;

      // Act
      const result = sut('Hash # Name <new@e> <old@e>\n # indented <n@e> <o@e>');

      // Assert
      expect(result).toEqual([
        { newName: 'Hash # Name', newEmail: 'new@e', oldEmail: 'old@e' },
        { newName: '# indented', newEmail: 'n@e', oldEmail: 'o@e' },
      ]);
    });
  });

  describe('Given blank and CRLF-terminated lines, When parsing', () => {
    it('Then blanks are skipped and the carriage return is ignored', () => {
      // Arrange
      const sut = parseMailmap;

      // Act
      const result = sut('\n\r\nName <a@b>\r\n\n');

      // Assert
      expect(result).toEqual([{ newName: 'Name', oldEmail: 'a@b' }]);
    });
  });

  describe('Given malformed lines, When parsing', () => {
    it.each([
      ['no angle bracket', 'Name only'],
      ['unterminated email', 'Name <unterminated'],
      ['empty first email', 'Name <> <old@e>'],
      ['closing bracket first', 'Name > <a@b'],
      ['closing bracket without an opening one', 'Name>'],
      ['a NUL as the first byte', '\0<z@x>'],
    ])('Then %s is skipped', (_title, line) => {
      // Arrange
      const sut = parseMailmap;

      // Act
      const result = sut(`${line}\nOk <a@b>`);

      // Assert
      expect(result).toEqual([{ newName: 'Ok', oldEmail: 'a@b' }]);
    });
  });

  describe('Given a closing bracket inside the name, When parsing', () => {
    it('Then the email is the bracket pair after the opening one', () => {
      // Arrange
      const sut = parseMailmap;

      // Act
      const result = sut('New><old@x>');

      // Assert
      expect(result).toEqual([{ newName: 'New>', oldEmail: 'old@x' }]);
    });
  });

  describe('Given an email-only simple line, When parsing', () => {
    it('Then it still yields a rule without replacements', () => {
      // Arrange
      const sut = parseMailmap;

      // Act
      const result = sut('<a@b>');

      // Assert
      expect(result).toEqual([{ oldEmail: 'a@b' }]);
    });
  });

  describe('Given a second part without a well-formed email, When parsing', () => {
    it.each([
      ['no bracket', 'New <n@e> trailing text'],
      ['unterminated', 'New <n@e> Old <o@e'],
      ['trailing whitespace', 'New <n@e>   '],
    ])('Then %s leaves the simple form', (_title, line) => {
      // Arrange
      const sut = parseMailmap;

      // Act
      const result = sut(line);

      // Assert
      expect(result).toEqual([{ newName: 'New', oldEmail: 'n@e' }]);
    });
  });

  describe('Given an empty old email, When parsing', () => {
    it('Then the empty email is kept as the key', () => {
      // Arrange
      const sut = parseMailmap;

      // Act
      const result = sut('New <n@e> Old <>');

      // Assert
      expect(result).toEqual([{ newName: 'New', newEmail: 'n@e', oldName: 'Old', oldEmail: '' }]);
    });
  });

  describe('Given extra whitespace around names, When parsing', () => {
    it('Then names are trimmed and whitespace-only names are absent', () => {
      // Arrange
      const sut = parseMailmap;

      // Act
      const result = sut(' \t Name  \t<n@e>  \t Old \t <o@e>\n  <a@b> <c@d>');

      // Assert
      expect(result).toEqual([
        { newName: 'Name', newEmail: 'n@e', oldName: 'Old', oldEmail: 'o@e' },
        { newEmail: 'a@b', oldEmail: 'c@d' },
      ]);
    });
  });

  describe('Given a line with a NUL byte, When parsing', () => {
    it('Then the line is cut at the NUL', () => {
      // Arrange
      const sut = parseMailmap;

      // Act
      const result = sut('Name <a@b>\0 <c@d>');

      // Assert
      expect(result).toEqual([{ newName: 'Name', oldEmail: 'a@b' }]);
    });
  });

  describe('Given more than two emails, When parsing', () => {
    it('Then the extra ones are ignored', () => {
      // Arrange
      const sut = parseMailmap;

      // Act
      const result = sut('N <a@b> <c@d> <e@f>');

      // Assert
      expect(result).toEqual([{ newName: 'N', newEmail: 'a@b', oldEmail: 'c@d' }]);
    });
  });
});
