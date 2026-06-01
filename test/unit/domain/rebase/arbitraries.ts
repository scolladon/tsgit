import fc from 'fast-check';
import type { RebaseTodoEntry } from '../../../../src/domain/rebase/index.js';

const HEX = '0123456789abcdef'.split('');
// Subject charset deliberately excludes LF/CR (single-line subjects) and keeps a
// mix of word/space/punctuation — including `#` — so the round-trip exercises the
// ` # ` separator against subjects that themselves contain a hash.
const SUBJECT_CHARS = 'abcXYZ0123 #.-_/()'.split('');

export const arbOid = (): fc.Arbitrary<string> =>
  fc.array(fc.constantFrom(...HEX), { minLength: 4, maxLength: 40 }).map((a) => a.join(''));

export const arbSubject = (): fc.Arbitrary<string> =>
  fc
    .array(fc.constantFrom(...SUBJECT_CHARS), { minLength: 0, maxLength: 40 })
    .map((a) => a.join(''));

export const arbRebaseTodoEntry = (): fc.Arbitrary<RebaseTodoEntry> =>
  fc.record({ oid: arbOid(), subject: arbSubject() });

export const arbRebaseTodoList = (): fc.Arbitrary<ReadonlyArray<RebaseTodoEntry>> =>
  fc.array(arbRebaseTodoEntry(), { maxLength: 12 });
