import fc from 'fast-check';

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
