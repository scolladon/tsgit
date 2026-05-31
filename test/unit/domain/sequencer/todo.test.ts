import { describe, expect, it } from 'vitest';
import type { TsgitError } from '../../../../src/domain/error.js';
import {
  parseTodo,
  serializeTodo,
  type TodoEntry,
} from '../../../../src/domain/sequencer/index.js';

const pick = (oid: string, subject: string): TodoEntry => ({ command: 'pick', oid, subject });

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
