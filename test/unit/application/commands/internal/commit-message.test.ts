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
    describe('Given an explicit author', () => {
      describe('When resolveAuthor', () => {
        it('Then returns it', () => {
          // Arrange
          const explicit = author({ name: 'Bob', email: 'bob@example.com' });

          // Act
          const sut = resolveAuthor({ explicit });

          // Assert
          expect(sut.name).toBe('Bob');
        });
      });
    });

    describe('Given no explicit author + configUser set', () => {
      describe('When resolveAuthor', () => {
        it('Then returns the config user', () => {
          // Arrange
          const sut = resolveAuthor({
            configUser: author({ name: 'Cfg', email: 'cfg@example.com' }),
          });

          // Assert
          expect(sut.name).toBe('Cfg');
        });
      });
    });

    describe('Given neither explicit nor configUser', () => {
      describe('When resolveAuthor', () => {
        it('Then throws AUTHOR_UNCONFIGURED', () => {
          // Arrange
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
    });
  });

  describe('resolveCommitter', () => {
    describe('Given inputs at different priority levels', () => {
      describe('When resolveCommitter', () => {
        it.each([
          {
            explicit: author({ name: 'Committer' }),
            authorArg: undefined,
            configUser: undefined,
            expected: 'Committer',
            label: 'an explicit committer is returned',
          },
          {
            explicit: undefined,
            authorArg: author({ name: 'Auth' }),
            configUser: undefined,
            expected: 'Auth',
            label: 'falls back to the author when no explicit committer is given',
          },
          {
            explicit: author({ name: 'Explicit' }),
            authorArg: author({ name: 'Auth' }),
            configUser: undefined,
            expected: 'Explicit',
            label: 'an explicit committer wins over an author (priority order)',
          },
          {
            explicit: undefined,
            authorArg: undefined,
            configUser: author({ name: 'Cfg', email: 'cfg@example.com' }),
            expected: 'Cfg',
            label: 'falls back to the config user when no explicit committer or author is given',
          },
        ])('Then $label', ({ explicit, authorArg, configUser, expected }) => {
          // Arrange + Act
          const sut = resolveCommitter({
            ...(explicit !== undefined && { explicit }),
            ...(authorArg !== undefined && { author: authorArg }),
            configUser,
          });

          // Assert
          expect(sut.name).toBe(expected);
        });
      });
    });

    describe('Given nothing at all', () => {
      describe('When resolveCommitter', () => {
        it('Then throws AUTHOR_UNCONFIGURED', () => {
          // Arrange
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
    });
  });

  describe('sanitizeMessage', () => {
    describe("Given '   leading + trailing whitespace   \\\\n\\\\n' with allowEmpty=false", () => {
      describe('When sanitizeMessage', () => {
        it('Then strips trailing whitespace and blank lines, keeps leading whitespace and a single newline', () => {
          // Arrange
          const sut = sanitizeMessage('   leading + trailing whitespace   \n\n', {
            allowEmpty: false,
          });

          // Assert — git stripspace keeps leading whitespace on a content line,
          // strips per-line trailing whitespace + trailing blanks, and ensures
          // exactly one trailing newline.
          expect(sut).toBe('   leading + trailing whitespace\n');
        });
      });
    });

    describe("Given '' with allowEmpty=false", () => {
      describe('When sanitizeMessage', () => {
        it('Then throws EMPTY_COMMIT_MESSAGE', () => {
          // Arrange
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
      });
    });

    describe('Given whitespace-only with allowEmpty=false', () => {
      describe('When sanitizeMessage', () => {
        it('Then throws EMPTY_COMMIT_MESSAGE', () => {
          // Arrange
          let caught: unknown;
          try {
            sanitizeMessage('  \n  ', { allowEmpty: false });
          } catch (err) {
            caught = err;
          }
          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as TsgitError).data.code).toBe('EMPTY_COMMIT_MESSAGE');
        });
      });
    });

    describe("Given '' with allowEmpty=true", () => {
      describe('When sanitizeMessage', () => {
        it("Then returns ''", () => {
          // Arrange
          const sut = sanitizeMessage('', { allowEmpty: true });

          // Assert
          expect(sut).toBe('');
        });
      });
    });
  });

  describe('sanitizeMarkerLabel', () => {
    describe('Given a label whose characters must each be escaped or kept per the printable-ASCII guard', () => {
      describe('When sanitizeMarkerLabel', () => {
        it.each([
          { input: 'main', expected: 'main', label: "'main' is returned unchanged" },
          {
            input: 'main\nfoo',
            expected: 'main\\x0Afoo',
            label: 'LF is escaped (label must be single-line for marker safety)',
          },
          {
            input: 'a\0b',
            expected: 'a\\x00b',
            label: 'NUL is escaped',
          },
          {
            input: '<<<<<feature>>>>>',
            expected: '<<<<<feature>>>>>',
            label: 'embedded marker chars (<<<<) remain printable (not escaped)',
          },
          {
            input: 'a b',
            expected: 'a b',
            label: 'a SPACE (0x20, low boundary) is kept verbatim (not escaped)',
          },
          {
            input: 'a\x1Fb',
            expected: 'a\\x1Fb',
            label: 'char 0x1F (just below low boundary) is escaped',
          },
          {
            input: 'a~b',
            expected: 'a~b',
            label: 'a TILDE (0x7E, high boundary) is kept verbatim (not escaped)',
          },
          {
            input: 'a\x7Fb',
            expected: 'a\\x7Fb',
            label: 'char 0x7F (DEL, just above high boundary) is escaped',
          },
        ])('Then $label', ({ input, expected }) => {
          // Arrange + Act
          const sut = sanitizeMarkerLabel(input);

          // Assert
          expect(sut).toBe(expected);
        });
      });
    });

    describe('Given a 250-character label', () => {
      describe('When sanitizeMarkerLabel', () => {
        it('Then truncated to 200 bytes', () => {
          // Arrange
          const big = 'a'.repeat(250);

          // Act
          const sut = sanitizeMarkerLabel(big);

          // Assert
          expect(sut.length).toBe(200);
        });
      });
    });

    describe('Given a label whose escape sequence crosses the 200-byte cap', () => {
      describe('When sanitizeMarkerLabel', () => {
        it('Then output is sliced to exactly 200 bytes', () => {
          // Arrange — 197 printable chars then a control char; escaping the control
          // char ('\\x01' = 4 chars) pushes `out` to length 201, so the slice MUST
          // trim it back to 200. Without the slice the result would be length 201.
          const raw = `${'a'.repeat(197)}\x01`;

          // Act
          const sut = sanitizeMarkerLabel(raw);

          // Assert
          expect(sut.length).toBe(200);
          expect(sut).toBe(`${'a'.repeat(197)}\\x0`);
        });
      });
    });
  });
});
