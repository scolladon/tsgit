import { describe, expect, it } from 'vitest';

import { parseGitmodules } from '../../../../src/application/primitives/parse-gitmodules.js';
import { TsgitError } from '../../../../src/domain/error.js';

describe('Given .gitmodules text', () => {
  describe('When it holds one submodule section', () => {
    it('Then the row carries name/path/url', () => {
      // Arrange
      const text = '[submodule "libs/a"]\n\tpath = libs/a\n\turl = ../a\n';
      // Act
      const result = parseGitmodules(text);
      // Assert
      expect(result).toEqual([{ name: 'libs/a', path: 'libs/a', url: '../a' }]);
    });
  });

  describe('When keys vary in case and update/branch are present', () => {
    it('Then keys are read case-insensitively and update/branch surface', () => {
      // Arrange
      const text = '[submodule "x"]\n\tPath = p\n\tURL = u\n\tUpdate = rebase\n\tBranch = main\n';
      // Act
      const result = parseGitmodules(text);
      // Assert
      expect(result).toEqual([
        { name: 'x', path: 'p', url: 'u', update: 'rebase', branch: 'main' },
      ]);
    });
  });

  describe('When multiple sections appear', () => {
    it('Then rows preserve file order', () => {
      // Arrange
      const text = '[submodule "b"]\n\tpath = b\n[submodule "a"]\n\tpath = a\n';
      // Act
      const result = parseGitmodules(text);
      // Assert
      expect(result.map((r) => r.name)).toEqual(['b', 'a']);
    });
  });

  describe('When a section name is unsafe', () => {
    it('Then the row is dropped', () => {
      // Arrange
      const text = '[submodule "../evil"]\n\tpath = e\n\turl = u\n[submodule "ok"]\n\tpath = o\n';
      // Act
      const result = parseGitmodules(text);
      // Assert
      expect(result.map((r) => r.name)).toEqual(['ok']);
    });
  });

  describe('When a non-submodule section appears', () => {
    it('Then it is ignored', () => {
      // Arrange
      const text = '[core]\n\tbare = false\n[submodule "a"]\n\tpath = a\n';
      // Act
      const result = parseGitmodules(text);
      // Assert
      expect(result.map((r) => r.name)).toEqual(['a']);
    });
  });

  describe('When a submodule section has no subsection name', () => {
    it('Then it is ignored', () => {
      // Arrange
      const text = '[submodule]\n\tpath = a\n';
      // Act
      const result = parseGitmodules(text);
      // Assert
      expect(result).toEqual([]);
    });
  });

  describe('When a non-submodule section carries a safe subsection name', () => {
    it('Then it is dropped rather than parsed as a submodule row', () => {
      // Arrange — the section guard, not the subsection/name guards, must reject
      // this: `[branch "main"]` has a defined, safe subsection, so only the
      // `section !== 'submodule'` check keeps it out of the rows.
      const text = '[branch "main"]\n\tpath = p\n[submodule "a"]\n\tpath = a\n';
      // Act
      const result = parseGitmodules(text);
      // Assert
      expect(result.map((r) => r.name)).toEqual(['a']);
    });
  });

  describe('When the text is malformed', () => {
    it('Then the parse error is labelled with the .gitmodules source', () => {
      // Arrange — a config line starting with a digit is not a valid key head.
      const text = '9bad\n';
      // Act
      let caught: unknown;
      try {
        parseGitmodules(text);
        expect.unreachable();
      } catch (err) {
        caught = err;
      }
      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      const data = (caught as TsgitError).data;
      expect(data.code).toBe('CONFIG_PARSE_ERROR');
      if (data.code === 'CONFIG_PARSE_ERROR') {
        expect(data.source).toBe('.gitmodules');
      }
    });
  });
});
