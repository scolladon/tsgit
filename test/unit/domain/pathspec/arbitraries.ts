import fc from 'fast-check';

import { FilePath } from '../../../../src/domain/objects/index.js';

// Pathspec pattern bodies must not start with `!` (that's handled by the
// negation parser) or `/` (Git rejects leading slash in pathspecs). They
// must not contain NUL. The body alphabet here is intentionally narrow so
// generated paths stay inside the validator's accepted grammar; the
// pathspec compiler itself is total over ASCII without `*`/`?`/`/`.
const LITERAL_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789-_.'.split('');

const arbSegment = (): fc.Arbitrary<string> =>
  fc
    .array(fc.constantFrom(...LITERAL_CHARS), { minLength: 1, maxLength: 8 })
    .map((chars) => chars.join(''))
    .filter((s) => s !== '.' && s !== '..');

export const arbLiteralPattern = (): fc.Arbitrary<string> => arbSegment();

const arbGlobToken = (): fc.Arbitrary<string> => fc.constantFrom('*', '?', '**');

// A glob body is at least one glob metacharacter mixed with literal segments,
// e.g. `*.ts`, `src/**`, `?-name`. We intersperse glob tokens between two
// literal halves and discard pathological forms (leading slash, empty).
export const arbGlobPattern = (): fc.Arbitrary<string> =>
  fc
    .tuple(arbSegment(), arbGlobToken(), arbSegment())
    .map(([prefix, glob, suffix]) => `${prefix}${glob}${suffix}`);

export const arbCandidatePath = (): fc.Arbitrary<FilePath> =>
  fc
    .array(arbSegment(), { minLength: 1, maxLength: 4 })
    .map((segments) => FilePath.from(segments.join('/')));

const GLOB_BODY_CHARS = ['a', 'b', '/', 'é', '*', '?', '[', ']', '\\', '!', '^', '-', ':'];
const PATH_CHARS = ['a', 'b', '/', 'é', '\uDC80', '\uDCFF'];
const PLAIN_BODY_CHARS = ['a', 'b', '/', 'é', ']', '!', '^', '-', ':'];

const arbChars = (chars: ReadonlyArray<string>, maxLength: number): fc.Arbitrary<string> =>
  fc.array(fc.constantFrom(...chars), { maxLength }).map((picked) => picked.join(''));

// Bodies over every character the glob grammar treats specially, so brackets,
// escapes and stars appear in arbitrary combinations (valid and malformed).
export const arbGlobBody = (): fc.Arbitrary<string> => arbChars(GLOB_BODY_CHARS, 8);

// Exactly one `*` and none of `? [ \`, which is the shape the string fast path decides.
export const arbOneStarBody = (): fc.Arbitrary<string> =>
  fc
    .tuple(arbChars(PLAIN_BODY_CHARS, 4), arbChars(PLAIN_BODY_CHARS, 4))
    .map(([prefix, suffix]) => `${prefix}*${suffix}`);

// A path in the escape view: valid text plus lone low surrogates standing for raw bytes.
export const arbEscapedPath = (): fc.Arbitrary<string> => arbChars(PATH_CHARS, 8);

const FOLD_BODY_UNITS = [
  '[',
  ']',
  '!',
  '^',
  '-',
  ':',
  '\\',
  '*',
  '?',
  '/',
  'a',
  'A',
  'b',
  'B',
  '[:upper:]',
  '[:alpha:]',
  '[:digit:]',
  '[:foo:]',
];
const FOLD_PATH_UNITS = ['a', 'A', 'b', 'B', '/', '-', ']', '[', '!', ':', '\\', 'é'];
const SET_MEMBERS = ['a', 'b', 'c', 'A', '0', '9', 'a-c', '[:digit:]'];

// Few distinct units so pattern bytes collide with path bytes; the multi-byte
// units are the literal class names, so well-formed and malformed sets both occur.
export const arbFoldGlobBody = (): fc.Arbitrary<string> => arbChars(FOLD_BODY_UNITS, 8);

export const arbFoldPath = (): fc.Arbitrary<string> => arbChars(FOLD_PATH_UNITS, 6);

// A well-formed set body: never starts with `!`, `^` or `]`, holds no `\` or `/`.
export const arbBracketMembers = (): fc.Arbitrary<string> =>
  fc.array(fc.constantFrom(...SET_MEMBERS), { minLength: 1, maxLength: 6 }).map((m) => m.join(''));

// Every character of arbGlobBody but the escape, so no byte before an appended `[` is escaped.
export const arbUnbracketedBody = (): fc.Arbitrary<string> =>
  arbChars(
    GLOB_BODY_CHARS.filter((c) => c !== '\\'),
    8,
  );

const DERIVED_PATH_UNITS = [
  'a',
  'A',
  'b',
  'B',
  '/',
  '-',
  ']',
  '[',
  '!',
  '^',
  ':',
  '\\',
  'é',
  'z',
  '5',
  '_',
  ' ',
  '.',
];
const SLASH_FRAGMENTS = ['/', '\\/'];

// What one path character may become in a pattern: fragments that admit it
// (an escape, `?`, `*`, a set, a range or a class holding it) and a few that
// refuse it, so escapes, stars and sets mix in one pattern.
const fragmentsFor = (unit: string): ReadonlyArray<string> => {
  if (unit === '/') return SLASH_FRAGMENTS;
  const escaped = `\\${unit}`;
  return [
    escaped,
    escaped,
    '?',
    '*',
    `[${escaped}]`,
    `[${escaped}-${escaped}]`,
    `[${escaped}-z]`,
    `[[:alpha:]${escaped}]`,
    `[[:upper:]${escaped}]`,
    `[!${escaped}]`,
    '[^[:punct:]]',
  ];
};

export const arbDerivedPath = (): fc.Arbitrary<string> => arbChars(DERIVED_PATH_UNITS, 6);

/** A path and a pattern built from it one character at a time, so the pattern often matches it. */
export const arbPathWithDerivedPattern = (): fc.Arbitrary<{
  readonly path: string;
  readonly pattern: string;
}> =>
  fc
    .array(fc.constantFrom(...DERIVED_PATH_UNITS), { minLength: 1, maxLength: 6 })
    .chain((units) =>
      fc
        .tuple(...units.map((unit) => fc.constantFrom(...fragmentsFor(unit))))
        .map((fragments) => ({ path: units.join(''), pattern: fragments.join('') })),
    );
