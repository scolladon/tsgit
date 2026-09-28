import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { LineDiffOptions } from '../../../../src/domain/diff/line-diff.js';
import {
  BINARY_DETECTION_BYTES,
  diffLines,
  diffPresplitLines,
  isBinary,
  MAX_LINE_BYTES,
  splitLines,
} from '../../../../src/domain/diff/line-diff.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

// Historical thresholds only — no production constant binds these values any
// more (isBinary and diffLines both dropped their size-based caps); kept as
// named local fixtures purely to size the rows pinning that removal.
const FORMER_MAX_LINES = 100_000;
const FORMER_MAX_DIFF_LINES = 50_000;
const FORMER_MAX_DIFF_EDIT_DISTANCE = 10_000;

function concatBytes(chunks: ReadonlyArray<Uint8Array>): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

interface CountableHunk {
  readonly kind: string;
  readonly oursStart: number;
  readonly oursEnd: number;
  readonly theirsStart: number;
  readonly theirsEnd: number;
}

/** git `--numstat`'s own added/deleted pair — added is the total width of
 *  every theirs-only hunk, deleted the total width of every ours-only hunk. */
function changeCounts(hunks: ReadonlyArray<CountableHunk>): {
  readonly added: number;
  readonly deleted: number;
} {
  let added = 0;
  let deleted = 0;
  for (const hunk of hunks) {
    if (hunk.kind === 'theirs-only') added += hunk.theirsEnd - hunk.theirsStart;
    if (hunk.kind === 'ours-only') deleted += hunk.oursEnd - hunk.oursStart;
  }
  return { added, deleted };
}

describe('line-diff — splitLines', () => {
  describe('Given empty Uint8Array', () => {
    describe('When splitLines called', () => {
      it('Then returns []', () => {
        // Arrange
        const bytes = new Uint8Array(0);

        // Act
        const result = splitLines(bytes);

        // Assert
        expect(result).toEqual([]);
      });
    });
  });

  describe('Given non-empty bytes to split', () => {
    describe('When splitLines called', () => {
      it.each([
        {
          bytes: enc('a\nb\n'),
          lines: [enc('a\n'), enc('b\n')],
          label: "'a\\nb\\n' returns [bytes('a\\n'), bytes('b\\n')]",
        },
        {
          bytes: enc('a\nb'),
          lines: [enc('a\n'), enc('b')],
          label: "'a\\nb' (no trailing LF) returns [bytes('a\\n'), bytes('b')]",
        },
        {
          bytes: enc('\n\n'),
          lines: [enc('\n'), enc('\n')],
          label: "'\\n\\n' (two empty lines) returns [bytes('\\n'), bytes('\\n')]",
        },
      ])('Then $label', ({ bytes, lines }) => {
        // Arrange + Act
        const result = splitLines(bytes);

        // Assert
        expect(result).toHaveLength(2);
        expect(bytesEqual(result[0]!, lines[0]!)).toBe(true);
        expect(bytesEqual(result[1]!, lines[1]!)).toBe(true);
      });
    });
  });

  describe('Given the property "for any bytes X, concat(splitLines(X)) equals X (roundtrip)"', () => {
    describe('When sampled', () => {
      it('Then it holds', () => {
        // Arrange + Assert
        fc.assert(
          fc.property(fc.uint8Array({ maxLength: 512 }), (bytes) => {
            const input = new Uint8Array(bytes);
            const parts = splitLines(input);
            const rebuilt = concatBytes(parts);
            return bytesEqual(rebuilt, input);
          }),
        );
      });
    });
  });
});

function bytesWithNulAt(length: number, nulIndex: number): Uint8Array {
  const bytes = new Uint8Array(length).fill(0x61);
  bytes[nulIndex] = 0x00;
  return bytes;
}

function linesOf(count: number): Uint8Array {
  const singleLine = enc('a\n');
  const bytes = new Uint8Array(count * singleLine.length);
  for (let i = 0; i < count; i++) {
    bytes.set(singleLine, i * singleLine.length);
  }
  return bytes;
}

function linesWithTrailingIncomplete(fullLineCount: number): Uint8Array {
  const fullLine = enc('a\n');
  const bytes = new Uint8Array(fullLineCount * fullLine.length + 1);
  for (let i = 0; i < fullLineCount; i++) {
    bytes.set(fullLine, i * fullLine.length);
  }
  bytes[bytes.length - 1] = 0x61; // 'a'
  return bytes;
}

describe('line-diff — isBinary', () => {
  describe('Given byte content, When isBinary called', () => {
    it.each([
      { bytes: new Uint8Array(0), expected: false, label: 'empty Uint8Array returns false' },
      {
        bytes: enc('hello\nworld\n'),
        expected: false,
        label: 'bytes with no NUL and reasonable size returns false',
      },
      {
        bytes: new Uint8Array([0x00, 0x61, 0x62]),
        expected: true,
        label: 'bytes with NUL at offset 0 returns true',
      },
      {
        // NUL at the last index inside the detection window
        bytes: bytesWithNulAt(BINARY_DETECTION_BYTES, BINARY_DETECTION_BYTES - 1),
        expected: true,
        label: 'BINARY_DETECTION_BYTES - 1 offset NUL (within window) returns true',
      },
      {
        // NUL at the first index outside the detection window
        bytes: bytesWithNulAt(BINARY_DETECTION_BYTES + 1, BINARY_DETECTION_BYTES),
        expected: false,
        label: 'BINARY_DETECTION_BYTES offset NUL (boundary — outside window) returns false',
      },
      {
        bytes: new Uint8Array(MAX_LINE_BYTES - 1).fill(0x61),
        expected: false,
        label: 'MAX_LINE_BYTES - 1 bytes on one line, no NUL, returns false',
      },
      {
        bytes: new Uint8Array(MAX_LINE_BYTES).fill(0x61),
        expected: false,
        label:
          'MAX_LINE_BYTES bytes on one line, no NUL, returns false (line length no longer decides)',
      },
      {
        bytes: linesOf(FORMER_MAX_LINES - 1),
        expected: false,
        label: 'one under the former 100 000-line cap, all short, no NUL, returns false',
      },
      {
        bytes: linesOf(FORMER_MAX_LINES),
        expected: false,
        label:
          'at the former 100 000-line cap, all short, no NUL, returns false (line count no longer decides)',
      },
      {
        // (FORMER_MAX_LINES - 1) lines 'a\n' followed by a trailing 'a' (no LF).
        // No longer trips isBinary — line count no longer decides.
        bytes: linesWithTrailingIncomplete(FORMER_MAX_LINES - 1),
        expected: false,
        label:
          'former cap reached via trailing incomplete line (no final LF), no NUL, returns false',
      },
    ])('Then $label', ({ bytes, expected }) => {
      // Arrange + Act
      const result = isBinary(bytes);

      // Assert
      expect(result).toBe(expected);
    });
  });
});

describe('line-diff — diffLines', () => {
  function hunkSummary(hunk: {
    readonly kind: string;
    readonly oursStart: number;
    readonly oursEnd: number;
    readonly theirsStart: number;
    readonly theirsEnd: number;
  }): string {
    return `${hunk.kind} o[${hunk.oursStart},${hunk.oursEnd}) t[${hunk.theirsStart},${hunk.theirsEnd})`;
  }

  describe('Given identical Uint8Arrays', () => {
    describe('When diffLines called', () => {
      it('Then a single common hunk covers all lines', () => {
        // Arrange
        const bytes = enc('a\nb\nc\n');

        // Act
        const result = diffLines(bytes, bytes);

        // Assert
        expect(result.hunks).toHaveLength(1);
        expect(result.hunks[0]).toMatchObject({
          kind: 'common',
          oursStart: 0,
          oursEnd: 3,
          theirsStart: 0,
          theirsEnd: 3,
        });
      });
    });
  });

  describe('Given ours/theirs where at least one side is empty', () => {
    describe('When diffLines called', () => {
      it.each([
        {
          ours: new Uint8Array(0),
          theirs: new Uint8Array(0),
          hunks: [{ kind: 'common', oursStart: 0, oursEnd: 0, theirsStart: 0, theirsEnd: 0 }],
          label: 'empty + empty yields a single zero-length common hunk',
        },
        {
          ours: new Uint8Array(0),
          theirs: enc('a\nb\n'),
          hunks: [{ kind: 'theirs-only', oursStart: 0, oursEnd: 0, theirsStart: 0, theirsEnd: 2 }],
          label: 'ours empty and theirs non-empty yields a single theirs-only hunk',
        },
        {
          ours: enc('a\nb\n'),
          theirs: new Uint8Array(0),
          hunks: [{ kind: 'ours-only', oursStart: 0, oursEnd: 2, theirsStart: 0, theirsEnd: 0 }],
          label: 'ours non-empty and theirs empty yields a single ours-only hunk',
        },
      ])('Then $label', ({ ours, theirs, hunks }) => {
        // Arrange + Act
        const result = diffLines(ours, theirs);

        // Assert
        expect(result.hunks).toEqual(hunks);
      });
    });
  });

  describe('Given inputs producing multiple hunks by simple concatenation', () => {
    describe('When diffLines called', () => {
      it.each([
        {
          ours: enc('a\nb\n'),
          theirs: enc('x\na\nb\n'),
          summary: ['theirs-only o[0,0) t[0,1)', 'common o[0,2) t[1,3)'],
          label: 'a pure prepend (theirs has extra leading line) yields theirs-only then common',
        },
        {
          ours: enc('a\nb\n'),
          theirs: enc('a\nb\nz\n'),
          summary: ['common o[0,2) t[0,2)', 'theirs-only o[2,2) t[2,3)'],
          label: 'a pure append yields common then theirs-only',
        },
        {
          // 'a c e' lines are common; 'b' and 'd' are replaced by 'X' and 'Y'. A correct
          // LCS keeps 'c' common; a down-biased snake choice would collapse lines 1..3
          // into one large replace and lose the shared 'c'.
          ours: enc('a\nb\nc\nd\ne\n'),
          theirs: enc('a\nX\nc\nY\ne\n'),
          summary: [
            'common o[0,1) t[0,1)',
            'ours-only o[1,2) t[1,1)',
            'theirs-only o[2,2) t[1,2)',
            'common o[2,3) t[2,3)',
            'ours-only o[3,4) t[3,3)',
            'theirs-only o[4,4) t[3,4)',
            'common o[4,5) t[4,5)',
          ],
          label:
            'interleaved edits sharing a middle common line preserve it as its own common hunk',
        },
      ])('Then $label', ({ ours, theirs, summary }) => {
        // Arrange + Act
        const result = diffLines(ours, theirs);

        // Assert
        expect(result.hunks.map(hunkSummary)).toEqual(summary);
      });
    });
  });

  describe('Given file with trailing LF vs without (same content)', () => {
    describe('When diffLines called', () => {
      it('Then single line hunk classification reflects byte difference', () => {
        // Arrange — 'a\n' is one line; 'a' is one line (different bytes)
        const ours = enc('a\n');
        const theirs = enc('a');

        // Act
        const result = diffLines(ours, theirs);

        // Assert — different byte sequences on the single line → modify → delete + insert pair
        expect(result.hunks).toEqual([
          { kind: 'ours-only', oursStart: 0, oursEnd: 1, theirsStart: 0, theirsEnd: 0 },
          { kind: 'theirs-only', oursStart: 1, oursEnd: 1, theirsStart: 0, theirsEnd: 1 },
        ]);
      });
    });
  });

  describe('Given small inputs with a tiny edit distance', () => {
    describe('When diffLines called', () => {
      it('Then it produces at least one hunk', () => {
        // Arrange
        const ours = enc('a\nb\nc\n');
        const theirs = enc('a\nX\nc\n');

        // Act
        const result = diffLines(ours, theirs);

        // Assert
        expect(result.hunks.length).toBeGreaterThan(0);
      });
    });
  });

  function uniqueLines(prefix: string, count: number): ReadonlyArray<string> {
    return Array.from({ length: count }, (_, i) => `${prefix}${i}`);
  }

  describe('Given 5001 unique lines plus one shared line on each side (past the old bail: d = 10 002)', () => {
    describe('When diffLines is called', () => {
      it('Then added/deleted match live git (5001/5001)', () => {
        // Arrange
        const ours = enc(`${[...uniqueLines('u', 5001), 'common'].join('\n')}\n`);
        const theirs = enc(`${[...uniqueLines('v', 5001), 'common'].join('\n')}\n`);

        // Act
        const result = diffLines(ours, theirs);

        // Assert
        expect(changeCounts(result.hunks)).toEqual({ added: 5001, deleted: 5001 });
      });
    });
  });

  describe('Given 10001 unique lines plus one shared line against just that shared line (past the old bail: d = 10 001)', () => {
    describe('When diffLines is called', () => {
      it('Then added/deleted match live git (0/10001)', () => {
        // Arrange
        const ours = enc(`${[...uniqueLines('u', 10_001), 'common'].join('\n')}\n`);
        const theirs = enc('common\n');

        // Act
        const result = diffLines(ours, theirs);

        // Assert
        expect(changeCounts(result.hunks)).toEqual({ added: 0, deleted: 10_001 });
      });
    });
  });

  describe('Given 5000 unique lines plus one shared line on each side (exactly at the old bail: d = 10 000)', () => {
    describe('When diffLines is called', () => {
      it('Then added/deleted match live git (5000/5000)', () => {
        // Arrange
        const ours = enc(`${[...uniqueLines('u', 5000), 'common'].join('\n')}\n`);
        const theirs = enc(`${[...uniqueLines('v', 5000), 'common'].join('\n')}\n`);

        // Act
        const result = diffLines(ours, theirs);

        // Assert
        expect(changeCounts(result.hunks)).toEqual({ added: 5000, deleted: 5000 });
      });
    });
  });

  // git's xdl_bogosqrt-derived cost cap (XDL_MAX_COST_MIN = 256) cuts the
  // search short well before either of these inputs' true edit distance —
  // every line matches exactly once on the other side, so record cleanup
  // (Part 11) cannot change these counts either.
  function mulberry32(seed: number): () => number {
    let state = seed;
    return () => {
      state |= 0;
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
    };
  }

  function shuffledCopy(items: ReadonlyArray<string>, rng: () => number): string[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const swapped = out[i]!;
      out[i] = out[j]!;
      out[j] = swapped;
    }
    return out;
  }

  function paddedLines(count: number): ReadonlyArray<string> {
    return Array.from({ length: count }, (_, i) => `line${String(i).padStart(4, '0')}`);
  }

  describe('Given a seeded shuffle of 2000 distinct lines (past the cost cap)', () => {
    describe('When diffLines is called', () => {
      it('Then added/deleted match live git’s non-minimal split (1931/1931)', () => {
        // Arrange
        const base = paddedLines(2000);
        const ours = enc(`${base.join('\n')}\n`);
        const theirs = enc(`${shuffledCopy(base, mulberry32(1_234_567)).join('\n')}\n`);

        // Act
        const result = diffLines(ours, theirs);

        // Assert
        expect(changeCounts(result.hunks)).toEqual({ added: 1931, deleted: 1931 });
      });
    });
  });

  describe('Given a 600-line block moved from the front to the back of a 1200-line file (past the cost cap)', () => {
    describe('When diffLines is called', () => {
      it('Then added/deleted match live git’s non-minimal split (600/600)', () => {
        // Arrange
        const base = paddedLines(1200);
        const ours = enc(`${base.join('\n')}\n`);
        const theirs = enc(`${[...base.slice(600), ...base.slice(0, 600)].join('\n')}\n`);

        // Act
        const result = diffLines(ours, theirs);

        // Assert
        expect(changeCounts(result.hunks)).toEqual({ added: 600, deleted: 600 });
      });
    });
  });

  describe('Given inputs sized at the former 50 000-line diffLines cap, both sides identical', () => {
    describe('When diffLines called', () => {
      it('Then it completes (edit distance zero)', () => {
        // Arrange — 25000 identical lines per side = 50000 total. There is no
        // size-based cap any more; this pair completes because its edit distance
        // is 0, independent of how many lines it totals.
        const content = 'a\n'.repeat(FORMER_MAX_DIFF_LINES / 2);
        const bytes = enc(content);

        // Act
        const result = diffLines(bytes, bytes);

        // Assert — identical inputs always produce a single common hunk
        expect(result.hunks).toHaveLength(1);
      }, 30_000);
    });
  });

  describe('Given equal-sized identical inputs larger than the former 50 000-line diffLines cap', () => {
    describe('When diffLines called', () => {
      it('Then it completes — identical content has edit distance zero regardless of size', () => {
        // Arrange — M === N === 25001, so M+N = 50002, over what used to be the
        // input-size cap, but the content is byte-identical so the true edit
        // distance is 0. Before this change the size-based pre-check degraded
        // this pair before any Myers run; now only the edit distance is bounded,
        // so an always-mergeable pair completes regardless of its size.
        const half = 25_001;
        const bytes = enc('a\n'.repeat(half));

        // Act
        const result = diffLines(bytes, bytes);

        // Assert — a single common hunk, never a whole-file fallback
        expect(result.hunks).toEqual([
          { kind: 'common', oursStart: 0, oursEnd: half, theirsStart: 0, theirsEnd: half },
        ]);
      });
    });
  });

  describe('Given a 200 002-line pair differing by a single line', () => {
    describe('When diffLines called', () => {
      it('Then the single-line hunk is reported', () => {
        // Arrange — 100 001 lines per side, one line changed near the start. The
        // edit distance is 2 (one delete, one insert), far under the cap, even
        // though the pair totals well over the former 50 000-line diffLines cap.
        const count = 100_001;
        const changeAt = 3;
        const beforeLines = Array.from({ length: count }, (_, i) =>
          i === changeAt ? 'mid line' : `line-${i}`,
        );
        const afterLines = [...beforeLines];
        afterLines[changeAt] = 'mid line CHANGED';
        const ours = enc(`${beforeLines.join('\n')}\n`);
        const theirs = enc(`${afterLines.join('\n')}\n`);

        // Act
        const result = diffLines(ours, theirs);

        // Assert
        expect(result.hunks).toEqual([
          { kind: 'common', oursStart: 0, oursEnd: changeAt, theirsStart: 0, theirsEnd: changeAt },
          {
            kind: 'ours-only',
            oursStart: changeAt,
            oursEnd: changeAt + 1,
            theirsStart: changeAt,
            theirsEnd: changeAt,
          },
          {
            kind: 'theirs-only',
            oursStart: changeAt + 1,
            oursEnd: changeAt + 1,
            theirsStart: changeAt,
            theirsEnd: changeAt + 1,
          },
          {
            kind: 'common',
            oursStart: changeAt + 1,
            oursEnd: count,
            theirsStart: changeAt + 1,
            theirsEnd: count,
          },
        ]);
      });
    });
  });

  describe('Given a NUL-free 70 000-byte line pair with no active lineKey', () => {
    describe('When diffLines called', () => {
      it('Then a long line is still just one line to the trace', () => {
        // Arrange — one 70 000-byte line changed by a single trailing byte. The
        // line-length cap no longer feeds isBinary or diffLines; this pair's
        // edit distance is 2 (delete + insert of the one line), so it completes.
        const ours = enc(`${'a'.repeat(70_000)}\n`);
        const theirs = enc(`${'a'.repeat(69_999)}b\n`);

        // Act
        const result = diffLines(ours, theirs);

        // Assert
        expect(result.hunks).toEqual([
          { kind: 'ours-only', oursStart: 0, oursEnd: 1, theirsStart: 0, theirsEnd: 0 },
          { kind: 'theirs-only', oursStart: 1, oursEnd: 1, theirsStart: 0, theirsEnd: 1 },
        ]);
      });
    });
  });

  describe('Given the property "diffLines(X, X) yields a single common hunk covering all lines"', () => {
    describe('When sampled', () => {
      it('Then it holds', () => {
        // Arrange + Assert
        fc.assert(
          fc.property(fc.uint8Array({ maxLength: 200 }), (bytes) => {
            const input = new Uint8Array(bytes);
            const result = diffLines(input, input);
            const lineCount = splitLines(input).length;
            if (lineCount === 0) {
              return (
                result.hunks.length === 1 &&
                result.hunks[0]?.kind === 'common' &&
                result.hunks[0].oursStart === 0 &&
                result.hunks[0].oursEnd === 0
              );
            }
            return (
              result.hunks.length === 1 &&
              result.hunks[0]?.kind === 'common' &&
              result.hunks[0].oursStart === 0 &&
              result.hunks[0].oursEnd === lineCount &&
              result.hunks[0].theirsStart === 0 &&
              result.hunks[0].theirsEnd === lineCount
            );
          }),
          { numRuns: 40 },
        );
      });
    });
  });

  describe('Given the property "sum of common + ours-only ranges covers ours exactly; symmetric for theirs"', () => {
    describe('When sampled', () => {
      it('Then it holds', () => {
        // Arrange
        const hunkLen = (h: {
          readonly oursStart: number;
          readonly oursEnd: number;
          readonly theirsStart: number;
          readonly theirsEnd: number;
        }) => ({ ours: h.oursEnd - h.oursStart, theirs: h.theirsEnd - h.theirsStart });
        // Assert
        fc.assert(
          fc.property(
            fc.uint8Array({ maxLength: 100 }),
            fc.uint8Array({ maxLength: 100 }),
            (a, b) => {
              const result = diffLines(new Uint8Array(a), new Uint8Array(b));
              const totals = result.hunks.reduce(
                (acc, h) => {
                  const { ours, theirs } = hunkLen(h);
                  if (h.kind !== 'theirs-only') acc.ours += ours;
                  if (h.kind !== 'ours-only') acc.theirs += theirs;
                  return acc;
                },
                { ours: 0, theirs: 0 },
              );
              return (
                totals.ours === result.oursLines.length &&
                totals.theirs === result.theirsLines.length
              );
            },
          ),
          { numRuns: 30 },
        );
      });
    });
  });

  describe("Given ours line 'ab' that is a strict byte-prefix of theirs line 'abx'", () => {
    describe('When diffLines called', () => {
      it('Then the lines are treated as different (delete + insert)', () => {
        // Arrange — last lines have no trailing LF, so 'ab' (3 bytes incl none) is a true
        // byte-prefix of 'abx'. linesEqual must reject them on the length guard alone.
        const ours = enc('ab');
        const theirs = enc('abx');

        // Act
        const result = diffLines(ours, theirs);

        // Assert — different lengths → not equal → one ours-only and one theirs-only hunk
        expect(result.hunks).toEqual([
          { kind: 'ours-only', oursStart: 0, oursEnd: 1, theirsStart: 0, theirsEnd: 0 },
          { kind: 'theirs-only', oursStart: 1, oursEnd: 1, theirsStart: 0, theirsEnd: 1 },
        ]);
      });
    });
  });

  describe('Given identical multi-line inputs', () => {
    describe('When diffLines called', () => {
      it('Then reconstruction terminates with a single common hunk (no runaway edit list)', () => {
        // Arrange — identical inputs complete Myers at d=0; reconstructEdits then walks
        // only the trailing diagonal. A non-terminating trailing loop would push edits
        // unboundedly and throw before producing hunks.
        const bytes = enc('a\nb\nc\nd\n');

        // Act
        const result = diffLines(bytes, bytes);

        // Assert
        expect(result.hunks).toEqual([
          { kind: 'common', oursStart: 0, oursEnd: 4, theirsStart: 0, theirsEnd: 4 },
        ]);
      });
    });
  });

  describe('Given fully-disjoint inputs sized at the former 10 000 edit-distance bail', () => {
    describe('When diffLines called', () => {
      it('Then it completes — the removed bail no longer degrades a large disjoint pair', () => {
        // Arrange — M=N=5000 fully-disjoint lines, an edit distance of exactly
        // the former edit-distance bail. No production constant binds that value
        // any more; this pins that a pair at the old bail's value still diffs normally.
        const M = FORMER_MAX_DIFF_EDIT_DISTANCE / 2;
        const N = FORMER_MAX_DIFF_EDIT_DISTANCE / 2;
        const ours = enc(Array.from({ length: M }, (_, i) => `p${i}\n`).join(''));
        const theirs = enc(Array.from({ length: N }, (_, i) => `q${i}\n`).join(''));

        // Act
        const result = diffLines(ours, theirs);

        // Assert
        expect(result.hunks).toEqual([
          { kind: 'ours-only', oursStart: 0, oursEnd: M, theirsStart: 0, theirsEnd: 0 },
          { kind: 'theirs-only', oursStart: M, oursEnd: M, theirsStart: 0, theirsEnd: N },
        ]);
      }, 60_000);
    });
  });
});

describe('line-diff — diffPresplitLines', () => {
  describe('Given already-split ours/theirs line arrays', () => {
    describe('When diffPresplitLines is called', () => {
      it('Then produces the identical LineDiff diffLines produces from the same bytes', () => {
        // Arrange
        const ours = enc('line1\nline2\nline3\n');
        const theirs = enc('line1\nline2-mod\nline3\nline4\n');
        const sut = diffPresplitLines;

        // Act
        const result = sut(splitLines(ours), splitLines(theirs));
        const expected = diffLines(ours, theirs);

        // Assert
        expect(result).toEqual(expected);
      });
    });

    describe('When diffPresplitLines is called', () => {
      it('Then the returned oursLines/theirsLines are the SAME array references passed in — no re-split', () => {
        // Arrange
        const oursLines = splitLines(enc('a\nb\n'));
        const theirsLines = splitLines(enc('a\nc\n'));
        const sut = diffPresplitLines;

        // Act
        const result = sut(oursLines, theirsLines);

        // Assert
        expect(result.oursLines).toBe(oursLines);
        expect(result.theirsLines).toBe(theirsLines);
      });
    });
  });

  describe('Given both sides empty', () => {
    describe('When diffPresplitLines is called', () => {
      it('Then returns the single common empty-file hunk, matching diffLines', () => {
        // Arrange
        const sut = diffPresplitLines;

        // Act
        const result = sut([], []);

        // Assert
        expect(result).toEqual(diffLines(new Uint8Array(0), new Uint8Array(0)));
      });
    });
  });

  describe('Given a fully-disjoint presplit pair (no engine bail left to exercise)', () => {
    describe('When diffPresplitLines is called', () => {
      it('Then it produces the identical LineDiff diffLines produces from the same bytes', () => {
        // Arrange
        const oursBytes = enc(Array.from({ length: 20 }, (_, i) => `p${i}\n`).join(''));
        const theirsBytes = enc(Array.from({ length: 20 }, (_, i) => `q${i}\n`).join(''));
        const oursLines = splitLines(oursBytes);
        const theirsLines = splitLines(theirsBytes);

        // Act
        const result = diffPresplitLines(oursLines, theirsLines);
        const expected = diffLines(oursBytes, theirsBytes);

        // Assert
        expect(result).toEqual(expected);
      });
    });
  });
});

describe('line-diff — diffLines lineKey option', () => {
  describe('Given a lineKey option and a line longer than the interning chunk size', () => {
    describe('When the oversized line differs from its counterpart only in whitespace, mode all', () => {
      it('Then the oversized line is common (chunked interning matches whole-line interning)', () => {
        // Arrange — 9000 chars exceeds the 8192-byte fromCharCode chunk ceiling
        const longLine = 'x'.repeat(9_000);
        const ours = enc(`${longLine}\n`);
        const theirs = enc(`  ${longLine}  \n`);
        const options: LineDiffOptions = { lineKey: { mode: 'all', ignoreCrAtEol: false } };

        // Act
        const result = diffLines(ours, theirs, options);

        // Assert — whitespace-only difference on the oversized line is common under mode all
        expect(result.hunks).toEqual([
          { kind: 'common', oursStart: 0, oursEnd: 1, theirsStart: 0, theirsEnd: 1 },
        ]);
      });
    });
  });

  describe('Given a lineKey option', () => {
    describe('When the file has a whitespace-only changed line and a real changed line, mode all', () => {
      it('Then the ws-only line is common, real line stays as ours-only/theirs-only, raw bytes preserved', () => {
        // Arrange
        const ours = enc('  ws\nreal\n');
        const theirs = enc('    ws\nREAL\n');
        const options: LineDiffOptions = { lineKey: { mode: 'all', ignoreCrAtEol: false } };

        // Act
        const result = diffLines(ours, theirs, options);

        // Assert — ws-only line (indices 0) is common; real line (indices 1) is ours-only/theirs-only
        expect(result.hunks).toEqual([
          { kind: 'common', oursStart: 0, oursEnd: 1, theirsStart: 0, theirsEnd: 1 },
          { kind: 'ours-only', oursStart: 1, oursEnd: 2, theirsStart: 1, theirsEnd: 1 },
          { kind: 'theirs-only', oursStart: 2, oursEnd: 2, theirsStart: 1, theirsEnd: 2 },
        ]);
        // Raw original bytes are preserved in the returned arrays (Requirement 3)
        expect(bytesEqual(result.oursLines[0]!, enc('  ws\n'))).toBe(true);
        expect(bytesEqual(result.theirsLines[0]!, enc('    ws\n'))).toBe(true);
      });
    });

    describe('When diffLines called with no options, empty options, and mode:none — all on a whitespace-different fixture', () => {
      it('Then all three call forms produce identical hunks (default regression guard)', () => {
        // Arrange
        const ours = enc('  ws\nreal\n');
        const theirs = enc('    ws\nreal\n');

        // Act
        const resultNoOpts = diffLines(ours, theirs);
        const resultEmptyOpts = diffLines(ours, theirs, {});
        const resultNoneKey = diffLines(ours, theirs, {
          lineKey: { mode: 'none', ignoreCrAtEol: false },
        });

        // Assert — all three are byte-identical in structure
        expect(resultEmptyOpts.hunks).toEqual(resultNoOpts.hunks);
        expect(resultNoneKey.hunks).toEqual(resultNoOpts.hunks);
        // Under no normalization, the ws-only line change is visible
        expect(
          resultNoOpts.hunks.some((h) => h.kind === 'ours-only' || h.kind === 'theirs-only'),
        ).toBe(true);
      });
    });
  });
});

describe('line-diff — classifying very long lines under an active lineKey', () => {
  describe('Given two lines far longer than a single spread call can take, sharing a long prefix but differing near the end', () => {
    describe('When diffLines is called with an active lineKey', () => {
      it('Then they are recognized as different lines without throwing', () => {
        // Arrange — classification hashes bytes in a plain loop (no argument
        // spread), so a 200 000-byte line never risks "Maximum call stack size
        // exceeded"; the shared prefix with a differing final byte also pins
        // that the whole normalized line is compared, not just a prefix of it.
        const prefix = 'x'.repeat(200_000);
        const ours = enc(`${prefix}A\n`);
        const theirs = enc(`${prefix}B\n`);
        const options: LineDiffOptions = { lineKey: { mode: 'none', ignoreCrAtEol: false } };

        // Act
        const result = diffLines(ours, theirs, options);

        // Assert — recognized as different, never collapsed into one common line
        expect(result.hunks.every((h) => h.kind !== 'common')).toBe(true);
      });
    });
  });
});
