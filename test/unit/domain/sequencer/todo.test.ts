import { describe, expect, it } from 'vitest';
import type { TsgitError } from '../../../../src/domain/error.js';
import {
  parseTodo,
  serializeTodo,
  type TodoEntry,
} from '../../../../src/domain/sequencer/index.js';

const pick = (oid: string, subject: string): TodoEntry => ({ command: 'pick', oid, subject });
const revert = (oid: string, subject: string): TodoEntry => ({ command: 'revert', oid, subject });

describe('sequencer todo', () => {
  describe('Given serializeTodo', () => {
    describe('When given an empty list', () => {
      it('Then returns the empty string', () => {
        // Arrange + Act
        const sut = serializeTodo([]);

        // Assert
        expect(sut).toBe('');
      });
    });

    describe('When given pick entries', () => {
      it('Then emits one `pick <oid> <subject>` line per entry with a trailing LF', () => {
        // Arrange
        const entries = [pick('9dac856', 'pick-A subject'), pick('335bfa5', 'pick-B subject')];

        // Act
        const sut = serializeTodo(entries);

        // Assert
        expect(sut).toBe('pick 9dac856 pick-A subject\npick 335bfa5 pick-B subject\n');
      });
    });

    describe('When the oid is a full 40-hex', () => {
      it('Then writes it verbatim (tsgit emits full oids)', () => {
        // Arrange
        const full = '1e3c39c1814be4b7807a7fec7ee602f0570e55de';

        // Act
        const sut = serializeTodo([pick(full, 'c1')]);

        // Assert
        expect(sut).toBe(`pick ${full} c1\n`);
      });
    });

    describe('When given revert entries', () => {
      it('Then emits one `revert <oid> <subject>` line per entry', () => {
        // Arrange
        const entries = [revert('9dac856', 'Revert "A"'), revert('335bfa5', 'Revert "B"')];

        // Act
        const sut = serializeTodo(entries);

        // Assert
        expect(sut).toBe('revert 9dac856 Revert "A"\nrevert 335bfa5 Revert "B"\n');
      });
    });

    describe('When given a mix of pick and revert entries', () => {
      it('Then emits each entry with its own command keyword', () => {
        // Arrange
        const entries = [pick('aaaaaaa', 'p'), revert('bbbbbbb', 'r')];

        // Act
        const sut = serializeTodo(entries);

        // Assert
        expect(sut).toBe('pick aaaaaaa p\nrevert bbbbbbb r\n');
      });
    });
  });

  describe('Given parseTodo', () => {
    describe("When given git's abbreviated-oid output", () => {
      it('Then extracts the raw oid token and subject (resolution deferred to the caller)', () => {
        // Arrange
        const text = 'pick f4cb28d c1\npick 0a4f2a3 c2\n';

        // Act
        const sut = parseTodo(text);

        // Assert
        expect(sut).toEqual([pick('f4cb28d', 'c1'), pick('0a4f2a3', 'c2')]);
      });
    });

    describe('When the text has blank and comment lines (git rebase-style)', () => {
      it('Then skips them', () => {
        // Arrange
        const text = '# Rebase abc onto def\n\npick aaaaaaa one\n\n# a comment\npick bbbbbbb two\n';

        // Act
        const sut = parseTodo(text);

        // Assert
        expect(sut).toEqual([pick('aaaaaaa', 'one'), pick('bbbbbbb', 'two')]);
      });
    });

    describe('When given revert instruction lines', () => {
      it('Then parses the revert command keyword', () => {
        // Arrange
        const text = 'revert f4cb28d Revert "c1"\nrevert 0a4f2a3 Revert "c2"\n';

        // Act
        const sut = parseTodo(text);

        // Assert
        expect(sut).toEqual([revert('f4cb28d', 'Revert "c1"'), revert('0a4f2a3', 'Revert "c2"')]);
      });
    });

    describe('When given a mix of pick and revert lines', () => {
      it('Then preserves each line’s command', () => {
        // Arrange
        const text = 'pick aaaaaaa p\nrevert bbbbbbb r\n';

        // Act
        const sut = parseTodo(text);

        // Assert
        expect(sut).toEqual([pick('aaaaaaa', 'p'), revert('bbbbbbb', 'r')]);
      });
    });

    describe('When a subject is empty', () => {
      it('Then parses an empty subject', () => {
        // Arrange
        const sut = parseTodo('pick aaaaaaa \n');

        // Assert
        expect(sut).toEqual([pick('aaaaaaa', '')]);
      });
    });

    describe('When a non-blank line is not a valid pick instruction', () => {
      it('Then throws INVALID_SEQUENCER_TODO carrying the offending line', () => {
        // Arrange + Act
        let caught: TsgitError | undefined;
        try {
          parseTodo('pick aaaaaaa ok\ndrop bbbbbbb nope\n');
        } catch (err) {
          caught = err as TsgitError;
        }

        // Assert
        expect(caught?.data.code).toBe('INVALID_SEQUENCER_TODO');
        if (caught?.data.code === 'INVALID_SEQUENCER_TODO') {
          expect(caught.data.reason).toContain('drop bbbbbbb nope');
        }
      });
    });

    describe('When a pick line has no subject separator', () => {
      it('Then throws INVALID_SEQUENCER_TODO', () => {
        // Arrange + Act
        let caught: TsgitError | undefined;
        try {
          parseTodo('pick aaaaaaa\n');
        } catch (err) {
          caught = err as TsgitError;
        }

        // Assert
        expect(caught?.data.code).toBe('INVALID_SEQUENCER_TODO');
      });
    });
  });
});
