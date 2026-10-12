import { describe, expect, it } from 'vitest';
import { isExcludedByNegativeRefspec } from '../../../../../src/application/commands/internal/negative-refspec.js';

const ORIGIN_HEADS = '+refs/heads/*:refs/remotes/origin/*';

describe('isExcludedByNegativeRefspec', () => {
  describe.each([
    {
      label: 'an exact negative naming the source the pattern maps back to',
      specs: [ORIGIN_HEADS, '^refs/heads/main'],
      ref: 'refs/remotes/origin/main',
      expected: true,
    },
    {
      label: 'an exact negative naming another source',
      specs: [ORIGIN_HEADS, '^refs/heads/main'],
      ref: 'refs/remotes/origin/z',
      expected: false,
    },
    {
      label: 'a pattern negative covering the source',
      specs: [ORIGIN_HEADS, '^refs/heads/m*'],
      ref: 'refs/remotes/origin/main',
      expected: true,
    },
    {
      label: 'a pattern negative whose suffix the source lacks',
      specs: [ORIGIN_HEADS, '^refs/heads/*-wip'],
      ref: 'refs/remotes/origin/main',
      expected: false,
    },
    {
      label: 'two positive refspecs of which only one maps the ref back to the negated source',
      specs: [ORIGIN_HEADS, '+refs/tags/*:refs/remotes/origin/*', '^refs/heads/main'],
      ref: 'refs/remotes/origin/main',
      expected: true,
    },
    {
      label: 'a negative but no positive refspec mapping the ref back',
      specs: ['+refs/heads/*:refs/remotes/other/*', '^refs/heads/main'],
      ref: 'refs/remotes/origin/main',
      expected: false,
    },
    {
      label: 'a positive pattern whose prefix and suffix would overlap the ref',
      specs: ['+refs/heads/*:refs/remotes/o/a*a', '^refs/heads/*'],
      ref: 'refs/remotes/o/a',
      expected: false,
    },
    {
      label: 'a positive pattern carrying a suffix',
      specs: ['+refs/heads/*-x:refs/remotes/o/*-y', '^refs/heads/main-x'],
      ref: 'refs/remotes/o/main-y',
      expected: true,
    },
    {
      label: 'an exact positive refspec compared on its source, as git compares it',
      specs: ['+refs/heads/main:refs/remotes/origin/main', '^refs/heads/main'],
      ref: 'refs/heads/main',
      expected: true,
    },
    {
      label: 'an exact positive refspec whose source is not the ref',
      specs: ['+refs/heads/main:refs/remotes/origin/main', '^refs/heads/main'],
      ref: 'refs/remotes/origin/main',
      expected: false,
    },
    {
      label: 'the matching refspec standing for any ref',
      specs: [':', '^refs/remotes/origin/main'],
      ref: 'refs/remotes/origin/main',
      expected: true,
    },
    {
      label: 'a source-only positive refspec',
      specs: ['refs/heads/main', '^refs/heads/main'],
      ref: 'refs/heads/main',
      expected: true,
    },
    {
      label: 'a positive pattern whose prefix and suffix exactly fill the ref',
      specs: ['+refs/heads/*:refs/remotes/o/a*a', '^refs/heads/'],
      ref: 'refs/remotes/o/aa',
      expected: true,
    },
    {
      label: 'a positive refspec with an empty source but a destination',
      specs: [':refs/remotes/origin/main', '^refs/remotes/origin/main'],
      ref: 'refs/remotes/origin/main',
      expected: false,
    },
    {
      label: 'a source-only positive pattern',
      specs: ['refs/heads/*', '^refs/heads/main'],
      ref: 'refs/heads/main',
      expected: true,
    },
    {
      label: 'no negative refspec at all',
      specs: [ORIGIN_HEADS],
      ref: 'refs/remotes/origin/main',
      expected: false,
    },
  ])('Given $label', ({ specs, ref, expected }) => {
    describe('When the ref is checked', () => {
      it(`Then it answers ${expected}`, () => {
        // Arrange
        const sut = isExcludedByNegativeRefspec;

        // Act
        const result = sut(specs, ref);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });
});
