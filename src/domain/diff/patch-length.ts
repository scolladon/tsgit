/**
 * The ceiling on a rendered patch, and the one place it is enforced.
 *
 * Every patch renderer ends by materialising the whole patch as a single JS
 * string. Past the engine's maximum string length that materialisation throws a
 * bare `RangeError: Invalid string length` — a runtime error escaping a public
 * command, with no code, no path and nothing a caller can branch on. Checking
 * the length the renderer has already counted turns it into an ordinary domain
 * refusal at a documented bound.
 */
import { MAX_STRING_LENGTH } from '../engine-limits.js';
import { invalidDiffInput } from './error.js';

/**
 * The engine's string ceiling, in the unit a patch is counted in: one
 * character per rendered character. A patch past it cannot be joined at all,
 * so the renderer refuses instead of dying inside `Array.join`.
 */
export const MAX_PATCH_TEXT_CHARS = MAX_STRING_LENGTH;

/**
 * A rendered line's contribution to the joined patch: its own characters plus
 * the single separator that follows it. Every patch renderer joins on `\n`
 * with a trailing separator, so this — not `line.length` — is the unit the
 * refusal above counts in. One definition, so a renderer counting its own way
 * cannot drift from the bound it is checked against.
 */
export function joinedLineLength(line: string): number {
  return line.length + 1;
}

/**
 * The exact length of `[...lines, ''].join('\n')` — the string a renderer
 * materialises from these lines. Lets a renderer weigh a block BEFORE building
 * it, so an oversized one is refused rather than assembled and then reported.
 */
export function joinedLength(lines: ReadonlyArray<string>): number {
  let total = 0;
  for (const line of lines) total += joinedLineLength(line);
  return total;
}

/**
 * Refuses a patch that could not be materialised as one string.
 *
 * `maxChars` is an internal seam, defaulted to the engine's own ceiling that
 * every production call inherits: a unit test cannot render half a gigabyte of
 * patch text, so without a settable bound neither the refusal nor the character
 * count a renderer feeds it is ever exercised.
 */
export function assertPatchTextFits(chars: number, maxChars: number = MAX_PATCH_TEXT_CHARS): void {
  if (chars > maxChars) {
    throw invalidDiffInput(`rendered patch is ${chars} characters; the maximum is ${maxChars}`);
  }
}
