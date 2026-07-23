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
    describe('When given a list of rebase todo entries', () => {
      it.each([
        {
          label: 'an empty list returns the empty string',
          entries: [] as ReadonlyArray<RebaseTodoEntry>,
          expected: '',
        },
        {
          label: 'pick entries emit one `pick <oid> # <subject>` line per entry with a trailing LF',
          entries: [pick('9dac856', 't1 subject'), pick('335bfa5', 't2 subject')],
          expected: 'pick 9dac856 # t1 subject\npick 335bfa5 # t2 subject\n',
        },
        {
          label: 'the interactive verbs are each emitted verbatim',
          entries: [
            { action: 'reword', oid: 'aaaaaaa', subject: 'r' },
            { action: 'edit', oid: 'bbbbbbb', subject: 'e' },
            { action: 'squash', oid: 'ccccccc', subject: 's' },
            { action: 'fixup', oid: 'ddddddd', subject: 'f' },
            { action: 'drop', oid: 'eeeeeee', subject: 'd' },
          ] as ReadonlyArray<RebaseTodoEntry>,
          expected:
            'reword aaaaaaa # r\nedit bbbbbbb # e\nsquash ccccccc # s\nfixup ddddddd # f\ndrop eeeeeee # d\n',
        },
        {
          label: 'a full 40-hex oid is written verbatim (tsgit emits full oids)',
          entries: [pick('1e3c39c1814be4b7807a7fec7ee602f0570e55de', 'c1')],
          expected: 'pick 1e3c39c1814be4b7807a7fec7ee602f0570e55de # c1\n',
        },
      ])('Then $label', ({ entries, expected }) => {
        // Arrange + Act
        const sut = serializeRebaseTodo(entries);

        // Assert
        expect(sut).toBe(expected);
      });
    });
  });

  describe('Given parseRebaseTodo', () => {
    describe('When given well-formed todo text', () => {
      it.each([
        {
          label:
            "git's abbreviated-oid output extracts the raw oid token and subject (resolution deferred to the caller)",
          text: 'pick f4cb28d # c1\npick 0a4f2a3 # c2\n',
          expected: [pick('f4cb28d', 'c1'), pick('0a4f2a3', 'c2')],
        },
        {
          label: 'the interactive verbs parse into their action',
          text: 'reword aaaaaaa # r\nedit bbbbbbb # e\nsquash ccccccc # s\nfixup ddddddd # f\ndrop eeeeeee # d\n',
          expected: [
            { action: 'reword', oid: 'aaaaaaa', subject: 'r' },
            { action: 'edit', oid: 'bbbbbbb', subject: 'e' },
            { action: 'squash', oid: 'ccccccc', subject: 's' },
            { action: 'fixup', oid: 'ddddddd', subject: 'f' },
            { action: 'drop', oid: 'eeeeeee', subject: 'd' },
          ],
        },
        {
          label: 'the backup blank and comment lines are skipped',
          text: 'pick aaaaaaa # one\n\n# Rebase abc..def onto abc (2 commands)\n#\n# Commands:\npick bbbbbbb # two\n',
          expected: [pick('aaaaaaa', 'one'), pick('bbbbbbb', 'two')],
        },
        {
          label: 'a literal # after the separator keeps the whole remainder as the subject',
          text: 'pick aaaaaaa # fix #42 in parser\n',
          expected: [pick('aaaaaaa', 'fix #42 in parser')],
        },
        {
          label: 'an empty subject parses to an empty string',
          text: 'pick aaaaaaa # \n',
          expected: [pick('aaaaaaa', '')],
        },
      ])('Then $label', ({ text, expected }) => {
        // Arrange + Act
        const sut = parseRebaseTodo(text);

        // Assert
        expect(sut).toEqual(expected);
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
