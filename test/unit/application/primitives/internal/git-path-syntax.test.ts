import { describe, expect, it } from 'vitest';
import {
  gitPathSyntaxOf,
  posixGitPathSyntax,
  windowsGitPathSyntax,
} from '../../../../../src/application/primitives/internal/git-path-syntax.js';

describe('posixGitPathSyntax', () => {
  describe('Given a path', () => {
    describe('When isAbsolute', () => {
      it.each([
        { path: '/x/objects', expected: true },
        { path: 'x/objects', expected: false },
        { path: 'C:/x/objects', expected: false },
        { path: '\\x\\objects', expected: false },
        { path: '', expected: false },
      ])('Then $path is absolute: $expected', ({ path, expected }) => {
        // Arrange
        const sut = posixGitPathSyntax;

        // Act
        const result = sut.isAbsolute(path);

        // Assert
        expect(result).toBe(expected);
      });
    });

    describe('When splitRoot', () => {
      it.each([
        { path: '/x/objects', expected: { root: '/', rest: 'x/objects' } },
        { path: '//x', expected: { root: '/', rest: '/x' } },
        { path: 'x/objects', expected: { root: '', rest: 'x/objects' } },
        { path: 'C:\\x', expected: { root: '', rest: 'C:\\x' } },
      ])('Then $path splits to $expected', ({ path, expected }) => {
        // Arrange
        const sut = posixGitPathSyntax;

        // Act
        const result = sut.splitRoot(path);

        // Assert
        expect(result).toEqual(expected);
      });
    });

    describe('When components', () => {
      it.each([
        { path: 'a//b/', expected: ['a', 'b', ''] },
        { path: 'a\\b/c', expected: ['a\\b', 'c'] },
        { path: '//a', expected: ['a'] },
        { path: '/', expected: [''] },
        { path: '', expected: [] },
      ])('Then $path yields $expected', ({ path, expected }) => {
        // Arrange
        const sut = posixGitPathSyntax;

        // Act
        const result = sut.components(path);

        // Assert
        expect(result).toEqual(expected);
      });
    });
    describe('When isSeparator', () => {
      it.each([
        { char: '/', expected: true },
        { char: '\\', expected: false },
        { char: undefined, expected: false },
      ])('Then $char is a separator: $expected', ({ char, expected }) => {
        // Arrange
        const sut = posixGitPathSyntax;

        // Act
        const result = sut.isSeparator(char);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });
});

describe('windowsGitPathSyntax', () => {
  describe('Given a path', () => {
    describe('When isAbsolute', () => {
      it.each([
        { path: 'C:/x', expected: true },
        { path: 'c:\\x', expected: true },
        { path: 'C:x', expected: true },
        { path: '1:x', expected: true },
        { path: '\\x', expected: true },
        { path: '/x', expected: true },
        { path: '\\\\server\\share\\x', expected: true },
        { path: 'é:x', expected: true },
        { path: '😀:x', expected: true },
        { path: 'éé:x', expected: true },
        { path: 'é€:x', expected: false },
        { path: 'é', expected: false },
        { path: 'x/objects', expected: false },
        { path: 'C', expected: false },
        { path: '', expected: false },
      ])('Then $path is absolute: $expected', ({ path, expected }) => {
        // Arrange
        const sut = windowsGitPathSyntax;

        // Act
        const result = sut.isAbsolute(path);

        // Assert
        expect(result).toBe(expected);
      });
    });

    describe('When splitRoot', () => {
      it.each([
        { path: 'C:\\x\\objects', expected: { root: 'C:/', rest: 'x\\objects' } },
        { path: 'C:/x', expected: { root: 'C:/', rest: 'x' } },
        { path: 'C:x', expected: { root: 'C:', rest: 'x' } },
        { path: 'é:\\x', expected: { root: 'é:/', rest: 'x' } },
        { path: '\\x', expected: { root: '/', rest: 'x' } },
        { path: '/x', expected: { root: '/', rest: 'x' } },
        { path: '\\\\server\\share\\x', expected: { root: '//server/share/', rest: 'x' } },
        { path: '//server/share/x', expected: { root: '//server/share/', rest: 'x' } },
        { path: '\\\\server\\share', expected: { root: '//server/share', rest: '' } },
        { path: '\\\\server/\\x', expected: { root: '//server//', rest: 'x' } },
        { path: '\\\\?\\C:\\x', expected: { root: '//?/C:/', rest: 'x' } },
        { path: '\\\\server', expected: { root: '', rest: '\\\\server' } },
        { path: 'x\\y', expected: { root: '', rest: 'x\\y' } },
      ])('Then $path splits to $expected', ({ path, expected }) => {
        // Arrange
        const sut = windowsGitPathSyntax;

        // Act
        const result = sut.splitRoot(path);

        // Assert
        expect(result).toEqual(expected);
      });
    });

    describe('When components', () => {
      it.each([
        { path: 'a\\\\b/c\\', expected: ['a', 'b', 'c', ''] },
        { path: 'a\\b', expected: ['a', 'b'] },
        { path: '', expected: [] },
      ])('Then $path yields $expected', ({ path, expected }) => {
        // Arrange
        const sut = windowsGitPathSyntax;

        // Act
        const result = sut.components(path);

        // Assert
        expect(result).toEqual(expected);
      });
    });
    describe('When isSeparator', () => {
      it.each([
        { char: '/', expected: true },
        { char: '\\', expected: true },
        { char: ':', expected: false },
        { char: undefined, expected: false },
      ])('Then $char is a separator: $expected', ({ char, expected }) => {
        // Arrange
        const sut = windowsGitPathSyntax;

        // Act
        const result = sut.isSeparator(char);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });
});

describe('gitPathSyntaxOf', () => {
  describe.each([
    {
      title: 'a host declaring Windows syntax',
      host: { windowsPathSyntax: true },
      expected: windowsGitPathSyntax,
    },
    {
      title: 'a host declaring POSIX syntax',
      host: { windowsPathSyntax: false },
      expected: posixGitPathSyntax,
    },
    { title: 'a host declaring nothing', host: {}, expected: posixGitPathSyntax },
  ])('Given $title', ({ host, expected }) => {
    describe('When its git path syntax is chosen', () => {
      it('Then it is the syntax of the git build the host emulates', () => {
        // Arrange
        const sut = gitPathSyntaxOf;

        // Act
        const result = sut(host);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });
});
