import { describe, expect, it } from 'vitest';
import { splitCmdline } from '../../../../src/domain/config/split-cmdline.js';

describe('splitCmdline', () => {
  describe.each([
    ['words split on whitespace runs', '--no-ff  -X\tours', ['--no-ff', '-X', 'ours']],
    ['every whitespace git skips', 'a\nb\rc', ['a', 'b', 'c']],
    ['a vertical tab and a form feed', 'a\vb\fc', ['a\vb\fc']],
    ['single quotes keeping spaces and backslashes', "-m 'a b\\c'", ['-m', 'a b\\c']],
    ['double quotes with escapes', '-m "a \\"b\\" \\\\"', ['-m', 'a "b" \\']],
    ['quoted and bare segments joined', `a'b c'"d"e`, ['ab cde']],
    ['a backslash escaping a space', 'a\\ b', ['a b']],
    ['an empty quoted word', "-m ''", ['-m', '']],
    ['an empty string', '', ['']],
    ['leading whitespace', ' a', ['', 'a']],
    ['trailing whitespace', 'a ', ['a', '']],
    ['the other quote inside quotes', `"it's" 'say "hi"'`, ["it's", 'say "hi"']],
  ])('Given %s', (_, cmdline, argv) => {
    describe('When split', () => {
      it('Then it yields the words git does', () => {
        // Arrange
        const sut = splitCmdline;

        // Act
        const result = sut(cmdline);

        // Assert
        expect(result).toEqual({ kind: 'argv', argv });
      });
    });
  });

  describe.each([
    ['an unclosed single quote', "-m 'a", 'unclosed quote'],
    ['an unclosed double quote', '-m "a', 'unclosed quote'],
    ['a trailing backslash', 'a\\', 'cmdline ends with \\'],
    ['a trailing backslash inside double quotes', '"a\\', 'cmdline ends with \\'],
  ])('Given %s', (_, cmdline, reason) => {
    describe('When split', () => {
      it('Then it reports why git refuses it', () => {
        // Arrange
        const sut = splitCmdline;

        // Act
        const result = sut(cmdline);

        // Assert
        expect(result).toEqual({ kind: 'error', reason });
      });
    });
  });
});
