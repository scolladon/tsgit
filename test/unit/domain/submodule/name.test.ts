import { describe, expect, it } from 'vitest';

import { isUnsafeSubmoduleName } from '../../../../src/domain/submodule/name.js';

describe('Given a .gitmodules subsection name', () => {
  describe('When the name is unsafe', () => {
    it.each([
      ['empty', ''],
      ['dot segment', '.'],
      ['double-dot segment', '..'],
      ['nested double-dot', 'a/../b'],
      ['nested dot', 'a/./b'],
      ['empty segment (trailing slash)', 'foo/'],
      ['empty segment (double slash)', 'foo//bar'],
      ['backslash', 'a\\b'],
      ['leading slash (POSIX absolute)', '/foo'],
      ['drive-letter prefix', 'C:/foo'],
      ['leading dash (option-like)', '-flag'],
      ['NUL byte', `a${String.fromCharCode(0)}b`],
      ['tab control char', 'a\tb'],
      [
        'unit-separator (0x1f) — boundary of the control-char range',
        `a${String.fromCharCode(0x1f)}b`,
      ],
      ['DEL control char', `a${String.fromCharCode(127)}b`],
    ])('Then %s returns true', (_label, name) => {
      // Arrange + Act
      const sut = isUnsafeSubmoduleName(name);
      // Assert
      expect(sut).toBe(true);
    });
  });

  describe('When the name is a plain name', () => {
    it('Then it is accepted', () => {
      // Arrange + Act
      const sut = isUnsafeSubmoduleName('libfoo');
      // Assert
      expect(sut).toBe(false);
    });
  });

  describe('When the name carries a slash (legitimate for nested module dirs)', () => {
    it('Then it is accepted', () => {
      // Arrange + Act
      const sut = isUnsafeSubmoduleName('libs/foo');
      // Assert
      expect(sut).toBe(false);
    });
  });
});
