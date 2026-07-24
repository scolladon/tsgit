import { describe, expect, it } from 'vitest';
import type { IniSection } from '../../../../../src/application/primitives/config-read.js';
import {
  collectScopedValues,
  collectValues,
  qualifyKey,
} from '../../../../../src/application/primitives/internal/config-key.js';

const section = (
  s: string,
  sub: string | undefined,
  entries: ReadonlyArray<{ key: string; value: string }>,
): IniSection => ({ section: s, subsection: sub, entries });

describe('qualifyKey', () => {
  describe('Given a section without subsection', () => {
    describe('When qualifyKey runs', () => {
      it('Then returns "<section>.<name>" with both lower-cased', () => {
        // Arrange
        const sut = qualifyKey(section('User', undefined, []), 'Name');

        // Assert
        expect(sut).toBe('user.name');
      });
    });
  });

  describe('Given a section with subsection "My.Fork"', () => {
    describe('When qualifyKey runs', () => {
      it('Then preserves subsection case while lower-casing section and name', () => {
        // Arrange
        const sut = qualifyKey(section('Remote', 'My.Fork', []), 'URL');

        // Assert
        expect(sut).toBe('remote.My.Fork.url');
      });
    });
  });
});

describe('collectValues', () => {
  describe('Given a sections array and a qualified key to look up', () => {
    describe('When collectValues runs', () => {
      it.each([
        {
          label: 'two matches under [user]: returns both values in physical order',
          sections: [
            section('user', undefined, [
              { key: 'email', value: 'a@x' },
              { key: 'other', value: 'ignored' },
              { key: 'email', value: 'b@y' },
            ]),
          ],
          parsed: { section: 'user', subsection: undefined, name: 'email' },
          expected: [{ value: 'a@x' }, { value: 'b@y' }],
        },
        {
          label: 'a case-mismatched section header [USER]: still matches',
          sections: [section('USER', undefined, [{ key: 'email', value: 'x' }])],
          parsed: { section: 'user', subsection: undefined, name: 'email' },
          expected: [{ value: 'x' }],
        },
        {
          label: 'a subsection mismatch: returns empty',
          sections: [section('remote', 'origin', [{ key: 'url', value: 'x' }])],
          parsed: { section: 'remote', subsection: 'upstream', name: 'url' },
          expected: [],
        },
        {
          label: 'a section-name mismatch, both without subsection: returns empty',
          sections: [section('foo', undefined, [{ key: 'name', value: 'leak' }])],
          parsed: { section: 'bar', subsection: undefined, name: 'name' },
          expected: [],
        },
      ])('Then $label', ({ sections, parsed, expected }) => {
        // Arrange
        const sut = collectValues;

        // Act
        const result = sut(sections, parsed);

        // Assert
        expect(result).toEqual(expected);
      });
    });
  });
});

describe('collectScopedValues', () => {
  describe('Given a scope-tagged sections array and a qualified key to look up', () => {
    describe('When collectScopedValues runs', () => {
      it.each([
        {
          label: 'matches in two scopes: returns matches tagged with their scope in caller order',
          input: [
            {
              scope: 'global' as const,
              section: section('user', undefined, [{ key: 'name', value: 'g' }]),
            },
            {
              scope: 'local' as const,
              section: section('user', undefined, [{ key: 'name', value: 'l' }]),
            },
          ],
          expected: [
            { value: 'g', scope: 'global' },
            { value: 'l', scope: 'local' },
          ],
        },
        {
          label: 'a scoped section whose header does not match: skips the section, returns empty',
          input: [
            {
              scope: 'local' as const,
              section: section('other', undefined, [{ key: 'name', value: 'leak' }]),
            },
          ],
          expected: [],
        },
        {
          label:
            'a matching scoped section with an extra non-matching entry: returns only the matching key',
          input: [
            {
              scope: 'local' as const,
              section: section('user', undefined, [
                { key: 'name', value: 'n' },
                { key: 'email', value: 'e' },
              ]),
            },
          ],
          expected: [{ value: 'n', scope: 'local' }],
        },
      ])('Then $label', ({ input, expected }) => {
        // Arrange
        const sut = collectScopedValues;
        const parsed = { section: 'user', subsection: undefined, name: 'name' };

        // Act
        const result = sut(input, parsed);

        // Assert
        expect(result).toEqual(expected);
      });
    });
  });
});
