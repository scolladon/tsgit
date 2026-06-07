import { describe, expect, it } from 'vitest';

import {
  foldSubject,
  stripspace,
  subjectLine,
} from '../../../../src/domain/objects/commit-message.js';

describe('stripspace', () => {
  describe('Given a message with no trailing newline, When stripspace runs', () => {
    it('Then a single trailing newline is appended', () => {
      // Arrange
      const message = 'first';

      // Act
      const sut = stripspace(message);

      // Assert
      expect(sut).toBe('first\n');
    });
  });

  describe('Given a line with trailing spaces, When stripspace runs', () => {
    it('Then the trailing spaces are stripped', () => {
      // Arrange
      const message = 'a  ';

      // Act
      const sut = stripspace(message);

      // Assert
      expect(sut).toBe('a\n');
    });
  });

  describe('Given a line with a trailing tab, When stripspace runs', () => {
    it('Then the trailing tab is stripped', () => {
      // Arrange
      const message = 'a\t';

      // Act
      const sut = stripspace(message);

      // Assert
      expect(sut).toBe('a\n');
    });
  });

  describe('Given a line ending in a vertical tab, When stripspace runs', () => {
    it('Then the trailing vertical tab is stripped', () => {
      // Arrange
      const message = 'a\v';

      // Act
      const sut = stripspace(message);

      // Assert
      expect(sut).toBe('a\n');
    });
  });

  describe('Given a line ending in a form feed, When stripspace runs', () => {
    it('Then the trailing form feed is stripped', () => {
      // Arrange
      const message = 'a\f';

      // Act
      const sut = stripspace(message);

      // Assert
      expect(sut).toBe('a\n');
    });
  });

  describe('Given CRLF line endings, When stripspace runs', () => {
    it('Then the carriage returns are stripped, leaving LF', () => {
      // Arrange
      const message = 'a\r\nb\r\n';

      // Act
      const sut = stripspace(message);

      // Assert
      expect(sut).toBe('a\nb\n');
    });
  });

  describe('Given a run of consecutive blank lines between paragraphs, When stripspace runs', () => {
    it('Then the run collapses to a single blank line', () => {
      // Arrange
      const message = 'a\n\n\nb';

      // Act
      const sut = stripspace(message);

      // Assert
      expect(sut).toBe('a\n\nb\n');
    });
  });

  describe('Given a single blank line between paragraphs, When stripspace runs', () => {
    it('Then the single blank line is preserved', () => {
      // Arrange
      const message = 'a\n\nb';

      // Act
      const sut = stripspace(message);

      // Assert
      expect(sut).toBe('a\n\nb\n');
    });
  });

  describe('Given leading blank lines, When stripspace runs', () => {
    it('Then the leading blank lines are dropped', () => {
      // Arrange
      const message = '\n\na';

      // Act
      const sut = stripspace(message);

      // Assert
      expect(sut).toBe('a\n');
    });
  });

  describe('Given trailing blank lines, When stripspace runs', () => {
    it('Then the trailing blank lines are dropped', () => {
      // Arrange
      const message = 'a\n\n';

      // Act
      const sut = stripspace(message);

      // Assert
      expect(sut).toBe('a\n');
    });
  });

  describe('Given a comment line and no comment prefix, When stripspace runs', () => {
    it('Then the comment line is preserved', () => {
      // Arrange
      const message = '#c\nreal';

      // Act
      const sut = stripspace(message);

      // Assert
      expect(sut).toBe('#c\nreal\n');
    });
  });

  describe('Given a line with internal leading whitespace, When stripspace runs', () => {
    it('Then the leading whitespace is preserved', () => {
      // Arrange
      const message = '  x';

      // Act
      const sut = stripspace(message);

      // Assert
      expect(sut).toBe('  x\n');
    });
  });

  describe('Given a message of only ASCII whitespace, When stripspace runs', () => {
    it('Then the result is empty', () => {
      // Arrange
      const message = '  \n\n  ';

      // Act
      const sut = stripspace(message);

      // Assert
      expect(sut).toBe('');
    });
  });

  describe('Given an empty string, When stripspace runs', () => {
    it('Then the result is empty', () => {
      // Arrange
      const message = '';

      // Act
      const sut = stripspace(message);

      // Assert
      expect(sut).toBe('');
    });
  });

  describe('Given an already-normalized message, When stripspace runs', () => {
    it('Then it round-trips unchanged', () => {
      // Arrange
      const message = 'a\n\nb\n';

      // Act
      const sut = stripspace(message);

      // Assert
      expect(sut).toBe('a\n\nb\n');
    });
  });

  describe('Given a message of only a non-breaking space (non-ASCII), When stripspace runs', () => {
    it('Then the non-breaking space is kept as content', () => {
      // Arrange — U+00A0 is whitespace to JS trim() but not to git's ASCII isspace
      const message = '\u00A0';

      // Act
      const sut = stripspace(message);

      // Assert
      expect(sut).toBe('\u00A0\n');
    });
  });
});

describe('subjectLine', () => {
  describe('Given a multi-line message, When subjectLine runs', () => {
    it('Then it returns the first line only', () => {
      // Arrange
      const message = 'subject\n\nbody paragraph\nmore';

      // Act
      const sut = subjectLine(message);

      // Assert
      expect(sut).toBe('subject');
    });
  });

  describe('Given a single-line message with no newline, When subjectLine runs', () => {
    it('Then it returns the message unchanged', () => {
      // Arrange
      const message = 'solo subject';

      // Act
      const sut = subjectLine(message);

      // Assert
      expect(sut).toBe('solo subject');
    });
  });

  describe('Given an empty message, When subjectLine runs', () => {
    it('Then it returns the empty string', () => {
      // Arrange
      const message = '';

      // Act
      const sut = subjectLine(message);

      // Assert
      expect(sut).toBe('');
    });
  });

  describe('Given a message starting with a newline, When subjectLine runs', () => {
    it('Then it returns the empty string (the first line is blank)', () => {
      // Arrange
      const message = '\nbody after a blank subject';

      // Act
      const sut = subjectLine(message);

      // Assert
      expect(sut).toBe('');
    });
  });

  describe('Given a message with CRLF line endings, When subjectLine runs', () => {
    it('Then the carriage return is retained (git splits on LF only)', () => {
      // Arrange
      const message = 'a\r\nb';

      // Act
      const sut = subjectLine(message);

      // Assert
      expect(sut).toBe('a\r');
    });
  });

  describe('Given a message with a single trailing newline, When subjectLine runs', () => {
    it('Then it returns the line without the trailing newline', () => {
      // Arrange
      const message = 'a\n';

      // Act
      const sut = subjectLine(message);

      // Assert
      expect(sut).toBe('a');
    });
  });
});

describe('foldSubject', () => {
  describe('Given a two-line subject, When foldSubject runs', () => {
    it('Then the lines are folded with a single space', () => {
      // Arrange
      const message = 'Fix the bug\nin the parser';

      // Act
      const result = foldSubject(message);

      // Assert
      expect(result).toBe('Fix the bug in the parser');
    });
  });

  describe('Given a subject followed by a body after a blank line, When foldSubject runs', () => {
    it('Then only the subject is returned (the body is dropped)', () => {
      // Arrange
      const message = 'subject\n\nbody paragraph\nmore';

      // Act
      const result = foldSubject(message);

      // Assert
      expect(result).toBe('subject');
    });
  });

  describe('Given a folded line with trailing spaces, When foldSubject runs', () => {
    it('Then the trailing spaces are stripped before joining', () => {
      // Arrange
      const message = 'a  \nb';

      // Act
      const result = foldSubject(message);

      // Assert
      expect(result).toBe('a b');
    });
  });

  describe('Given a continuation line with leading whitespace, When foldSubject runs', () => {
    it('Then the leading whitespace is preserved', () => {
      // Arrange
      const message = 'a\n  b';

      // Act
      const result = foldSubject(message);

      // Assert
      expect(result).toBe('a   b');
    });
  });

  describe('Given a message starting with a blank line, When foldSubject runs', () => {
    it('Then the leading blank is skipped and the following line is the subject', () => {
      // Arrange
      const message = '\nbody after a blank subject';

      // Act
      const result = foldSubject(message);

      // Assert
      expect(result).toBe('body after a blank subject');
    });
  });

  describe('Given a message starting with two blank lines, When foldSubject runs', () => {
    it('Then both leading blanks are skipped', () => {
      // Arrange
      const message = '\n\ndouble leading blank';

      // Act
      const result = foldSubject(message);

      // Assert
      expect(result).toBe('double leading blank');
    });
  });

  describe('Given a whitespace-only first line, When foldSubject runs', () => {
    it('Then it is treated as a leading blank and skipped', () => {
      // Arrange
      const message = '   \nwhitespace-only first line';

      // Act
      const result = foldSubject(message);

      // Assert
      expect(result).toBe('whitespace-only first line');
    });
  });

  describe('Given a first content line with leading whitespace, When foldSubject runs', () => {
    it('Then the content line keeps its leading whitespace', () => {
      // Arrange
      const message = '  hello\nworld';

      // Act
      const result = foldSubject(message);

      // Assert
      expect(result).toBe('  hello world');
    });
  });

  describe('Given a single line ending in a tab, When foldSubject runs', () => {
    it('Then the trailing tab is stripped', () => {
      // Arrange
      const message = 'a\t';

      // Act
      const result = foldSubject(message);

      // Assert
      expect(result).toBe('a');
    });
  });

  describe('Given a single line ending in a vertical tab, When foldSubject runs', () => {
    it('Then the trailing vertical tab is stripped', () => {
      // Arrange
      const message = 'a\v';

      // Act
      const result = foldSubject(message);

      // Assert
      expect(result).toBe('a');
    });
  });

  describe('Given a single line ending in a form feed, When foldSubject runs', () => {
    it('Then the trailing form feed is stripped', () => {
      // Arrange
      const message = 'a\f';

      // Act
      const result = foldSubject(message);

      // Assert
      expect(result).toBe('a');
    });
  });

  describe('Given a two-line subject with CRLF endings, When foldSubject runs', () => {
    it('Then the carriage returns are stripped and the lines fold with a space', () => {
      // Arrange — unlike subjectLine, %s trims the trailing CR per line
      const message = 'a\r\nb\r\n';

      // Act
      const result = foldSubject(message);

      // Assert
      expect(result).toBe('a b');
    });
  });

  describe('Given a single-line message, When foldSubject runs', () => {
    it('Then the line is returned unchanged', () => {
      // Arrange
      const message = 'solo subject';

      // Act
      const result = foldSubject(message);

      // Assert
      expect(result).toBe('solo subject');
    });
  });

  describe('Given an empty message, When foldSubject runs', () => {
    it('Then the empty string is returned', () => {
      // Arrange
      const message = '';

      // Act
      const result = foldSubject(message);

      // Assert
      expect(result).toBe('');
    });
  });

  describe('Given a line of only a non-breaking space (non-ASCII), When foldSubject runs', () => {
    it('Then the non-breaking space is kept as content', () => {
      // Arrange — U+00A0 is whitespace to JS trim() but not to git's ASCII isspace
      const message = ' ';

      // Act
      const result = foldSubject(message);

      // Assert
      expect(result).toBe(' ');
    });
  });
});
