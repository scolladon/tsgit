import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
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
  it('Given empty Uint8Array, When splitLines called, Then returns []', () => {
    // Arrange
    const bytes = new Uint8Array(0);

    // Act
    const sut = splitLines(bytes);

    // Assert
    expect(sut).toEqual([]);
  });

  it("Given 'a\\nb\\n' bytes, When splitLines called, Then returns [bytes('a\\n'), bytes('b\\n')]", () => {
    // Arrange
    const bytes = enc('a\nb\n');

    // Act
    const sut = splitLines(bytes);

    // Assert
    expect(sut).toHaveLength(2);
    expect(bytesEqual(sut[0]!, enc('a\n'))).toBe(true);
    expect(bytesEqual(sut[1]!, enc('b\n'))).toBe(true);
  });

  it("Given 'a\\nb' bytes (no trailing LF), When splitLines called, Then returns [bytes('a\\n'), bytes('b')]", () => {
    // Arrange
    const bytes = enc('a\nb');

    // Act
    const sut = splitLines(bytes);

    // Assert
    expect(sut).toHaveLength(2);
    expect(bytesEqual(sut[0]!, enc('a\n'))).toBe(true);
    expect(bytesEqual(sut[1]!, enc('b'))).toBe(true);
  });

  it("Given '\\n\\n' bytes (two empty lines), When splitLines called, Then returns [bytes('\\n'), bytes('\\n')]", () => {
    // Arrange
    const bytes = enc('\n\n');

    // Act
    const sut = splitLines(bytes);

    // Assert
    expect(sut).toHaveLength(2);
    expect(bytesEqual(sut[0]!, enc('\n'))).toBe(true);
    expect(bytesEqual(sut[1]!, enc('\n'))).toBe(true);
  });

  it('Property: for any bytes X, concat(splitLines(X)) equals X (roundtrip)', () => {
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

describe('line-diff — isBinary', () => {
  it('Given empty Uint8Array, When isBinary called, Then returns false', () => {
    // Arrange & Act
    const sut = isBinary(new Uint8Array(0));

    // Assert
    expect(sut).toBe(false);
  });

  it('Given bytes with no NUL and reasonable size, When isBinary called, Then returns false', () => {
    // Arrange
    const bytes = enc('hello\nworld\n');

    // Act
    const sut = isBinary(bytes);

    // Assert
    expect(sut).toBe(false);
  });

  it('Given bytes with NUL at offset 0, When isBinary called, Then returns true', () => {
    // Arrange
    const bytes = new Uint8Array([0x00, 0x61, 0x62]);

    // Act
    const sut = isBinary(bytes);

    // Assert
    expect(sut).toBe(true);
  });

  it('Given BINARY_DETECTION_BYTES - 1 offset NUL (within window), When isBinary called, Then returns true', () => {
    // Arrange — NUL at the last index inside the detection window
    const bytes = new Uint8Array(BINARY_DETECTION_BYTES).fill(0x61);
    bytes[BINARY_DETECTION_BYTES - 1] = 0x00;

    // Act
    const sut = isBinary(bytes);

    // Assert
    expect(sut).toBe(true);
  });

  it('Given BINARY_DETECTION_BYTES offset NUL (boundary — outside window), When isBinary called, Then returns false', () => {
    // Arrange — NUL at the first index outside the detection window
    const bytes = new Uint8Array(BINARY_DETECTION_BYTES + 1).fill(0x61);
    bytes[BINARY_DETECTION_BYTES] = 0x00;

    // Act
    const sut = isBinary(bytes);

    // Assert
    expect(sut).toBe(false);
  });

  it('Given MAX_LINE_BYTES - 1 bytes on one line, When isBinary called, Then returns false', () => {
    // Arrange
    const bytes = new Uint8Array(MAX_LINE_BYTES - 1).fill(0x61);

    // Act
    const sut = isBinary(bytes);

    // Assert
    expect(sut).toBe(false);
  });

  it('Given MAX_LINE_BYTES bytes on one line, When isBinary called, Then returns true', () => {
    // Arrange
    const bytes = new Uint8Array(MAX_LINE_BYTES).fill(0x61);

    // Act
    const sut = isBinary(bytes);

    // Assert
    expect(sut).toBe(true);
  });

  it('Given MAX_LINES - 1 lines (all short, all non-NUL), When isBinary called, Then returns false', () => {
    // Arrange — (MAX_LINES - 1) lines, each 'a\n'
    const line = enc('a\n');
    const bytes = new Uint8Array((MAX_LINES - 1) * line.length);
    for (let i = 0; i < MAX_LINES - 1; i++) {
      bytes.set(line, i * line.length);
    }

    // Act
    const sut = isBinary(bytes);

    // Assert
    expect(sut).toBe(false);
  });

  it('Given MAX_LINES lines (all short, all non-NUL), When isBinary called, Then returns true', () => {
    // Arrange
    const line = enc('a\n');
    const bytes = new Uint8Array(MAX_LINES * line.length);
    for (let i = 0; i < MAX_LINES; i++) {
      bytes.set(line, i * line.length);
    }

    // Act
    const sut = isBinary(bytes);

    // Assert
    expect(sut).toBe(true);
  });

  it('Given MAX_LINES reached via trailing incomplete line (no final LF), When isBinary called, Then returns true', () => {
    // Arrange — (MAX_LINES - 1) lines 'a\n' followed by a trailing 'a' (no LF).
    // Exercises the tail branch that counts the trailing incomplete line.
    const fullLine = enc('a\n');
    const bytes = new Uint8Array((MAX_LINES - 1) * fullLine.length + 1);
    for (let i = 0; i < MAX_LINES - 1; i++) {
      bytes.set(fullLine, i * fullLine.length);
    }
    bytes[bytes.length - 1] = 0x61; // 'a'

    // Act
    const sut = isBinary(bytes);

    // Assert
    expect(sut).toBe(true);
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

  it('Given identical Uint8Arrays, When diffLines called, Then single common hunk covering all lines, degraded false', () => {
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

  it('Given empty + empty, When diffLines called, Then single zero-length common hunk, degraded false', () => {
    // Arrange
    const empty = new Uint8Array(0);

    // Act
    const sut = diffLines(empty, empty);

    // Assert
    expect(sut.degraded).toBe(false);
    expect(sut.hunks).toEqual([
      { kind: 'common', oursStart: 0, oursEnd: 0, theirsStart: 0, theirsEnd: 0 },
    ]);
  });

  it('Given pure prepend (theirs has extra leading line), When diffLines called, Then theirs-only hunk then common', () => {
    // Arrange
    const ours = enc('a\nb\n');
    const theirs = enc('x\na\nb\n');

    // Act
    const sut = diffLines(ours, theirs);

    // Assert
    expect(sut.degraded).toBe(false);
    expect(sut.hunks.map(hunkSummary)).toEqual([
      'theirs-only o[0,0) t[0,1)',
      'common o[0,2) t[1,3)',
    ]);
  });

  it('Given pure append, When diffLines called, Then common then theirs-only', () => {
    // Arrange
    const ours = enc('a\nb\n');
    const theirs = enc('a\nb\nz\n');

    // Act
    const sut = diffLines(ours, theirs);

    // Assert
    expect(sut.degraded).toBe(false);
    expect(sut.hunks.map(hunkSummary)).toEqual([
      'common o[0,2) t[0,2)',
      'theirs-only o[2,2) t[2,3)',
    ]);
  });

  it('Given ours empty and theirs non-empty, When diffLines called, Then single theirs-only hunk', () => {
    // Arrange
    const ours = new Uint8Array(0);
    const theirs = enc('a\nb\n');

    // Act
    const sut = diffLines(ours, theirs);

    // Assert
    expect(sut.degraded).toBe(false);
    expect(sut.hunks).toEqual([
      { kind: 'theirs-only', oursStart: 0, oursEnd: 0, theirsStart: 0, theirsEnd: 2 },
    ]);
  });

  it('Given ours non-empty and theirs empty, When diffLines called, Then single ours-only hunk', () => {
    // Arrange
    const ours = enc('a\nb\n');
    const theirs = new Uint8Array(0);

    // Act
    const sut = diffLines(ours, theirs);

    // Assert
    expect(sut.degraded).toBe(false);
    expect(sut.hunks).toEqual([
      { kind: 'ours-only', oursStart: 0, oursEnd: 2, theirsStart: 0, theirsEnd: 0 },
    ]);
  });

  it('Given file with trailing LF vs without (same content), When diffLines called, Then single line hunk classification reflects byte difference', () => {
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

  it('Given small inputs with D well below both caps, When diffLines called, Then degraded is false', () => {
    // Arrange
    const ours = enc('a\nb\nc\n');
    const theirs = enc('a\nX\nc\n');

    // Act
    const sut = diffLines(ours, theirs);

    // Assert
    expect(sut.degraded).toBe(false);
    expect(sut.hunks.length).toBeGreaterThan(0);
  });

  it('Given cap-exceeding ours and empty theirs, When diffLines called, Then fallback hunks omit theirs-only (empty theirs)', () => {
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

  it('Given empty ours and cap-exceeding theirs, When diffLines called, Then fallback hunks omit ours-only (empty ours)', () => {
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

  it('Given inputs with exactly MAX_DIFF_LINES total lines, When diffLines called, Then not degraded (at-boundary succeeds)', () => {
    // Arrange — 25000 identical lines per side = 50000 total = exactly MAX_DIFF_LINES
    const content = 'a\n'.repeat(MAX_DIFF_LINES / 2);
    const bytes = enc(content);

    // Act
    const sut = diffLines(bytes, bytes);

    // Assert — identical inputs always produce a single common hunk, not degraded
    expect(sut.degraded).toBe(false);
  }, 30_000);

  it('Given inputs exceeding MAX_DIFF_LINES total, When diffLines called, Then degraded immediately (line cap)', () => {
    // Arrange — 25001 lines per side = 50002 > MAX_DIFF_LINES(50000). Fast: no Myers runs.
    const half = 25_001;
    const a = enc('a\n'.repeat(half));
    const b = enc('b\n'.repeat(half));

    // Act
    const sut = diffLines(a, b);

    // Assert
    expect(sut.degraded).toBe(true);
  });

  it('Given inputs triggering iteration budget (iterations > maxD * MAX_DIFF_ITERATION_FACTOR), When diffLines called, Then degraded', () => {
    // Arrange — use inputs where D < MAX_DIFF_EDIT_DISTANCE but iteration count exceeds the budget.
    // With M=N=2000 disjoint lines, maxD=4000, budget=4_000_000. Each d-step adds 2d+1 iterations.
    // Total iterations for d=0..D is sum(2d+1, d=0..D-1)=D^2. D=2001 → ~4M iterations, exceeding budget.
    const a = Array.from({ length: 2000 }, (_, i) => `a${i}\n`).join('');
    const b = Array.from({ length: 2000 }, (_, i) => `b${i}\n`).join('');

    // Act
    const sut = diffLines(enc(a), enc(b));

    // Assert — should degrade due to one of the caps
    expect(sut.degraded).toBe(true);
  }, 30_000);

  it('Property: diffLines(X, X) yields a single common hunk covering all lines with degraded false', () => {
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

  it('Property: sum of common + ours-only ranges covers ours exactly; symmetric for theirs', () => {
    const hunkLen = (h: {
      readonly oursStart: number;
      readonly oursEnd: number;
      readonly theirsStart: number;
      readonly theirsEnd: number;
    }) => ({ ours: h.oursEnd - h.oursStart, theirs: h.theirsEnd - h.theirsStart });
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 100 }), fc.uint8Array({ maxLength: 100 }), (a, b) => {
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
          totals.ours === result.oursLines.length && totals.theirs === result.theirsLines.length
        );
      }),
      { numRuns: 30 },
    );
  });
});
