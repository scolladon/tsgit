/**
 * git's default hunk section-heading detection (`def_ff` + `get_func_line` in
 * `xdiff/xemit.c`), the heading appended to `@@` lines when no userdiff driver is
 * configured. A line is a "function line" when its first byte is an identifier
 * start (`[A-Za-z_$]`); the heading is that line, trailing-whitespace-stripped,
 * capped at 80 bytes. The hunk's heading is the nearest such line at or before
 * the hunk, scanned backward through the **old** file.
 */

/** git's `func_line.buf` size — the heading byte cap. */
const FUNCNAME_MAX_BYTES = 80;

const decoder = new TextDecoder('utf-8', { fatal: false });

/** C `isalpha` under the C locale (ASCII letters) plus `_` and `$`. */
const isIdentifierStart = (byte: number): boolean =>
  (byte >= 0x41 && byte <= 0x5a) ||
  (byte >= 0x61 && byte <= 0x7a) ||
  byte === 0x5f ||
  byte === 0x24;

/** C `isspace` under the C locale: space, `\t`, `\n`, `\v`, `\f`, `\r`. */
const isSpace = (byte: number): boolean => byte === 0x20 || (byte >= 0x09 && byte <= 0x0d);

/**
 * git's `def_ff`: the heading for `line` if it begins with an identifier byte —
 * the first ≤80 bytes, trailing whitespace stripped — else `undefined`.
 */
export const matchFuncRec = (line: Uint8Array): string | undefined => {
  // Stryker disable next-line ConditionalExpression: equivalent — an empty line makes line[0] undefined and isIdentifierStart(undefined) false, so the second clause already returns undefined; the length check is only a fast-path.
  if (line.length === 0 || !isIdentifierStart(line[0]!)) return undefined;
  let len = Math.min(line.length, FUNCNAME_MAX_BYTES);
  // Stryker disable next-line ConditionalExpression,EqualityOperator: equivalent — line[0] is a non-space identifier byte, so the scan always stops at len === 1; the len > 0 bound is never the exit condition.
  while (len > 0 && isSpace(line[len - 1]!)) len--;
  return decoder.decode(line.subarray(0, len));
};

export interface FuncLine {
  readonly index: number;
  readonly heading: string;
}

/**
 * git's `get_func_line`: scan `lines` from `start` toward `limit` (the limit
 * index itself excluded), returning the first function line found, or
 * `undefined`. The step direction follows `start`/`limit` order.
 */
export const findFuncLine = (
  lines: ReadonlyArray<Uint8Array>,
  start: number,
  limit: number,
): FuncLine | undefined => {
  // Stryker disable next-line EqualityOperator: equivalent — when start === limit the loop's l !== limit is false immediately, so the loop never runs and the step direction is unobservable.
  const step = start > limit ? -1 : 1;
  for (let l = start; l !== limit && l >= 0 && l < lines.length; l += step) {
    const heading = matchFuncRec(lines[l]!);
    if (heading !== undefined) return { index: l, heading };
  }
  return undefined;
};
