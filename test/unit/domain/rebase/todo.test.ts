import { describe, expect, it } from 'vitest';
import type { TsgitError } from '../../../../src/domain/error.js';
import {
  parseRebaseTodo,
  type RebaseTodoEntry,
  serializeRebaseTodo,
} from '../../../../src/domain/rebase/index.js';

const pick = (oid: string, subject: string): RebaseTodoEntry => ({ action: 'pick', oid, subject });

describe('rebase todo grammar', () => {
  describe('Given serializeRebaseTodo', () => {
    describe('When given an empty list', () => {
      it('Then returns the empty string', () => {
        // Arrange + Act
        const sut = serializeRebaseTodo([]);

        // Assert
        expect(sut).toBe('');
      });
    });

    describe('When given pick entries', () => {
      it('Then emits one `pick <oid> # <subject>` line per entry with a trailing LF', () => {
        // Arrange
        const entries = [pick('9dac856', 't1 subject'), pick('335bfa5', 't2 subject')];

        // Act
        const sut = serializeRebaseTodo(entries);

        // Assert
        expect(sut).toBe('pick 9dac856 # t1 subject\npick 335bfa5 # t2 subject\n');
      });
    });

    describe('When given the interactive verbs', () => {
      it('Then emits each verb verbatim', () => {
        // Arrange
        const entries: ReadonlyArray<RebaseTodoEntry> = [
          { action: 'reword', oid: 'aaaaaaa', subject: 'r' },
          { action: 'edit', oid: 'bbbbbbb', subject: 'e' },
          { action: 'squash', oid: 'ccccccc', subject: 's' },
          { action: 'fixup', oid: 'ddddddd', subject: 'f' },
          { action: 'drop', oid: 'eeeeeee', subject: 'd' },
        ];

        // Act
        const sut = serializeRebaseTodo(entries);

        // Assert
        expect(sut).toBe(
          'reword aaaaaaa # r\nedit bbbbbbb # e\nsquash ccccccc # s\nfixup ddddddd # f\ndrop eeeeeee # d\n',
        );
      });
    });

    describe('When the oid is a full 40-hex', () => {
      it('Then writes it verbatim (tsgit emits full oids)', () => {
        // Arrange
        const full = '1e3c39c1814be4b7807a7fec7ee602f0570e55de';

        // Act
        const sut = serializeRebaseTodo([pick(full, 'c1')]);

        // Assert
        expect(sut).toBe(`pick ${full} # c1\n`);
      });
    });
  });

  describe('Given parseRebaseTodo', () => {
    describe("When given git's abbreviated-oid output", () => {
      it('Then extracts the raw oid token and subject (resolution deferred to the caller)', () => {
        // Arrange
        const text = 'pick f4cb28d # c1\npick 0a4f2a3 # c2\n';

        // Act
        const sut = parseRebaseTodo(text);

        // Assert
        expect(sut).toEqual([pick('f4cb28d', 'c1'), pick('0a4f2a3', 'c2')]);
      });
    });

    describe('When given the interactive verbs', () => {
      it('Then parses each verb into its action', () => {
        // Arrange
        const text =
          'reword aaaaaaa # r\nedit bbbbbbb # e\nsquash ccccccc # s\nfixup ddddddd # f\ndrop eeeeeee # d\n';

        // Act
        const sut = parseRebaseTodo(text);

        // Assert
        expect(sut).toEqual([
          { action: 'reword', oid: 'aaaaaaa', subject: 'r' },
          { action: 'edit', oid: 'bbbbbbb', subject: 'e' },
          { action: 'squash', oid: 'ccccccc', subject: 's' },
          { action: 'fixup', oid: 'ddddddd', subject: 'f' },
          { action: 'drop', oid: 'eeeeeee', subject: 'd' },
        ]);
      });
    });

    describe('When the text has the backup blank and comment lines', () => {
      it('Then skips them', () => {
        // Arrange
        const text =
          'pick aaaaaaa # one\n\n# Rebase abc..def onto abc (2 commands)\n#\n# Commands:\npick bbbbbbb # two\n';

        // Act
        const sut = parseRebaseTodo(text);

        // Assert
        expect(sut).toEqual([pick('aaaaaaa', 'one'), pick('bbbbbbb', 'two')]);
      });
    });

    describe('When a subject contains a literal # after the separator', () => {
      it('Then keeps the whole remainder as the subject', () => {
        // Arrange
        const sut = parseRebaseTodo('pick aaaaaaa # fix #42 in parser\n');

        // Assert
        expect(sut).toEqual([pick('aaaaaaa', 'fix #42 in parser')]);
      });
    });

    describe('When a subject is empty', () => {
      it('Then parses an empty subject', () => {
        // Arrange
        const sut = parseRebaseTodo('pick aaaaaaa # \n');

        // Assert
        expect(sut).toEqual([pick('aaaaaaa', '')]);
      });
    });

    describe('When a line uses a git verb outside the supported six', () => {
      it('Then throws INVALID_SEQUENCER_TODO carrying the offending line', () => {
        // Arrange + Act — `reset` is a real `rebase -i` verb (label/reset/merge),
        // but it is outside tsgit's supported set, so it must be rejected.
        let caught: TsgitError | undefined;
        try {
          parseRebaseTodo('pick aaaaaaa # ok\nreset bbbbbbb # onto a label\n');
        } catch (err) {
          caught = err as TsgitError;
        }

        // Assert
        expect(caught?.data.code).toBe('INVALID_SEQUENCER_TODO');
        if (caught?.data.code === 'INVALID_SEQUENCER_TODO') {
          expect(caught.data.reason).toContain('reset bbbbbbb # onto a label');
        }
      });
    });

    describe('When a pick line has no ` # ` subject separator', () => {
      it('Then throws INVALID_SEQUENCER_TODO', () => {
        // Arrange + Act
        let caught: TsgitError | undefined;
        try {
          parseRebaseTodo('pick aaaaaaa\n');
        } catch (err) {
          caught = err as TsgitError;
        }

        // Assert
        expect(caught?.data.code).toBe('INVALID_SEQUENCER_TODO');
      });
    });
  });
});
