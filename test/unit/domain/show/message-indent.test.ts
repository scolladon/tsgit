import { describe, expect, it } from 'vitest';

import { indentMessage } from '../../../../src/domain/show/message-indent.js';

describe('indentMessage', () => {
  describe('Given a single-line message, When indentMessage runs', () => {
    it('Then the line is prefixed with four spaces', () => {
      // Arrange
      const message = 'modify a.txt';

      // Act
      const sut = indentMessage(message);

      // Assert
      expect(sut).toBe('    modify a.txt');
    });
  });

  describe('Given a subject and body separated by a blank line, When indentMessage runs', () => {
    it('Then every line including the interior blank is indented', () => {
      // Arrange
      const message = 'initial commit\n\nsecond paragraph of body';

      // Act
      const sut = indentMessage(message);

      // Assert
      expect(sut).toBe('    initial commit\n    \n    second paragraph of body');
    });
  });

  describe('Given a message with a trailing blank-line run, When indentMessage runs', () => {
    it('Then the trailing blanks are stripped', () => {
      // Arrange
      const message = 'foo\n\n\n';

      // Act
      const sut = indentMessage(message);

      // Assert
      expect(sut).toBe('    foo');
    });
  });

  describe('Given a message with leading blank lines, When indentMessage runs', () => {
    it('Then the leading blanks are stripped', () => {
      // Arrange
      const message = '\n\nbar';

      // Act
      const sut = indentMessage(message);

      // Assert
      expect(sut).toBe('    bar');
    });
  });

  describe('Given an empty message, When indentMessage runs', () => {
    it('Then the result is empty', () => {
      // Arrange
      const message = '';

      // Act
      const sut = indentMessage(message);

      // Assert
      expect(sut).toBe('');
    });
  });

  describe('Given an all-blank message, When indentMessage runs', () => {
    it('Then the result is empty', () => {
      // Arrange
      const message = '\n\n';

      // Act
      const sut = indentMessage(message);

      // Assert
      expect(sut).toBe('');
    });
  });

  describe('Given a CRLF message, When indentMessage runs', () => {
    it('Then the carriage return is retained inside the indented line', () => {
      // Arrange
      const message = 'a\r\nb';

      // Act
      const sut = indentMessage(message);

      // Assert
      expect(sut).toBe('    a\r\n    b');
    });
  });

  describe('Given a content line with trailing spaces, When indentMessage runs', () => {
    it('Then the trailing spaces on a non-blank line are preserved', () => {
      // Arrange
      const message = 'a  \nb';

      // Act
      const sut = indentMessage(message);

      // Assert
      expect(sut).toBe('    a  \n    b');
    });
  });
});
