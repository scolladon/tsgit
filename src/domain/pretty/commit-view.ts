import { isAsciiSpace } from './ascii.js';

const LINE_FEED = 0x0a;
const NUL = 0x00;
const HEX_ENCODING_LABEL = 'ascii';

/**
 * Offsets-and-bytes view of a raw commit as `pretty.c` reads it. Nothing is decoded: every
 * byte field is a zero-copy slice of the input, cut at the first NUL as git reads a C string.
 */
export interface CommitView {
  /** The commit as git's C-string reads see it, everything from the first NUL dropped. */
  readonly raw: Uint8Array;
  readonly tree: string | undefined;
  readonly parents: ReadonlyArray<string>;
  readonly author: Uint8Array | undefined;
  readonly committer: Uint8Array | undefined;
  readonly encoding: Uint8Array | undefined;
  /** `%B`: everything after the header's blank line. */
  readonly message: Uint8Array;
  /** The subject paragraph's raw lines, blank lines before and after excluded. */
  readonly subject: Uint8Array;
  /** `%b`: from the first non-blank line after the subject paragraph. */
  readonly body: Uint8Array;
}

const encodePrefix = (prefix: string): Uint8Array => new TextEncoder().encode(prefix);

const PREFIXES = {
  tree: encodePrefix('tree '),
  parent: encodePrefix('parent '),
  author: encodePrefix('author '),
  committer: encodePrefix('committer '),
  encoding: encodePrefix('encoding '),
} as const;

const lineEnd = (buf: Uint8Array, from: number): number => {
  const found = buf.indexOf(LINE_FEED, from);
  return found === -1 ? buf.length : found;
};

const hasPrefix = (buf: Uint8Array, at: number, prefix: Uint8Array): boolean =>
  prefix.every((byte, offset) => buf[at + offset] === byte);

const cStringView = (raw: Uint8Array): Uint8Array => {
  const nul = raw.indexOf(NUL);
  return nul === -1 ? raw : raw.subarray(0, nul);
};

const asciiText = (bytes: Uint8Array): string => new TextDecoder(HEX_ENCODING_LABEL).decode(bytes);

interface Line {
  readonly start: number;
  readonly end: number;
}

interface HeaderBlock {
  readonly lines: ReadonlyArray<Line>;
  readonly messageStart: number;
}

/** Lines up to the first empty one, which `parse_commit_header` stops at. */
const headerBlock = (buf: Uint8Array): HeaderBlock => {
  const lines: Line[] = [];
  // Stryker disable next-line EqualityOperator: equivalent — at start === length the extra pass returns messageStart length + 1, and every view cut from past the end is as empty as one cut at length
  for (let start = 0; start < buf.length; ) {
    const end = lineEnd(buf, start);
    if (end === start) return { lines, messageStart: start + 1 };
    lines.push({ start, end });
    start = end + 1;
  }
  return { lines, messageStart: buf.length };
};

const lastValue = (
  buf: Uint8Array,
  lines: ReadonlyArray<Line>,
  prefix: Uint8Array,
): Uint8Array | undefined => {
  const matching = lines.filter((candidate) => hasPrefix(buf, candidate.start, prefix));
  const line = matching[matching.length - 1];
  return line && buf.subarray(line.start + prefix.length, line.end);
};

/** `parse_commit_buffer`: `tree` on the first line, then the contiguous `parent` lines. */
const treeAndParents = (
  buf: Uint8Array,
  lines: ReadonlyArray<Line>,
): Pick<CommitView, 'tree' | 'parents'> => {
  const [first, ...rest] = lines;
  if (!first || !hasPrefix(buf, first.start, PREFIXES.tree))
    return { tree: undefined, parents: [] };
  const isParent = (line: Line): boolean => hasPrefix(buf, line.start, PREFIXES.parent);
  const run = rest.findIndex((line) => !isParent(line));
  const parentLines = run === -1 ? rest : rest.slice(0, run);
  const parents = parentLines.map((line) =>
    asciiText(buf.subarray(line.start + PREFIXES.parent.length, line.end)),
  );
  return { tree: asciiText(buf.subarray(first.start + PREFIXES.tree.length, first.end)), parents };
};

const isBlankLine = (buf: Uint8Array, start: number, end: number): boolean =>
  buf.subarray(start, end).every(isAsciiSpace);

/** git's `skip_blank_lines`: whole whitespace-only lines. */
export const skipBlankLines = (buf: Uint8Array, from: number): number => {
  let start = from;
  // Stryker disable next-line EqualityOperator: equivalent — at start === length the empty line is blank, so the extra pass steps past the end and the loop still returns length
  while (start < buf.length) {
    const end = lineEnd(buf, start);
    if (!isBlankLine(buf, start, end)) return start;
    start = end + 1;
  }
  return buf.length;
};

interface SubjectBounds {
  readonly end: number;
  readonly next: number;
}

/** git's `format_subject` walk: up to the first blank line, which it consumes. */
const subjectBounds = (buf: Uint8Array, from: number): SubjectBounds => {
  let end = from;
  let start = from;
  // Stryker disable next-line EqualityOperator: equivalent — at start === length the empty line is blank and returns next = min(length + 1, length) = length, as the loop exit does
  while (start < buf.length) {
    const lineStop = lineEnd(buf, start);
    const next = Math.min(lineStop + 1, buf.length);
    if (isBlankLine(buf, start, lineStop)) return { end, next };
    end = next;
    start = next;
  }
  return { end, next: buf.length };
};

export const parseCommitView = (raw: Uint8Array): CommitView => {
  const buf = cStringView(raw);
  const { lines, messageStart } = headerBlock(buf);
  const subjectStart = skipBlankLines(buf, messageStart);
  const { end, next } = subjectBounds(buf, subjectStart);
  return {
    raw: buf,
    ...treeAndParents(buf, lines),
    author: lastValue(buf, lines, PREFIXES.author),
    committer: lastValue(buf, lines, PREFIXES.committer),
    encoding: lastValue(buf, lines, PREFIXES.encoding),
    message: buf.subarray(messageStart),
    subject: buf.subarray(subjectStart, end),
    body: buf.subarray(skipBlankLines(buf, next)),
  };
};
