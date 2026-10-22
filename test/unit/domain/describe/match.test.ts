import { describe, expect, it } from 'vitest';
import { tagNameMatches } from '../../../../src/domain/describe/match.js';

describe('tagNameMatches', () => {
  describe('Given a name and include/exclude patterns', () => {
    describe('When matching', () => {
      it.each([
        {
          name: 'v1.0',
          include: [],
          exclude: [],
          expected: true,
          label: 'no patterns includes the name (identity)',
        },
        {
          name: 'v1.0',
          include: ['v*'],
          exclude: [],
          expected: true,
          label: 'a matching include is included',
        },
        {
          name: 'rc-1',
          include: ['v*'],
          exclude: [],
          expected: false,
          label: 'a non-matching include is excluded',
        },
        {
          name: 'rc-1',
          include: [],
          exclude: ['rc*'],
          expected: false,
          label: 'a matching exclude drops it even with no include patterns',
        },
        {
          name: 'v1-rc',
          include: ['v*'],
          exclude: ['*rc'],
          expected: false,
          label: 'exclusion wins when both include and exclude match',
        },
        {
          name: 'release/v1',
          include: ['release*'],
          exclude: [],
          expected: true,
          label: '* crosses the slash',
        },
        {
          name: 'sub/v1.0',
          include: ['v1.0'],
          exclude: [],
          expected: false,
          label: 'the match is anchored at the start (no unanchored suffix match)',
        },
        {
          name: 'v1.0',
          include: ['v*', 'x*'],
          exclude: [],
          expected: true,
          label: 'any single include match includes the name (some, not every)',
        },
        {
          name: 'v1.0',
          include: ['v[0-9].*'],
          exclude: [],
          expected: true,
          label: 'a bracket expression matches a character class',
        },
        {
          name: 'v1/rc1',
          include: ['v1?rc1'],
          exclude: [],
          expected: true,
          label: '? crosses the slash',
        },
        {
          name: 'v1.0',
          include: ['v1\\.*'],
          exclude: [],
          expected: true,
          label: 'a backslash escapes the dot',
        },
        {
          name: 'v1/rc1',
          include: ['v1\\/*'],
          exclude: [],
          expected: true,
          label: 'a backslash escapes the slash',
        },
        {
          name: 'v1.0',
          include: ['[v]1.0'],
          exclude: [],
          expected: true,
          label: 'a leading bracket expression matches',
        },
        {
          name: 'v1.0',
          include: ['v1['],
          exclude: [],
          expected: false,
          label: 'an unterminated bracket matches nothing',
        },
        {
          name: 'v1.0',
          include: ['v1\\'],
          exclude: [],
          expected: false,
          label: 'a trailing backslash matches nothing',
        },
      ])('Then $label', ({ name, include, exclude, expected }) => {
        // Arrange + Act
        const result = tagNameMatches(name, include, exclude);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });
});
