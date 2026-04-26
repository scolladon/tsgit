import { describe, expect, it } from 'vitest';
import {
  resolveAuthor,
  resolveCommitter,
  sanitizeMarkerLabel,
  sanitizeMessage,
} from '../../../../../src/application/commands/internal/commit-message.js';
import { TsgitError } from '../../../../../src/domain/index.js';
import type { AuthorIdentity } from '../../../../../src/domain/objects/index.js';

const author = (overrides: Partial<AuthorIdentity> = {}): AuthorIdentity => ({
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
  ...overrides,
});

describe('internal/commit-message', () => {
  describe('resolveAuthor', () => {
    it('Given an explicit author, When resolveAuthor, Then returns it', () => {
      // Arrange
      const explicit = author({ name: 'Bob', email: 'bob@example.com' });

      // Act
      const sut = resolveAuthor({ explicit });

      // Assert
      expect(sut.name).toBe('Bob');
    });

    it('Given no explicit author + configUser set, When resolveAuthor, Then returns the config user', () => {
      // Act
      const sut = resolveAuthor({
        configUser: author({ name: 'Cfg', email: 'cfg@example.com' }),
      });

      // Assert
      expect(sut.name).toBe('Cfg');
    });

    it('Given neither explicit nor configUser, When resolveAuthor, Then throws AUTHOR_UNCONFIGURED', () => {
      // Act
      let caught: unknown;
      try {
        resolveAuthor({});
      } catch (err) {
        caught = err;
      }

      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      expect((caught as TsgitError).data.code).toBe('AUTHOR_UNCONFIGURED');
    });
  });

  describe('resolveCommitter', () => {
    it('Given an explicit committer, When resolveCommitter, Then returns it', () => {
      // Arrange
      const explicit = author({ name: 'Committer' });

      // Act
      const sut = resolveCommitter({ explicit });

      // Assert
      expect(sut.name).toBe('Committer');
    });

    it('Given no explicit committer + author given, When resolveCommitter, Then returns author', () => {
      // Arrange
      const auth = author({ name: 'Auth' });

      // Act
      const sut = resolveCommitter({ author: auth });

      // Assert
      expect(sut.name).toBe('Auth');
    });

    it('Given explicit committer AND author given, When resolveCommitter, Then explicit wins (priority order)', () => {
      // Arrange
      const explicit = author({ name: 'Explicit' });
      const auth = author({ name: 'Auth' });

      // Act
      const sut = resolveCommitter({ explicit, author: auth });

      // Assert
      expect(sut.name).toBe('Explicit');
    });

    it('Given no explicit + no author + configUser, When resolveCommitter, Then returns config user', () => {
      // Act
      const sut = resolveCommitter({
        configUser: author({ name: 'Cfg', email: 'cfg@example.com' }),
      });

      // Assert
      expect(sut.name).toBe('Cfg');
    });

    it('Given nothing at all, When resolveCommitter, Then throws AUTHOR_UNCONFIGURED', () => {
      // Act
      let caught: unknown;
      try {
        resolveCommitter({});
      } catch (err) {
        caught = err;
      }

      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      expect((caught as TsgitError).data.code).toBe('AUTHOR_UNCONFIGURED');
    });
  });

  describe('sanitizeMessage', () => {
    it("Given '   leading + trailing whitespace   \\n\\n' with allowEmpty=false, When sanitizeMessage, Then returns trimmed", () => {
      // Act
      const sut = sanitizeMessage('   leading + trailing whitespace   \n\n', { allowEmpty: false });

      // Assert
      expect(sut).toBe('leading + trailing whitespace');
    });

    it("Given '' with allowEmpty=false, When sanitizeMessage, Then throws EMPTY_COMMIT_MESSAGE", () => {
      // Act
      let caught: unknown;
      try {
        sanitizeMessage('', { allowEmpty: false });
      } catch (err) {
        caught = err;
      }

      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      expect((caught as TsgitError).data.code).toBe('EMPTY_COMMIT_MESSAGE');
    });

    it('Given whitespace-only with allowEmpty=false, When sanitizeMessage, Then throws EMPTY_COMMIT_MESSAGE', () => {
      let caught: unknown;
      try {
        sanitizeMessage('  \n  ', { allowEmpty: false });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(TsgitError);
      expect((caught as TsgitError).data.code).toBe('EMPTY_COMMIT_MESSAGE');
    });

    it("Given '' with allowEmpty=true, When sanitizeMessage, Then returns ''", () => {
      // Act
      const sut = sanitizeMessage('', { allowEmpty: true });

      // Assert
      expect(sut).toBe('');
    });
  });

  describe('sanitizeMarkerLabel', () => {
    it("Given 'main', When sanitizeMarkerLabel, Then returns 'main'", () => {
      expect(sanitizeMarkerLabel('main')).toBe('main');
    });

    it("Given 'main\\nfoo', When sanitizeMarkerLabel, Then CR/LF/control chars escaped", () => {
      // Act
      const sut = sanitizeMarkerLabel('main\nfoo');

      // Assert — LF escaped (label must be single-line for marker safety).
      expect(sut).toBe('main\\x0Afoo');
    });

    it('Given a 250-character label, When sanitizeMarkerLabel, Then truncated to 200 bytes', () => {
      // Arrange
      const big = 'a'.repeat(250);

      // Act
      const sut = sanitizeMarkerLabel(big);

      // Assert
      expect(sut.length).toBe(200);
    });

    it('Given a label with NUL byte, When sanitizeMarkerLabel, Then NUL is escaped', () => {
      // Act
      const sut = sanitizeMarkerLabel('a\0b');

      // Assert
      expect(sut).toBe('a\\x00b');
    });

    it('Given a label with embedded marker chars (<<<<), When sanitizeMarkerLabel, Then they remain printable (not escaped)', () => {
      // Arrange — the label itself can contain `<` chars; they're printable ASCII.
      const sut = sanitizeMarkerLabel('<<<<<feature>>>>>');

      // Assert
      expect(sut).toBe('<<<<<feature>>>>>');
    });
  });
});
