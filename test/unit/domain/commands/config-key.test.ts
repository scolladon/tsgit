import { describe, expect, it } from 'vitest';

import { parseConfigKey } from '../../../../src/domain/commands/config-key.js';
import { TsgitError } from '../../../../src/domain/error.js';

describe('parseConfigKey', () => {
  describe('Given a two-part key user.name', () => {
    describe('When parsed', () => {
      it('Then section is "user", subsection is undefined, name is "name"', () => {
        // Arrange + Act
        const sut = parseConfigKey('user.name');

        // Assert
        expect(sut.section).toBe('user');
        expect(sut.subsection).toBeUndefined();
        expect(sut.name).toBe('name');
      });
    });
  });

  describe('Given an upper-case two-part key USER.NAME', () => {
    describe('When parsed', () => {
      it('Then section and name are lower-cased', () => {
        // Arrange + Act
        const sut = parseConfigKey('USER.NAME');

        // Assert
        expect(sut.section).toBe('user');
        expect(sut.name).toBe('name');
      });
    });
  });

  describe('Given a three-part key remote.origin.url', () => {
    describe('When parsed', () => {
      it('Then subsection is "origin" (the slice between first and last dot)', () => {
        // Arrange + Act
        const sut = parseConfigKey('remote.origin.url');

        // Assert
        expect(sut.section).toBe('remote');
        expect(sut.subsection).toBe('origin');
        expect(sut.name).toBe('url');
      });
    });
  });

  describe('Given a multi-dot subsection remote.my.fork.url', () => {
    describe('When parsed', () => {
      it('Then subsection is "my.fork" (everything between first and last dot)', () => {
        // Arrange + Act
        const sut = parseConfigKey('remote.my.fork.url');

        // Assert
        expect(sut.section).toBe('remote');
        expect(sut.subsection).toBe('my.fork');
        expect(sut.name).toBe('url');
      });
    });
  });

  describe('Given a subsection containing mixed case branch.Feature/X.remote', () => {
    describe('When parsed', () => {
      it('Then subsection preserves case while section and name are lower-cased', () => {
        // Arrange + Act
        const sut = parseConfigKey('Branch.Feature/X.Remote');

        // Assert
        expect(sut.section).toBe('branch');
        expect(sut.subsection).toBe('Feature/X');
        expect(sut.name).toBe('remote');
      });
    });
  });

  describe('Given an empty string', () => {
    describe('When parsed', () => {
      it('Then throws CONFIG_KEY_INVALID with reason "missing-name"', () => {
        // Arrange
        let caught: TsgitError | undefined;

        // Act
        try {
          parseConfigKey('');
        } catch (err) {
          caught = err as TsgitError;
        }

        // Assert — empty string has no dot, so the missing-name guard fires first
        expect(caught).toBeInstanceOf(TsgitError);
        expect(caught?.data).toEqual({
          code: 'CONFIG_KEY_INVALID',
          key: '',
          reason: 'missing-name',
        });
      });
    });
  });

  describe('Given a single-token key user (no dot)', () => {
    describe('When parsed', () => {
      it('Then throws CONFIG_KEY_INVALID with reason "missing-name"', () => {
        // Arrange
        let caught: TsgitError | undefined;

        // Act
        try {
          parseConfigKey('user');
        } catch (err) {
          caught = err as TsgitError;
        }

        // Assert
        expect(caught?.data).toEqual({
          code: 'CONFIG_KEY_INVALID',
          key: 'user',
          reason: 'missing-name',
        });
      });
    });
  });

  describe('Given a key starting with a dot .name', () => {
    describe('When parsed', () => {
      it('Then throws CONFIG_KEY_INVALID with reason "empty-section"', () => {
        // Arrange
        let caught: TsgitError | undefined;

        // Act
        try {
          parseConfigKey('.name');
        } catch (err) {
          caught = err as TsgitError;
        }

        // Assert
        expect(caught?.data).toEqual({
          code: 'CONFIG_KEY_INVALID',
          key: '.name',
          reason: 'empty-section',
        });
      });
    });
  });

  describe('Given a key ending with a dot user.', () => {
    describe('When parsed', () => {
      it('Then throws CONFIG_KEY_INVALID with reason "missing-name"', () => {
        // Arrange
        let caught: TsgitError | undefined;

        // Act
        try {
          parseConfigKey('user.');
        } catch (err) {
          caught = err as TsgitError;
        }

        // Assert
        expect(caught?.data).toEqual({
          code: 'CONFIG_KEY_INVALID',
          key: 'user.',
          reason: 'missing-name',
        });
      });
    });
  });

  describe('Given a section starting with a digit 1user.name', () => {
    describe('When parsed', () => {
      it('Then throws CONFIG_KEY_INVALID with reason "bad-character" at position 0', () => {
        // Arrange
        let caught: TsgitError | undefined;

        // Act
        try {
          parseConfigKey('1user.name');
        } catch (err) {
          caught = err as TsgitError;
        }

        // Assert
        expect(caught?.data).toEqual({
          code: 'CONFIG_KEY_INVALID',
          key: '1user.name',
          reason: 'bad-character',
          position: 0,
        });
      });
    });
  });

  describe('Given a name starting with a digit user.1name', () => {
    describe('When parsed', () => {
      it('Then throws CONFIG_KEY_INVALID with reason "bad-character" at the digit position', () => {
        // Arrange
        let caught: TsgitError | undefined;

        // Act
        try {
          parseConfigKey('user.1name');
        } catch (err) {
          caught = err as TsgitError;
        }

        // Assert — position 5 is the index of '1' in 'user.1name'
        expect(caught?.data).toEqual({
          code: 'CONFIG_KEY_INVALID',
          key: 'user.1name',
          reason: 'bad-character',
          position: 5,
        });
      });
    });
  });

  describe('Given a section containing a forbidden character with spaces user!.name', () => {
    describe('When parsed', () => {
      it('Then throws CONFIG_KEY_INVALID with reason "bad-character"', () => {
        // Arrange
        let caught: TsgitError | undefined;

        // Act
        try {
          parseConfigKey('user!.name');
        } catch (err) {
          caught = err as TsgitError;
        }

        // Assert — '!' is at index 4 in 'user!.name'
        expect(caught?.data).toEqual({
          code: 'CONFIG_KEY_INVALID',
          key: 'user!.name',
          reason: 'bad-character',
          position: 4,
        });
      });
    });
  });

  describe('Given a name containing underscore user.x_name', () => {
    describe('When parsed', () => {
      it('Then throws CONFIG_KEY_INVALID with reason "bad-character" (underscore is not allowed)', () => {
        // Arrange
        let caught: TsgitError | undefined;

        // Act
        try {
          parseConfigKey('user.x_name');
        } catch (err) {
          caught = err as TsgitError;
        }

        // Assert — '_' is at index 6 in 'user.x_name'
        expect(caught?.data).toEqual({
          code: 'CONFIG_KEY_INVALID',
          key: 'user.x_name',
          reason: 'bad-character',
          position: 6,
        });
      });
    });
  });

  describe('Given a subsection containing a newline', () => {
    describe('When parsed', () => {
      it('Then throws CONFIG_KEY_INVALID with reason "bad-character" at the newline position', () => {
        // Arrange
        const key = 'remote.foo\nbar.url';
        let caught: TsgitError | undefined;

        // Act
        try {
          parseConfigKey(key);
        } catch (err) {
          caught = err as TsgitError;
        }

        // Assert — '\n' is at index 10 in 'remote.foo\nbar.url'.
        // sanitizeForDisplay preserves \n (it is in the keep-set), so the key
        // field carries the raw newline rather than the \\x0A escape form.
        expect(caught?.data).toEqual({
          code: 'CONFIG_KEY_INVALID',
          key: 'remote.foo\nbar.url',
          reason: 'bad-character',
          position: 10,
        });
      });
    });
  });

  describe('Given a subsection containing a quote', () => {
    describe('When parsed', () => {
      it('Then throws CONFIG_KEY_INVALID with reason "bad-character"', () => {
        // Arrange
        const key = 'remote.foo"bar.url';
        let caught: TsgitError | undefined;

        // Act
        try {
          parseConfigKey(key);
        } catch (err) {
          caught = err as TsgitError;
        }

        // Assert — '"' is at index 10 in 'remote.foo"bar.url'
        expect(caught?.data.code).toBe('CONFIG_KEY_INVALID');
        expect((caught?.data as { reason: string; position: number }).reason).toBe('bad-character');
        expect((caught?.data as { reason: string; position: number }).position).toBe(10);
      });
    });
  });
});
