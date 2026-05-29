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
    describe('Given an explicit committer', () => {
      describe('When resolveCommitter', () => {
        it('Then returns it', () => {
          // Arrange
          const explicit = author({ name: 'Committer' });

          // Act
          const sut = resolveCommitter({ explicit });

          // Assert
          expect(sut.name).toBe('Committer');
        });
      });
    });

    describe('Given no explicit committer + author given', () => {
      describe('When resolveCommitter', () => {
        it('Then returns author', () => {
          // Arrange
          const auth = author({ name: 'Auth' });

          // Act
          const sut = resolveCommitter({ author: auth });

          // Assert
          expect(sut.name).toBe('Auth');
        });
      });
    });

    describe('Given explicit committer AND author given', () => {
      describe('When resolveCommitter', () => {
        it('Then explicit wins (priority order)', () => {
          // Arrange
          const explicit = author({ name: 'Explicit' });
          const auth = author({ name: 'Auth' });

          // Act
          const sut = resolveCommitter({ explicit, author: auth });

          // Assert
          expect(sut.name).toBe('Explicit');
        });
      });
    });

    describe('Given no explicit + no author + configUser', () => {
      describe('When resolveCommitter', () => {
        it('Then returns config user', () => {
          // Arrange
          const sut = resolveCommitter({
            configUser: author({ name: 'Cfg', email: 'cfg@example.com' }),
          });

          // Assert
          expect(sut.name).toBe('Cfg');
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
    describe("Given 'main'", () => {
      describe('When sanitizeMarkerLabel', () => {
        it("Then returns 'main'", () => {
          // Arrange
          const sut = sanitizeMarkerLabel('main');

          // Assert
          expect(sut).toBe('main');
        });
      });
    });

    describe("Given 'main\\\\nfoo'", () => {
      describe('When sanitizeMarkerLabel', () => {
        it('Then CR/LF/control chars escaped', () => {
          // Arrange
          const sut = sanitizeMarkerLabel('main\nfoo');

          // Assert — LF escaped (label must be single-line for marker safety).
          expect(sut).toBe('main\\x0Afoo');
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

    describe('Given a label with NUL byte', () => {
      describe('When sanitizeMarkerLabel', () => {
        it('Then NUL is escaped', () => {
          // Arrange
          const sut = sanitizeMarkerLabel('a\0b');

          // Assert
          expect(sut).toBe('a\\x00b');
        });
      });
    });

    describe('Given a label with embedded marker chars (<<<<)', () => {
      describe('When sanitizeMarkerLabel', () => {
        it('Then they remain printable (not escaped)', () => {
          // Arrange — the label itself can contain `<` chars; they're printable ASCII.
          const sut = sanitizeMarkerLabel('<<<<<feature>>>>>');

          // Assert
          expect(sut).toBe('<<<<<feature>>>>>');
        });
      });
    });

    describe('Given a SPACE (0x20, low boundary)', () => {
      describe('When sanitizeMarkerLabel', () => {
        it('Then it is kept verbatim (not escaped)', () => {
          // Arrange — 0x20 is the inclusive lower bound; `code > 0x20` would escape it.
          const sut = sanitizeMarkerLabel('a b');

          // Assert
          expect(sut).toBe('a b');
        });
      });
    });

    describe('Given char 0x1F (just below low boundary)', () => {
      describe('When sanitizeMarkerLabel', () => {
        it('Then it is escaped', () => {
          // Arrange — 0x1F is just under 0x20; `code >= 0x20` must reject it.
          const sut = sanitizeMarkerLabel('a\x1Fb');

          // Assert
          expect(sut).toBe('a\\x1Fb');
        });
      });
    });

    describe('Given a TILDE (0x7E, high boundary)', () => {
      describe('When sanitizeMarkerLabel', () => {
        it('Then it is kept verbatim (not escaped)', () => {
          // Arrange — 0x7E is the inclusive upper bound; `code < 0x7e` would escape it.
          const sut = sanitizeMarkerLabel('a~b');

          // Assert
          expect(sut).toBe('a~b');
        });
      });
    });

    describe('Given char 0x7F (DEL, just above high boundary)', () => {
      describe('When sanitizeMarkerLabel', () => {
        it('Then it is escaped', () => {
          // Arrange — 0x7F is just over 0x7E; `code <= 0x7e` (and the `true` mutant) must reject it.
          const sut = sanitizeMarkerLabel('a\x7Fb');

          // Assert
          expect(sut).toBe('a\\x7Fb');
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
