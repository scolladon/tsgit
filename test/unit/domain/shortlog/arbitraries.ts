import fc from 'fast-check';

import type { ObjectId } from '../../../../src/domain/objects/index.js';
import type { ShortlogEntry } from '../../../../src/domain/shortlog/group.js';

// A raw line: arbitrary ASCII body (may be empty -> blank line) plus trailing
// ASCII whitespace noise (every git `isspace` kind). Joined with '\n' these
// exercise fold's leading-blank skip, blank-after-content stop, and per-line
// trailing strip.
function arbRawLine(): fc.Arbitrary<string> {
  const bodyChars = fc.constantFrom('a', 'b', ' ', '[', ']', 'P', 'A', 'T', 'C', 'H', '#');
  const wsChars = fc.constantFrom(' ', '\t', '\v', '\f', '\r');
  return fc
    .tuple(
      fc.array(bodyChars, { maxLength: 10 }).map((chars) => chars.join('')),
      fc.array(wsChars, { maxLength: 3 }).map((chars) => chars.join('')),
    )
    .map(([body, ws]) => body + ws);
}

// A message that may carry a leading bracket token (PATCH-like or not) so the
// `[PATCH` strip branch is exercised, followed by arbitrary lines.
export function arbShortlogMessage(): fc.Arbitrary<string> {
  const prefix = fc.constantFrom('', '[PATCH] ', '[PATCH v2] ', '[BUGFIX] ', '[patch] ', '[PATCH');
  const lines = fc.array(arbRawLine(), { maxLength: 6 }).map((parts) => parts.join('\n'));
  return fc.tuple(prefix, lines).map(([p, rest]) => p + rest);
}

const arbName = fc.constantFrom('Ann', 'Bob', 'ann', 'Été', '\u{10000}z', '＀z');
const arbEmail = fc.constantFrom('a@x', 'b@x', 'a@y');

function arbEntry(): fc.Arbitrary<ShortlogEntry> {
  return fc
    .tuple(
      arbName,
      arbEmail,
      fc.constantFrom(...'0123456789abcdef'.split('')).map((c) => c.repeat(40) as ObjectId),
      fc.string({ maxLength: 12 }),
    )
    .map(([name, email, id, subject]) => ({ name, email, id, subject }));
}

export function arbShortlogEntries(): fc.Arbitrary<ReadonlyArray<ShortlogEntry>> {
  return fc.array(arbEntry(), { maxLength: 20 });
}
