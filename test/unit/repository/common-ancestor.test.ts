import { describe, expect, it } from 'vitest';
import { posixPolicy, windowsPolicy } from '../../../src/adapters/node/path-policy.js';
import { commonAncestor } from '../../../src/repository/common-ancestor.js';

describe('commonAncestor', () => {
  describe('Given a family of representative path scenarios', () => {
    describe('When commonAncestor runs', () => {
      it.each([
        {
          label: 'a path and a sibling (POSIX) resolves to the shared parent',
          paths: ['/tmp/repo', '/tmp/repo-wt'],
          policy: posixPolicy,
          expected: '/tmp',
        },
        {
          label: 'a path and its descendant (POSIX) resolves to the ancestor itself',
          paths: ['/a/b', '/a/b/c/d'],
          policy: posixPolicy,
          expected: '/a/b',
        },
        {
          label: 'paths sharing no prefix (POSIX) resolve to the root',
          paths: ['/a/x', '/b/y'],
          policy: posixPolicy,
          expected: '/',
        },
        {
          label: 'a single path (POSIX) resolves to that path',
          paths: ['/a/b/c'],
          policy: posixPolicy,
          expected: '/a/b/c',
        },
        {
          label: 'no paths (POSIX) resolve to the root',
          paths: [],
          policy: posixPolicy,
          expected: '/',
        },
        {
          label: 'a Windows drive path and a sibling resolve to the shared drive parent',
          paths: ['C:\\repo', 'C:\\repo\\wt'],
          policy: windowsPolicy,
          expected: 'C:\\repo',
        },
        {
          label: 'two Windows paths sharing a deeper common directory resolve to that directory',
          paths: ['C:\\Users\\me\\repo', 'C:\\Users\\me\\feature'],
          policy: windowsPolicy,
          expected: 'C:\\Users\\me',
        },
        {
          label: 'a Windows path and its descendant resolve to the ancestor itself',
          paths: ['C:\\a\\b', 'C:\\a\\b\\c\\d'],
          policy: windowsPolicy,
          expected: 'C:\\a\\b',
        },
        {
          label:
            'a Windows descendant listed before its ancestor resolves without throwing on the shorter path',
          paths: ['C:\\a\\b\\c', 'C:\\a\\b'],
          policy: windowsPolicy,
          expected: 'C:\\a\\b',
        },
        {
          label:
            'two Windows paths differing only by case compare case-insensitively and emit the first casing',
          paths: ['C:\\Repo', 'c:\\repo\\wt'],
          policy: windowsPolicy,
          expected: 'C:\\Repo',
        },
        {
          label:
            'Windows paths mixing forward and backward slashes resolve both to native separators before comparing',
          paths: ['C:/Users/me/repo', 'C:\\Users\\me\\repo\\wt'],
          policy: windowsPolicy,
          expected: 'C:\\Users\\me\\repo',
        },
        {
          label: 'Windows paths on different drives resolve to the first input, not the drive root',
          paths: ['C:\\a', 'D:\\b'],
          policy: windowsPolicy,
          expected: 'C:\\a',
        },
        {
          label: 'UNC paths on the same share resolve to the shared UNC directory',
          paths: ['\\\\srv\\share\\repo', '\\\\srv\\share\\repo\\wt'],
          policy: windowsPolicy,
          expected: '\\\\srv\\share\\repo',
        },
        {
          label: 'a single Windows path resolves to that path unchanged',
          paths: ['C:\\a\\b\\c'],
          policy: windowsPolicy,
          expected: 'C:\\a\\b\\c',
        },
        {
          label: 'no paths and a Windows policy resolve to the Windows separator',
          paths: [],
          policy: windowsPolicy,
          expected: '\\',
        },
        {
          label: 'UNC paths on different shares resolve to the first input, not the server root',
          paths: ['\\\\srv\\a\\x', '\\\\srv\\b\\y'],
          policy: windowsPolicy,
          expected: '\\\\srv\\a\\x',
        },
      ])('Then $label', ({ paths, policy, expected }) => {
        // Arrange & Act
        const result = commonAncestor(paths, policy);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });
});
