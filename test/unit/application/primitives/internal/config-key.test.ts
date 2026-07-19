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
  describe('Given a sections array with two matches under [user]', () => {
    describe('When collectValues runs for user.email', () => {
      it('Then returns both values in physical order', () => {
        // Arrange
        const sections = [
          section('user', undefined, [
            { key: 'email', value: 'a@x' },
            { key: 'other', value: 'ignored' },
            { key: 'email', value: 'b@y' },
          ]),
        ];

        // Act
        const sut = collectValues(sections, {
          section: 'user',
          subsection: undefined,
          name: 'email',
        });

        // Assert
        expect(sut).toEqual([{ value: 'a@x' }, { value: 'b@y' }]);
      });
    });
  });

  describe('Given a case-mismatched section header [USER]', () => {
    describe('When collectValues runs for user.email', () => {
      it('Then still matches (case-insensitive section lookup)', () => {
        // Arrange
        const sections = [section('USER', undefined, [{ key: 'email', value: 'x' }])];

        // Act
        const sut = collectValues(sections, {
          section: 'user',
          subsection: undefined,
          name: 'email',
        });

        // Assert
        expect(sut).toEqual([{ value: 'x' }]);
      });
    });
  });

  describe('Given a subsection mismatch', () => {
    describe('When collectValues runs', () => {
      it('Then returns empty', () => {
        // Arrange
        const sections = [section('remote', 'origin', [{ key: 'url', value: 'x' }])];

        // Act
        const sut = collectValues(sections, {
          section: 'remote',
          subsection: 'upstream',
          name: 'url',
        });

        // Assert
        expect(sut).toEqual([]);
      });
    });
  });

  describe('Given a section-name mismatch, both without subsection', () => {
    describe('When collectValues runs', () => {
      it('Then returns empty because the section names differ', () => {
        // Arrange
        const sections = [section('foo', undefined, [{ key: 'name', value: 'leak' }])];

        // Act
        const sut = collectValues(sections, {
          section: 'bar',
          subsection: undefined,
          name: 'name',
        });

        // Assert
        expect(sut).toEqual([]);
      });
    });
  });
});

describe('collectScopedValues', () => {
  describe('Given matches in two scopes', () => {
    describe('When collectScopedValues runs', () => {
      it('Then returns matches tagged with their scope in caller order', () => {
        // Arrange
        const input = [
          {
            scope: 'global' as const,
            section: section('user', undefined, [{ key: 'name', value: 'g' }]),
          },
          {
            scope: 'local' as const,
            section: section('user', undefined, [{ key: 'name', value: 'l' }]),
          },
        ];

        // Act
        const sut = collectScopedValues(input, {
          section: 'user',
          subsection: undefined,
          name: 'name',
        });

        // Assert
        expect(sut).toEqual([
          { value: 'g', scope: 'global' },
          { value: 'l', scope: 'local' },
        ]);
      });
    });
  });

  describe('Given a scoped section whose header does not match', () => {
    describe('When collectScopedValues runs', () => {
      it('Then skips the section and returns empty', () => {
        // Arrange
        const input = [
          {
            scope: 'local' as const,
            section: section('other', undefined, [{ key: 'name', value: 'leak' }]),
          },
        ];

        // Act
        const sut = collectScopedValues(input, {
          section: 'user',
          subsection: undefined,
          name: 'name',
        });

        // Assert
        expect(sut).toEqual([]);
      });
    });
  });

  describe('Given a matching scoped section with an extra non-matching entry', () => {
    describe('When collectScopedValues runs', () => {
      it('Then returns only the entry whose key matches', () => {
        // Arrange
        const input = [
          {
            scope: 'local' as const,
            section: section('user', undefined, [
              { key: 'name', value: 'n' },
              { key: 'email', value: 'e' },
            ]),
          },
        ];

        // Act
        const sut = collectScopedValues(input, {
          section: 'user',
          subsection: undefined,
          name: 'name',
        });

        // Assert
        expect(sut).toEqual([{ value: 'n', scope: 'local' }]);
      });
    });
  });
});
