import fc from 'fast-check';
import type { TodoEntry } from '../../../../src/domain/sequencer/index.js';

const HEX = '0123456789abcdef'.split('');
// Subject charset deliberately excludes LF/CR (single-line subjects) and keeps a
// mix of word/space/punctuation so the round-trip exercises the space-separator.
const SUBJECT_CHARS = 'abcXYZ0123 #.-_/()'.split('');

export const arbOid = (): fc.Arbitrary<string> =>
  fc.array(fc.constantFrom(...HEX), { minLength: 4, maxLength: 40 }).map((a) => a.join(''));

export const arbSubject = (): fc.Arbitrary<string> =>
  fc
    .array(fc.constantFrom(...SUBJECT_CHARS), { minLength: 0, maxLength: 40 })
    .map((a) => a.join(''));

export const arbTodoEntry = (): fc.Arbitrary<TodoEntry> =>
  fc.record({
    command: fc.constant<'pick'>('pick'),
    oid: arbOid(),
    subject: arbSubject(),
  });

export const arbTodoList = (): fc.Arbitrary<ReadonlyArray<TodoEntry>> =>
  fc.array(arbTodoEntry(), { maxLength: 12 });
