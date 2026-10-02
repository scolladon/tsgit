import { describe, expect, it } from 'vitest';
import { formatSanitizedSubject, formatSubject } from '../../../../src/domain/pretty/subject.js';

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

describe('formatSubject', () => {
  describe.each([
    ['a single line', 'msg subject line', 'msg subject line'],
    ['a single line with its line feed', 'msg subject line\n', 'msg subject line'],
    ['a multi-line paragraph', 'msg\nsubject\nline\n', 'msg subject line'],
    ['trailing whitespace on each line', 'msg \t\nsubject  \nline\r\n', 'msg subject line'],
    ['leading whitespace', '  msg\n  subject\n', '  msg   subject'],
    ['no bytes', '', ''],
  ])('Given %s, When formatting', (_title, raw, expected) => {
    it(`Then it yields "${expected}"`, () => {
      // Arrange
      const sut = formatSubject;

      // Act
      const result = sut(encode(raw));

      // Assert
      expect(decode(result)).toBe(expected);
    });
  });
});

describe('formatSanitizedSubject', () => {
  describe.each([
    ['plain words', 'msg subject line', 'msg-subject-line'],
    ['a multi-line paragraph', 'msg\nsubject\n', 'msg-subject'],
    ['runs of specials', 'a  ,;:b', 'a-b'],
    ['leading specials', '  !!a', 'a'],
    ['trailing specials', 'a!! ', 'a'],
    ['a trailing dot', 'fix.', 'fix'],
    ['a trailing dash from a special run', 'fix -', 'fix'],
    ['a run of dots', 'a...b', 'a.b'],
    ['a dot followed by a special', 'a. b', 'a.-b'],
    ['underscores and digits', 'v_1.2', 'v_1.2'],
    ['non-ASCII bytes', 'café x', 'caf-x'],
    ['only specials', ' !! ', ''],
  ])('Given %s, When formatting', (_title, raw, expected) => {
    it(`Then it yields "${expected}"`, () => {
      // Arrange
      const sut = formatSanitizedSubject;

      // Act
      const result = sut(encode(raw));

      // Assert
      expect(decode(result)).toBe(expected);
    });
  });
});
