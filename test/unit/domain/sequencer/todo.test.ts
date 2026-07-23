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
    describe('When given a list of sequencer todo entries', () => {
      it.each([
        {
          label: 'an empty list returns the empty string',
          entries: [] as TodoEntry[],
          expected: '',
        },
        {
          label: 'pick entries emit one `pick <oid> <subject>` line per entry with a trailing LF',
          entries: [pick('9dac856', 'pick-A subject'), pick('335bfa5', 'pick-B subject')],
          expected: 'pick 9dac856 pick-A subject\npick 335bfa5 pick-B subject\n',
        },
        {
          label: 'a full 40-hex oid is written verbatim (tsgit emits full oids)',
          entries: [pick('1e3c39c1814be4b7807a7fec7ee602f0570e55de', 'c1')],
          expected: 'pick 1e3c39c1814be4b7807a7fec7ee602f0570e55de c1\n',
        },
        {
          label: 'revert entries emit one `revert <oid> <subject>` line per entry',
          entries: [revert('9dac856', 'Revert "A"'), revert('335bfa5', 'Revert "B"')],
          expected: 'revert 9dac856 Revert "A"\nrevert 335bfa5 Revert "B"\n',
        },
        {
          label: 'a mix of pick and revert entries each emit their own command keyword',
          entries: [pick('aaaaaaa', 'p'), revert('bbbbbbb', 'r')],
          expected: 'pick aaaaaaa p\nrevert bbbbbbb r\n',
        },
      ])('Then $label', ({ entries, expected }) => {
        // Arrange + Act
        const sut = serializeTodo(entries);

        // Assert
        expect(sut).toBe(expected);
      });
    });
  });

  describe('Given parseTodo', () => {
    describe('When given well-formed todo text', () => {
      it.each([
        {
          label:
            "git's abbreviated-oid output extracts the raw oid token and subject (resolution deferred to the caller)",
          text: 'pick f4cb28d c1\npick 0a4f2a3 c2\n',
          expected: [pick('f4cb28d', 'c1'), pick('0a4f2a3', 'c2')],
        },
        {
          label: 'blank and comment lines (git rebase-style) are skipped',
          text: '# Rebase abc onto def\n\npick aaaaaaa one\n\n# a comment\npick bbbbbbb two\n',
          expected: [pick('aaaaaaa', 'one'), pick('bbbbbbb', 'two')],
        },
        {
          label: 'revert instruction lines parse the revert command keyword',
          text: 'revert f4cb28d Revert "c1"\nrevert 0a4f2a3 Revert "c2"\n',
          expected: [revert('f4cb28d', 'Revert "c1"'), revert('0a4f2a3', 'Revert "c2"')],
        },
        {
          label: 'a mix of pick and revert lines preserves each line’s command',
          text: 'pick aaaaaaa p\nrevert bbbbbbb r\n',
          expected: [pick('aaaaaaa', 'p'), revert('bbbbbbb', 'r')],
        },
        {
          label: 'an empty subject parses to an empty string',
          text: 'pick aaaaaaa \n',
          expected: [pick('aaaaaaa', '')],
        },
      ])('Then $label', ({ text, expected }) => {
        // Arrange + Act
        const sut = parseTodo(text);

        // Assert
        expect(sut).toEqual(expected);
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
