import fc from 'fast-check';

import { FILE_MODE, type FileMode } from '../../../../src/domain/objects/file-mode.js';
import type { ObjectType } from '../../../../src/domain/objects/header.js';
import type { ObjectId } from '../../../../src/domain/objects/object-id.js';

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
