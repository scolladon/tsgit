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
import { invalidDiffInput } from './error.js';

/**
 * V8's maximum string length on 64-bit builds (2^29 - 24 characters). It is an
 * engine limit rather than a policy choice, so it is expressed exactly rather
 * than rounded: everything below it renders, nothing above it can.
 */
export const MAX_PATCH_TEXT_CHARS = 536_870_888;

/** Refuses a patch that could not be materialised as one string. */
export function assertPatchTextFits(chars: number): void {
  if (chars > MAX_PATCH_TEXT_CHARS) {
    throw invalidDiffInput(
      `rendered patch is ${chars} characters; the maximum is ${MAX_PATCH_TEXT_CHARS}`,
    );
  }
}
