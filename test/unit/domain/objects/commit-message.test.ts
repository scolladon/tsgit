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

  describe('Given a line ending in trailing ASCII whitespace, When stripspace runs', () => {
    it.each([
      { message: 'a  ', expected: 'a\n', label: 'trailing spaces are stripped' },
      { message: 'a\t', expected: 'a\n', label: 'a trailing tab is stripped' },
      { message: 'a\v', expected: 'a\n', label: 'a trailing vertical tab is stripped' },
      { message: 'a\f', expected: 'a\n', label: 'a trailing form feed is stripped' },
      {
        message: 'a\r\nb\r\n',
        expected: 'a\nb\n',
        label: 'trailing carriage returns are stripped, leaving LF',
      },
    ])('Then $label', ({ message, expected }) => {
      // Arrange & Act
      const sut = stripspace(message);

      // Assert
      expect(sut).toBe(expected);
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
  describe('Given a message, When subjectLine runs', () => {
    it.each([
      {
        message: 'subject\n\nbody paragraph\nmore',
        expected: 'subject',
        label: 'a multi-line message returns the first line only',
      },
      {
        message: 'solo subject',
        expected: 'solo subject',
        label: 'a single-line message with no newline is returned unchanged',
      },
      { message: '', expected: '', label: 'an empty message returns the empty string' },
      {
        message: '\nbody after a blank subject',
        expected: '',
        label:
          'a message starting with a newline returns the empty string (the first line is blank)',
      },
      {
        message: 'a\r\nb',
        expected: 'a\r',
        label: 'CRLF line endings retain the carriage return (git splits on LF only)',
      },
      {
        message: 'a\n',
        expected: 'a',
        label: 'a single trailing newline is not part of the returned line',
      },
    ])('Then $label', ({ message, expected }) => {
      // Arrange & Act
      const sut = subjectLine(message);

      // Assert
      expect(sut).toBe(expected);
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

  describe('Given a message with a skippable leading blank (or whitespace-only) line, When foldSubject runs', () => {
    it.each([
      {
        message: '\nbody after a blank subject',
        expected: 'body after a blank subject',
        label: 'a single leading blank line is skipped',
      },
      {
        message: '\n\ndouble leading blank',
        expected: 'double leading blank',
        label: 'two leading blank lines are both skipped',
      },
      {
        message: '   \nwhitespace-only first line',
        expected: 'whitespace-only first line',
        label: 'a whitespace-only first line is treated as a leading blank and skipped',
      },
    ])('Then $label', ({ message, expected }) => {
      // Arrange & Act
      const result = foldSubject(message);

      // Assert
      expect(result).toBe(expected);
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

  describe('Given a single line ending in trailing ASCII whitespace, When foldSubject runs', () => {
    it.each([
      { message: 'a\t', label: 'a trailing tab is stripped' },
      { message: 'a\v', label: 'a trailing vertical tab is stripped' },
      { message: 'a\f', label: 'a trailing form feed is stripped' },
    ])('Then $label', ({ message }) => {
      // Arrange & Act
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
