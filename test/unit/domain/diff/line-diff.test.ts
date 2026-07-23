import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { LineDiffOptions } from '../../../../src/domain/diff/line-diff.js';
import {
  BINARY_DETECTION_BYTES,
  diffLines,
  isBinary,
  MAX_DIFF_LINES,
  MAX_LINE_BYTES,
  MAX_LINES,
  splitLines,
} from '../../../../src/domain/diff/line-diff.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

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

describe('line-diff — splitLines', () => {
  describe('Given empty Uint8Array', () => {
    describe('When splitLines called', () => {
      it('Then returns []', () => {
        // Arrange
        const bytes = new Uint8Array(0);

        // Act
        const sut = splitLines(bytes);

        // Assert
        expect(sut).toEqual([]);
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
        // Act
        const sut = splitLines(bytes);

        // Assert
        expect(sut).toHaveLength(2);
        expect(bytesEqual(sut[0]!, lines[0]!)).toBe(true);
        expect(bytesEqual(sut[1]!, lines[1]!)).toBe(true);
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
        label: 'MAX_LINE_BYTES - 1 bytes on one line returns false',
      },
      {
        bytes: new Uint8Array(MAX_LINE_BYTES).fill(0x61),
        expected: true,
        label: 'MAX_LINE_BYTES bytes on one line returns true',
      },
      {
        bytes: linesOf(MAX_LINES - 1),
        expected: false,
        label: 'MAX_LINES - 1 lines (all short, all non-NUL) returns false',
      },
      {
        bytes: linesOf(MAX_LINES),
        expected: true,
        label: 'MAX_LINES lines (all short, all non-NUL) returns true',
      },
      {
        // (MAX_LINES - 1) lines 'a\n' followed by a trailing 'a' (no LF).
        // Exercises the tail branch that counts the trailing incomplete line.
        bytes: linesWithTrailingIncomplete(MAX_LINES - 1),
        expected: true,
        label: 'MAX_LINES reached via trailing incomplete line (no final LF) returns true',
      },
    ])('Then $label', ({ bytes, expected }) => {
      // Act
      const sut = isBinary(bytes);

      // Assert
      expect(sut).toBe(expected);
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
      it('Then single common hunk covering all lines, degraded false', () => {
        // Arrange
        const bytes = enc('a\nb\nc\n');

        // Act
        const sut = diffLines(bytes, bytes);

        // Assert
        expect(sut.degraded).toBe(false);
        expect(sut.hunks).toHaveLength(1);
        expect(sut.hunks[0]).toMatchObject({
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
      ])('Then $label, degraded false', ({ ours, theirs, hunks }) => {
        // Act
        const sut = diffLines(ours, theirs);

        // Assert
        expect(sut.degraded).toBe(false);
        expect(sut.hunks).toEqual(hunks);
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
        // Act
        const sut = diffLines(ours, theirs);

        // Assert
        expect(sut.degraded).toBe(false);
        expect(sut.hunks.map(hunkSummary)).toEqual(summary);
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
        const sut = diffLines(ours, theirs);

        // Assert — different byte sequences on the single line → modify → delete + insert pair
        expect(sut.degraded).toBe(false);
        expect(sut.hunks).toEqual([
          { kind: 'ours-only', oursStart: 0, oursEnd: 1, theirsStart: 0, theirsEnd: 0 },
          { kind: 'theirs-only', oursStart: 1, oursEnd: 1, theirsStart: 0, theirsEnd: 1 },
        ]);
      });
    });
  });

  describe('Given small inputs with D well below both caps', () => {
    describe('When diffLines called', () => {
      it('Then degraded is false', () => {
        // Arrange
        const ours = enc('a\nb\nc\n');
        const theirs = enc('a\nX\nc\n');

        // Act
        const sut = diffLines(ours, theirs);

        // Assert
        expect(sut.degraded).toBe(false);
        expect(sut.hunks.length).toBeGreaterThan(0);
      });
    });
  });

  describe('Given cap-exceeding ours and empty theirs', () => {
    describe('When diffLines called', () => {
      it('Then fallback hunks omit theirs-only (empty theirs)', () => {
        // Arrange — ours large enough to force iteration-cap fallback; theirs empty.
        const M = 2500;
        const ours = enc(Array.from({ length: M }, (_, i) => `l${i}\n`).join(''));
        const theirs = new Uint8Array(0);

        // Act
        const sut = diffLines(ours, theirs);

        // Assert
        expect(sut.degraded).toBe(true);
        expect(sut.hunks).toEqual([
          { kind: 'ours-only', oursStart: 0, oursEnd: M, theirsStart: 0, theirsEnd: 0 },
        ]);
      }, 20_000);
    });
  });

  describe('Given empty ours and cap-exceeding theirs', () => {
    describe('When diffLines called', () => {
      it('Then fallback hunks omit ours-only (empty ours)', () => {
        // Arrange — ours empty, theirs large enough to force iteration-cap fallback.
        // The whole-file fallback must skip the ours-only hunk when oursLines is empty.
        const N = 2500;
        const ours = new Uint8Array(0);
        const theirs = enc(Array.from({ length: N }, (_, i) => `l${i}\n`).join(''));

        // Act
        const sut = diffLines(ours, theirs);

        // Assert
        expect(sut.degraded).toBe(true);
        expect(sut.hunks).toEqual([
          {
            kind: 'theirs-only',
            oursStart: 0,
            oursEnd: 0,
            theirsStart: 0,
            theirsEnd: N,
          },
        ]);
      }, 20_000);
    });
  });

  describe('Given inputs with exactly MAX_DIFF_LINES total lines', () => {
    describe('When diffLines called', () => {
      it('Then not degraded (at-boundary succeeds)', () => {
        // Arrange — 25000 identical lines per side = 50000 total = exactly MAX_DIFF_LINES
        const content = 'a\n'.repeat(MAX_DIFF_LINES / 2);
        const bytes = enc(content);

        // Act
        const sut = diffLines(bytes, bytes);

        // Assert — identical inputs always produce a single common hunk, not degraded
        expect(sut.degraded).toBe(false);
      }, 30_000);
    });
  });

  describe('Given inputs exceeding MAX_DIFF_LINES total', () => {
    describe('When diffLines called', () => {
      it('Then degraded immediately (line cap)', () => {
        // Arrange — 25001 lines per side = 50002 > MAX_DIFF_LINES(50000). Fast: no Myers runs.
        const half = 25_001;
        const a = enc('a\n'.repeat(half));
        const b = enc('b\n'.repeat(half));

        // Act
        const sut = diffLines(a, b);

        // Assert
        expect(sut.degraded).toBe(true);
      });
    });
  });

  describe('Given equal-sized identical inputs whose combined length exceeds MAX_DIFF_LINES', () => {
    describe('When diffLines called', () => {
      it('Then degraded via the sum cap (not masked by a same-size Myers completion)', () => {
        // Arrange — M === N === 25001, so M+N=50002 > MAX_DIFF_LINES(50000) but M-N=0.
        // Identical content means a real Myers run (if the sum cap didn't fire first)
        // completes instantly at D=0 and reports a single common hunk instead of
        // degrading — this distinguishes the M+N cap from a wrongly-computed M-N cap.
        const half = 25_001;
        const bytes = enc('a\n'.repeat(half));

        // Act
        const sut = diffLines(bytes, bytes);

        // Assert — the sum cap fires before any Myers computation, so the whole-file
        // fallback (ours-only + theirs-only) is used even though the content is identical.
        expect(sut.degraded).toBe(true);
        expect(sut.hunks).toEqual([
          { kind: 'ours-only', oursStart: 0, oursEnd: half, theirsStart: 0, theirsEnd: 0 },
          { kind: 'theirs-only', oursStart: half, oursEnd: half, theirsStart: 0, theirsEnd: half },
        ]);
      });
    });
  });

  describe('Given inputs triggering iteration budget (iterations > maxD * MAX_DIFF_ITERATION_FACTOR)', () => {
    describe('When diffLines called', () => {
      it('Then degraded', () => {
        // Arrange — use inputs where D < MAX_DIFF_EDIT_DISTANCE but iteration count exceeds the budget.
        // With M=N=2000 disjoint lines, maxD=4000, budget=4_000_000. Each d-step adds 2d+1 iterations.
        // Total iterations for d=0..D is sum(2d+1, d=0..D-1)=D^2. D=2001 → ~4M iterations, exceeding budget.
        const a = Array.from({ length: 2000 }, (_, i) => `a${i}\n`).join('');
        const b = Array.from({ length: 2000 }, (_, i) => `b${i}\n`).join('');

        // Act
        const sut = diffLines(enc(a), enc(b));

        // Assert — should degrade due to one of the caps
        expect(sut.degraded).toBe(true);
        // 90s tolerates Stryker dry-run overhead (~3x slower than vitest direct).
      }, 90_000);
    });
  });

  describe('Given the property "diffLines(X, X) yields a single common hunk covering all lines with degraded false"', () => {
    describe('When sampled', () => {
      it('Then it holds', () => {
        // Arrange + Assert
        fc.assert(
          fc.property(fc.uint8Array({ maxLength: 200 }), (bytes) => {
            const input = new Uint8Array(bytes);
            const result = diffLines(input, input);
            const lineCount = splitLines(input).length;
            if (result.degraded) return false;
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
              if (result.degraded) return true;
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
        const sut = diffLines(ours, theirs);

        // Assert — different lengths → not equal → one ours-only and one theirs-only hunk
        expect(sut.degraded).toBe(false);
        expect(sut.hunks).toEqual([
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
        const sut = diffLines(bytes, bytes);

        // Assert
        expect(sut.degraded).toBe(false);
        expect(sut.hunks).toEqual([
          { kind: 'common', oursStart: 0, oursEnd: 4, theirsStart: 0, theirsEnd: 4 },
        ]);
      });
    });
  });

  describe('Given disjoint inputs whose completing iteration equals the iteration budget exactly', () => {
    describe('When diffLines called', () => {
      it('Then it completes without degrading (budget check is strictly greater-than)', () => {
        // Arrange — M=998, N=1000 fully-disjoint lines. The Myers run completes on the
        // iteration numbered exactly maxD * MAX_DIFF_ITERATION_FACTOR (1998 * 1000).
        // A `>=` budget check would degrade here; the correct `>` check must not.
        const M = 998;
        const N = 1000;
        const ours = enc(Array.from({ length: M }, (_, i) => `q${i}\n`).join(''));
        const theirs = enc(Array.from({ length: N }, (_, i) => `z${i}\n`).join(''));

        // Act
        const sut = diffLines(ours, theirs);

        // Assert — at-budget run still completes via real Myers (not the degraded fallback)
        expect(sut.degraded).toBe(false);
        expect(sut.hunks).toEqual([
          { kind: 'ours-only', oursStart: 0, oursEnd: M, theirsStart: 0, theirsEnd: 0 },
          { kind: 'theirs-only', oursStart: M, oursEnd: M, theirsStart: 0, theirsEnd: N },
        ]);
      });
    });
  });
});

describe('line-diff — diffLines lineKey option', () => {
  describe('Given a lineKey option', () => {
    describe('When the file has a whitespace-only changed line and a real changed line, mode all', () => {
      it('Then the ws-only line is common, real line stays as ours-only/theirs-only, raw bytes preserved', () => {
        // Arrange
        const sut = diffLines;
        const ours = enc('  ws\nreal\n');
        const theirs = enc('    ws\nREAL\n');
        const options: LineDiffOptions = { lineKey: { mode: 'all', ignoreCrAtEol: false } };

        // Act
        const result = sut(ours, theirs, options);

        // Assert — ws-only line (indices 0) is common; real line (indices 1) is ours-only/theirs-only
        expect(result.degraded).toBe(false);
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
        const sut = diffLines;
        const ours = enc('  ws\nreal\n');
        const theirs = enc('    ws\nreal\n');

        // Act
        const resultNoOpts = sut(ours, theirs);
        const resultEmptyOpts = sut(ours, theirs, {});
        const resultNoneKey = sut(ours, theirs, {
          lineKey: { mode: 'none', ignoreCrAtEol: false },
        });

        // Assert — all three are byte-identical in structure
        expect(resultEmptyOpts.hunks).toEqual(resultNoOpts.hunks);
        expect(resultNoneKey.hunks).toEqual(resultNoOpts.hunks);
        expect(resultEmptyOpts.degraded).toBe(resultNoOpts.degraded);
        expect(resultNoneKey.degraded).toBe(resultNoOpts.degraded);
        // Under no normalization, the ws-only line change is visible
        expect(
          resultNoOpts.hunks.some((h) => h.kind === 'ours-only' || h.kind === 'theirs-only'),
        ).toBe(true);
      });
    });
  });
});
