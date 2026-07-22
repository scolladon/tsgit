import { invalidOption } from '../commands/error.js';

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

function latin1Decode(line: Uint8Array): string {
  let s = '';
  for (const b of line) s += String.fromCharCode(b);
  return s;
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
