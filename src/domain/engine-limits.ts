/**
 * Limits the JavaScript engine imposes, as opposed to anything this library
 * chooses. They are expressed exactly rather than rounded: below them a value
 * can be built, above them it cannot, and there is no policy to tune.
 */

/**
 * V8's maximum string length on 64-bit builds (2^29 - 24 UTF-16 code units).
 * Past it, materialising a string throws a bare `RangeError: Invalid string
 * length` — a runtime error with no code and nothing a caller can branch on.
 *
 * One fact, so one declaration: every refusal built on it states only its own
 * LOCAL reason — what it was about to materialise, and what it refuses instead
 * of crashing — and shares this number rather than restating it.
 */
export const MAX_STRING_LENGTH = 536_870_888;
