import fc from 'fast-check';

import type { AuthorIdentity } from '../../../../src/domain/objects/author-identity.js';
import { FILE_MODE, type FileMode } from '../../../../src/domain/objects/file-mode.js';
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

export function arbAuthorIdentity(): fc.Arbitrary<AuthorIdentity> {
  return fc.record({
    name: fc
      .string({ maxLength: 20 })
      .filter((s) => !s.includes('<') && !s.includes('>') && !s.includes('\n')),
    email: fc
      .string({ maxLength: 20 })
      .filter((s) => !s.includes('<') && !s.includes('>') && !s.includes(' ') && !s.includes('\n')),
    timestamp: fc.integer({ min: 0, max: 9999999999 }),
    timezoneOffset: fc
      .tuple(fc.constantFrom('+', '-'), fc.integer({ min: 0, max: 12 }), fc.constantFrom(0, 30))
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
function arbRawLine(): fc.Arbitrary<string> {
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
