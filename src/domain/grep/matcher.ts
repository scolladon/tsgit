import { grepLineTooLong, invalidOption } from '../commands/error.js';
import { MAX_STRING_LENGTH } from '../engine-limits.js';

export interface MatchSpan {
  readonly start: number;
  readonly end: number;
}

export interface GrepFixedPattern {
  readonly fixed: string;
}

export type GrepPattern = RegExp | GrepFixedPattern;

export interface LineVerdict {
  readonly returned: boolean;
  readonly spans: ReadonlyArray<MatchSpan>;
}

export interface GrepMatcherOptions {
  readonly wholeWord?: boolean;
  readonly invert?: boolean;
}

export interface GrepMatcher {
  matchLine(line: Uint8Array): LineVerdict;
}

const WORD_BYTE_MIN_UPPER = 0x41; // A
const WORD_BYTE_MAX_UPPER = 0x5a; // Z
const WORD_BYTE_MIN_LOWER = 0x61; // a
const WORD_BYTE_MAX_LOWER = 0x7a; // z
const WORD_BYTE_MIN_DIGIT = 0x30; // 0
const WORD_BYTE_MAX_DIGIT = 0x39; // 9
const WORD_BYTE_UNDERSCORE = 0x5f; // _

function isWordByte(b: number): boolean {
  return (
    (b >= WORD_BYTE_MIN_UPPER && b <= WORD_BYTE_MAX_UPPER) ||
    (b >= WORD_BYTE_MIN_LOWER && b <= WORD_BYTE_MAX_LOWER) ||
    (b >= WORD_BYTE_MIN_DIGIT && b <= WORD_BYTE_MAX_DIGIT) ||
    b === WORD_BYTE_UNDERSCORE
  );
}

/**
 * The engine's string ceiling, in the unit a line is counted in: `latin1Decode`
 * builds one code unit per byte, so bytes and code units are the same number
 * here and a line past this many bytes cannot be decoded for RegExp matching at
 * all. Fixed-string patterns never reach this — `fixedSpans` matches on raw
 * bytes, with no decode.
 */
export const MAX_DECODABLE_LINE_BYTES = MAX_STRING_LENGTH;

/** Refuses a line whose bytes cannot be decoded to a string for RegExp matching. */
export function assertLineDecodable(byteLength: number): void {
  if (byteLength > MAX_DECODABLE_LINE_BYTES) {
    throw grepLineTooLong(byteLength, MAX_DECODABLE_LINE_BYTES);
  }
}

/**
 * Code units built per `String.fromCharCode` call — comfortably under every
 * engine's argument-count ceiling, so no line length can overflow the call.
 */
const LATIN1_DECODE_CHUNK = 8_192;

/**
 * One code unit per byte, built a chunk at a time and joined once. The obvious
 * `s += String.fromCharCode(b)` per byte is what the refusal above exists to
 * bound, and it defeats it: appending byte by byte builds a rope whose peak
 * heap runs to many times the line's own length, so lines well under the
 * refusal threshold exhaust memory and abort the process instead of returning
 * the structured refusal. Chunking keeps the peak proportional to the result.
 *
 * `TextDecoder('latin1')` is NOT a substitute: the Encoding Standard aliases
 * that label to windows-1252, which remaps 0x80–0x9F to other code points —
 * the spans this returns would no longer be byte offsets.
 */
function latin1Decode(line: Uint8Array): string {
  assertLineDecodable(line.length);
  const parts: string[] = [];
  // NOTE: this line's EqualityOperator mutant relaxing `<` to `<=` is equivalent: the extra iteration it admits starts at i === line.length, where `subarray(i, i + LATIN1_DECODE_CHUNK)` is empty and `String.fromCharCode()` returns '' — an empty part cannot change `parts.join('')`, at a length that is an exact multiple of the chunk or at zero alike. Left unannotated because the sibling `>=` variant on this same line is a real, killed mutant, and Stryker's next-line disable can't distinguish variant from variant of the same mutator.
  for (let i = 0; i < line.length; i += LATIN1_DECODE_CHUNK) {
    parts.push(String.fromCharCode(...line.subarray(i, i + LATIN1_DECODE_CHUNK)));
  }
  return parts.join('');
}

function regexSpans(line: Uint8Array, clone: RegExp): ReadonlyArray<MatchSpan> {
  const s = latin1Decode(line);
  const spans: MatchSpan[] = [];
  clone.lastIndex = 0;
  let m = clone.exec(s);
  while (m !== null) {
    spans.push({ start: m.index, end: m.index + m[0].length });
    if (m[0].length === 0) clone.lastIndex++;
    m = clone.exec(s);
  }
  return spans;
}

function fixedSpans(line: Uint8Array, needle: Uint8Array): ReadonlyArray<MatchSpan> {
  if (needle.length === 0) return [];
  const spans: MatchSpan[] = [];
  let from = 0;
  // Stryker disable next-line ArithmeticOperator: equivalent — `+` widens the scan past line end where line[from+j] reads undefined ≠ needle[j], so the inner loop always fails and no extra span is pushed
  outer: while (from <= line.length - needle.length) {
    for (let j = 0; j < needle.length; j++) {
      if (line[from + j] !== needle[j]) {
        from++;
        continue outer;
      }
    }
    spans.push({ start: from, end: from + needle.length });
    from += needle.length;
  }
  return spans;
}

function applyWholeWord(
  spans: ReadonlyArray<MatchSpan>,
  line: Uint8Array,
): ReadonlyArray<MatchSpan> {
  return spans.filter((span) => {
    const leftByte = line[span.start - 1];
    const rightByte = line[span.end];
    // equivalent-mutant(id=225): `span.start === 0` → `false` — when start=0, line[-1]=undefined, leftByte===undefined short-circuits, leftOk=true regardless
    const leftOk = span.start === 0 || leftByte === undefined || !isWordByte(leftByte);
    // equivalent-mutant(id=235): `span.end >= line.length` → `false` — when end≥length, line[end]=undefined, rightByte===undefined catches it, rightOk=true regardless
    // equivalent-mutant(id=236): `span.end >= line.length` → `span.end > line.length` — when end===length exactly, line[length]=undefined, same undefined-check outcome
    const rightOk = span.end >= line.length || rightByte === undefined || !isWordByte(rightByte);
    return leftOk && rightOk;
  });
}

function unionSpans(allSpans: ReadonlyArray<ReadonlyArray<MatchSpan>>): ReadonlyArray<MatchSpan> {
  const seen = new Set<string>();
  const merged: MatchSpan[] = [];
  for (const spans of allSpans) {
    for (const s of spans) {
      const key = `${s.start}:${s.end}`;
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(s);
      }
    }
  }
  return merged.sort((a, b) => a.start - b.start || a.end - b.end);
}

// git matches each line WITHOUT its trailing newline — the line terminator is not part
// of the searched content, so `$` anchors at end-of-line. splitLines keeps the LF, so
// strip a single trailing LF for the match view. A `\r` before the LF is kept, matching
// git (on CRLF lines `$` sits after the `\r`).
function stripTrailingNewline(line: Uint8Array): Uint8Array {
  const LF = 0x0a;
  // `line[-1]` on an empty line is undefined (≠ LF), so no length guard is needed.
  return line[line.length - 1] === LF ? line.subarray(0, line.length - 1) : line;
}

export function buildGrepMatcher(
  patterns: ReadonlyArray<GrepPattern>,
  options?: GrepMatcherOptions,
): GrepMatcher {
  const wholeWord = options?.wholeWord ?? false;
  const invert = options?.invert ?? false;

  const clones: Array<{ type: 'regex'; clone: RegExp } | { type: 'fixed'; needle: Uint8Array }> =
    patterns.map((p) => {
      if (p instanceof RegExp) {
        if (p.flags.includes('u')) {
          throw invalidOption('pattern', 'unicode flag unsupported over byte content');
        }
        const flags = p.flags.replace('y', '') + (p.flags.includes('g') ? '' : 'g');
        return { type: 'regex', clone: new RegExp(p.source, flags) };
      }
      return { type: 'fixed', needle: new TextEncoder().encode(p.fixed) };
    });

  return {
    matchLine(line: Uint8Array): LineVerdict {
      const content = stripTrailingNewline(line);
      const perPattern: ReadonlyArray<MatchSpan>[] = clones.map((entry) => {
        const raw =
          entry.type === 'regex'
            ? regexSpans(content, entry.clone)
            : fixedSpans(content, entry.needle);
        return wholeWord ? applyWholeWord(raw, content) : raw;
      });

      const spans = unionSpans(perPattern);

      if (invert) {
        return { returned: spans.length === 0, spans: [] };
      }
      return { returned: spans.length > 0, spans };
    },
  };
}
