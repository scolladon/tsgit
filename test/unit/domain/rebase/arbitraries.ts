import fc from 'fast-check';
import type { AuthorIdentity, RebaseTodoEntry } from '../../../../src/domain/rebase/index.js';

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

// Identity charset includes the single quote (the char sq_quote must escape) and
// a backslash, but excludes LF/CR/NUL (which a commit's author line cannot carry
// and which would break the line-based author-script parse).
const IDENTITY_CHARS = "abcXYZ0123 .-_@'\\".split('');
const TZ_OFFSETS = ['+0000', '-0530', '+0900', '-0800', '+0100'];

const arbIdentityText = (): fc.Arbitrary<string> =>
  fc
    .array(fc.constantFrom(...IDENTITY_CHARS), { minLength: 0, maxLength: 30 })
    .map((a) => a.join(''));

export const arbAuthorIdentity = (): fc.Arbitrary<AuthorIdentity> =>
  fc.record({
    name: arbIdentityText(),
    email: arbIdentityText(),
    timestamp: fc.integer({ min: 0, max: 2_000_000_000 }),
    timezoneOffset: fc.constantFrom(...TZ_OFFSETS),
  });
