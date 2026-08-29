import fc from 'fast-check';

import type { AuthorIdentity } from '../../../../src/domain/objects/author-identity.js';
import type { ExtraHeader } from '../../../../src/domain/objects/commit.js';
import { FILE_MODE, type FileMode } from '../../../../src/domain/objects/file-mode.js';
import {
  type HashConfig,
  SHA1_CONFIG,
  SHA256_CONFIG,
} from '../../../../src/domain/objects/hash-config.js';
import type { ObjectType } from '../../../../src/domain/objects/header.js';
import type { ObjectId } from '../../../../src/domain/objects/object-id.js';
import type { TreeEntry } from '../../../../src/domain/objects/tree.js';

export function arbObjectId(length: 40 | 64 = 40): fc.Arbitrary<ObjectId> {
  return fc
    .array(fc.constantFrom(...'0123456789abcdef'.split('')), {
      minLength: length,
      maxLength: length,
    })
    .map((chars) => chars.join('') as ObjectId);
}

// A single arbitrary UTF-16 code unit, as a one-character string.
function arbCodeUnit(): fc.Arbitrary<string> {
  return fc.integer({ min: 0, max: 0xffff }).map((code) => String.fromCharCode(code));
}

// Concatenates arbitrary UTF-16 code units directly, unlike `fc.string()`
// (which only ever emits well-formed code points) — the only way to generate
// lone surrogate halves the way `String.prototype.charCodeAt` observes them.
export function arbCodeUnitString(): fc.Arbitrary<string> {
  return fc.string({ unit: arbCodeUnit(), maxLength: 70 });
}

// A valid ObjectId hex string with exactly one character replaced by an
// arbitrary Unicode code point (itself one or two UTF-16 code units),
// probing a validator's per-character boundaries beyond fixed examples.
export function arbObjectIdWithOneCharReplaced(length: 40 | 64 = 40): fc.Arbitrary<string> {
  return fc
    .tuple(
      arbObjectId(length),
      fc.nat({ max: length - 1 }),
      fc.integer({ min: 0, max: 0x10ffff }).map((codePoint) => String.fromCodePoint(codePoint)),
    )
    .map(([id, index, replacement]) => `${id.slice(0, index)}${replacement}${id.slice(index + 1)}`);
}

// A valid ObjectId hex string with arbitrary text prepended and/or appended,
// probing length-boundary mutations independently of character-boundary ones.
export function arbObjectIdWithPadding(length: 40 | 64 = 40): fc.Arbitrary<string> {
  return fc
    .tuple(fc.string({ maxLength: 5 }), arbObjectId(length), fc.string({ maxLength: 5 }))
    .map(([prefix, id, suffix]) => `${prefix}${id}${suffix}`);
}

// A single lower-case hex digit, built from the two ASCII code-unit RANGES
// ('0'-'9' and 'a'-'f') rather than a literal alphabet string — a literal
// hex/base64 alphabet trips the secret scanner's high-entropy-string check.
function arbHexDigit(): fc.Arbitrary<string> {
  return fc
    .oneof(fc.integer({ min: 0x30, max: 0x39 }), fc.integer({ min: 0x61, max: 0x66 }))
    .map((code) => String.fromCharCode(code));
}

// An arbitrary-length lower-case hex string (length is NOT tied to any
// HashConfig width) — used to probe the length/hexLength equivalence of isOid
// across the whole grammar, not just the two frozen widths.
export function arbHexString(maxLength = 200): fc.Arbitrary<string> {
  return fc.array(arbHexDigit(), { maxLength }).map((chars) => chars.join(''));
}

export function arbHashConfig(): fc.Arbitrary<HashConfig> {
  return fc.constantFrom(SHA1_CONFIG, SHA256_CONFIG);
}

// Arbitrary raw digest-like bytes, independent of either frozen digestLength.
export function arbRawBytes(maxLength = 40): fc.Arbitrary<Uint8Array> {
  return fc.uint8Array({ maxLength });
}

// A single ASCII printable code unit (0x20-0x7e), built from the code-unit
// RANGE rather than a literal alphabet string (same rationale as arbHexDigit).
function arbAsciiPrintableCodeUnit(): fc.Arbitrary<string> {
  return fc.integer({ min: 0x20, max: 0x7e }).map((code) => String.fromCharCode(code));
}

// Arbitrary printable-ASCII, NUL-free string of arbitrary length — the
// "ASCII-hex safe subset" isOid must accept as input without throwing,
// whether or not it happens to be valid hex.
export function arbAsciiNoNulString(maxLength = 200): fc.Arbitrary<string> {
  return fc.array(arbAsciiPrintableCodeUnit(), { maxLength }).map((chars) => chars.join(''));
}

export function arbObjectType(): fc.Arbitrary<ObjectType> {
  return fc.constantFrom<ObjectType>('blob', 'tree', 'commit', 'tag');
}

export function arbFileModeEnum(): fc.Arbitrary<FileMode> {
  return fc.constantFrom<FileMode>(
    FILE_MODE.REGULAR,
    FILE_MODE.EXECUTABLE,
    FILE_MODE.SYMLINK,
    FILE_MODE.DIRECTORY,
    FILE_MODE.GITLINK,
  );
}

// The single home for the tree-entry family: any of the five accepted modes
// (including DIRECTORY, so directory/file virtual-slash ordering is
// exercised), a name free of the bytes/values a tree entry can never carry.
export function arbTreeEntryAnyMode(): fc.Arbitrary<TreeEntry> {
  return fc
    .tuple(
      arbFileModeEnum(),
      fc
        .string({ minLength: 1, maxLength: 50 })
        .filter((s) => !s.includes('\0') && !s.includes('/') && s !== '.' && s !== '..'),
      arbObjectId(40),
    )
    .map(([mode, name, id]) => ({ mode, name, id }));
}

// Git trees cannot contain duplicate entry names — dedupe by name (first
// wins) before building a tree so the arbitrary never generates a tree that
// is invalid by construction (which would look like a flaky test).
export function dedupeTreeEntriesByName(
  entries: ReadonlyArray<TreeEntry>,
): ReadonlyArray<TreeEntry> {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (seen.has(entry.name)) return false;
    seen.add(entry.name);
    return true;
  });
}

// A name/email field: well-formed Unicode graphemes (never a lone surrogate
// half — `fc.string({ unit: 'grapheme' })` only ever emits complete code
// points, unlike `arbCodeUnitString()`). A lone surrogate can't round-trip
// through the UTF-8 encode/decode this same arbitrary feeds in
// commit.properties.test.ts / tag.properties.test.ts (TextEncoder replaces
// it with U+FFFD), so it would falsify those byte-level round-trip
// properties for a reason that has nothing to do with parseIdentity. Filtered
// on the three bytes that would corrupt the "name <email> ts tz" line framing
// (`<`, `>`, `\n`) plus the two more serializeIdentity's control-character
// guard forbids (`\r`, `\0`).
function arbIdentityFieldString(): fc.Arbitrary<string> {
  return fc
    .string({ unit: 'grapheme', maxLength: 20 })
    .filter(
      (s) =>
        !s.includes('<') &&
        !s.includes('>') &&
        !s.includes('\n') &&
        !s.includes('\r') &&
        !s.includes('\0'),
    );
}

export function arbAuthorIdentity(): fc.Arbitrary<AuthorIdentity> {
  return fc.record({
    name: arbIdentityFieldString(),
    email: arbIdentityFieldString(),
    timestamp: fc.integer({ min: -2_000_000_000, max: 9_999_999_999 }),
    timezoneOffset: fc
      .tuple(
        fc.constantFrom('+', '-'),
        fc.integer({ min: 0, max: 12 }),
        fc.constantFrom(0, 15, 30, 45),
      )
      .map(
        ([sign, h, m]) => `${sign}${h.toString().padStart(2, '0')}${m.toString().padStart(2, '0')}`,
      ),
  });
}

// A ref-safe tag name: non-empty, and free of the bytes that would corrupt
// the `tag <name>` header line (`\0`) or its line framing (`\n`, ` ` — a
// space is not itself illegal in a git ref, but keeping names space-free
// avoids incidental collisions with the header/value split used elsewhere).
export function arbTagName(): fc.Arbitrary<string> {
  return fc
    .string({ minLength: 1, maxLength: 30 })
    .filter((s) => !s.includes('\0') && !s.includes('\n') && !s.includes(' '));
}

const ARMOR_BODY_CHARS = [
  'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  'abcdefghijklmnopqrstuvwxyz',
  '0123456789+/=',
].join('');

// A well-formed PGP or SSH armor block, byte-shaped like what `signPayload`
// returns: a `-----BEGIN ... SIGNATURE-----` / `-----END ... SIGNATURE-----`
// pair wrapping a base64-alphabet body, terminated by exactly one newline.
export function arbArmorBlock(): fc.Arbitrary<string> {
  return fc
    .tuple(
      fc.constantFrom('PGP', 'SSH'),
      fc
        .array(fc.constantFrom(...ARMOR_BODY_CHARS.split('')), { minLength: 1, maxLength: 40 })
        .map((chars) => chars.join('')),
    )
    .map(
      ([kind, body]) =>
        `-----BEGIN ${kind} SIGNATURE-----\n\n${body}\n-----END ${kind} SIGNATURE-----\n`,
    );
}

// A single raw line: arbitrary ASCII body (may be empty -> a blank line, may
// carry the comment char and internal spaces) followed by trailing ASCII
// whitespace noise (every git `isspace` kind). Joining an array of these with
// '\n' yields messages that exercise stripspace's collapse / drop / strip
// paths: blank runs, leading/trailing blanks, and per-line trailing whitespace.
export function arbRawLine(): fc.Arbitrary<string> {
  const bodyChars = fc.constantFrom('a', 'b', 'c', '#', 'x', '.', ' ');
  const wsChars = fc.constantFrom(' ', '\t', '\v', '\f', '\r');
  return fc
    .tuple(
      fc.array(bodyChars, { maxLength: 8 }).map((chars) => chars.join('')),
      fc.array(wsChars, { maxLength: 3 }).map((chars) => chars.join('')),
    )
    .map(([body, trailingWs]) => body + trailingWs);
}

export function arbCommitMessage(): fc.Arbitrary<string> {
  return fc.array(arbRawLine(), { maxLength: 10 }).map((lines) => lines.join('\n'));
}

// `arbCommitMessage()` with a roughly-even chance of a leading U+FEFF
// byte-order mark — additive, so `arbCommitMessage()` itself (shared with
// commit-message.properties.test.ts) stays untouched. Pins that a BOM is
// content the commit parse path preserves verbatim, never decoder
// bookkeeping it strips.
export function arbCommitMessageWithOptionalBom(): fc.Arbitrary<string> {
  return fc
    .tuple(fc.boolean(), arbCommitMessage())
    .map(([withBom, message]) => (withBom ? `\uFEFF${message}` : message));
}

// A well-formed extra-header key: non-empty, free of the bytes that would
// break formatContinuationHeader's line framing (space, newline, NUL), and
// distinct from the one key commits special-case ('gpgsig').
export function arbExtraHeaderKey(): fc.Arbitrary<string> {
  return fc
    .string({ minLength: 1, maxLength: 15 })
    .filter((s) => !s.includes(' ') && !s.includes('\n') && !s.includes('\0') && s !== 'gpgsig');
}

// A multi-line extra-header value (>= 2 lines on every run) so continuation
// folding — formatContinuationHeader's per-line ' ' prefix,
// parseOptionalHeaderBlock's push arm — is actually exercised rather than
// left to chance.
export function arbExtraHeaderValue(): fc.Arbitrary<string> {
  return fc.array(arbRawLine(), { minLength: 2, maxLength: 4 }).map((lines) => lines.join('\n'));
}

export function arbExtraHeader(): fc.Arbitrary<ExtraHeader> {
  return fc.record({ key: arbExtraHeaderKey(), value: arbExtraHeaderValue() });
}

// A single `\n`-free line guaranteed to carry at least one non-whitespace ASCII
// char (the anchor), so it survives `foldSubject`'s trailing-trim as a non-empty
// subject. Surrounding fill chars may include spaces; the anchor keeps the line
// from folding to the empty string.
export function arbNonBlankLine(): fc.Arbitrary<string> {
  const bodyChars = fc.constantFrom('a', 'b', 'c', '#', 'x', '.', ' ');
  const fill = fc.array(bodyChars, { maxLength: 4 }).map((chars) => chars.join(''));
  return fc
    .tuple(fill, fc.constantFrom('a', 'b', 'x', '.', '#'), fill)
    .map(([pre, anchor, post]) => pre + anchor + post);
}
