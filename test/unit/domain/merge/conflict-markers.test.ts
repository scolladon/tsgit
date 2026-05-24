import { describe, expect, it } from 'vitest';
import { writeConflictMarkers } from '../../../../src/domain/merge/conflict-markers.js';
import { MAX_CONFLICT_OUTPUT_BYTES } from '../../../../src/domain/merge/merge-types.js';

const encoder = new TextEncoder();
const enc = (s: string): Uint8Array => encoder.encode(s);

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function expectMergeError(
  fn: () => unknown,
  reasonSubstr?: string,
  assertReason?: (reason: string) => void,
): void {
  let thrown: unknown;
  try {
    fn();
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeDefined();
  const data = (thrown as { data: { code: string; reason: string } }).data;
  expect(data.code).toBe('INVALID_MERGE_INPUT');
  if (reasonSubstr !== undefined) expect(data.reason).toContain(reasonSubstr);
  if (assertReason !== undefined) assertReason(data.reason);
}

describe('writeConflictMarkers — positive', () => {
  it("Given printable ASCII label 'HEAD', When writeConflictMarkers called, Then label appears in markers", () => {
    // Arrange & Act
    const sut = writeConflictMarkers([enc('a\n')], [enc('b\n')], {
      labels: { ours: 'HEAD', theirs: 'HEAD' },
    });

    // Assert
    const text = new TextDecoder().decode(sut);
    expect(text).toContain('<<<<<<< HEAD\n');
    expect(text).toContain('>>>>>>> HEAD\n');
  });

  it("Given multi-byte UTF-8 label 'feature/Ⓐ', When writeConflictMarkers called, Then label round-trips verbatim", () => {
    // Arrange & Act
    const sut = writeConflictMarkers([enc('a\n')], [enc('b\n')], {
      labels: { ours: 'feature/Ⓐ', theirs: 'feature/Ⓐ' },
    });

    // Assert
    const text = new TextDecoder().decode(sut);
    expect(text).toContain('<<<<<<< feature/Ⓐ\n');
    expect(text).toContain('>>>>>>> feature/Ⓐ\n');
  });

  it('Given label with surrounding spaces but non-empty after trim, When writeConflictMarkers called, Then accepted verbatim', () => {
    // Arrange — leading/trailing spaces preserved verbatim in output
    const sut = writeConflictMarkers([enc('a\n')], [enc('b\n')], {
      labels: { ours: ' HEAD ', theirs: ' HEAD ' },
    });

    // Assert
    const text = new TextDecoder().decode(sut);
    expect(text).toContain('<<<<<<<  HEAD \n');
    expect(text).toContain('>>>>>>>  HEAD \n');
  });

  it("Given ours ['a\\n','b\\n'] and theirs ['a\\n','c\\n'] with labels HEAD/feature, When writeConflictMarkers called, Then output equals golden byte-exact fixture", () => {
    // Arrange
    const expected = enc('<<<<<<< HEAD\na\nb\n=======\na\nc\n>>>>>>> feature\n');

    // Act
    const sut = writeConflictMarkers([enc('a\n'), enc('b\n')], [enc('a\n'), enc('c\n')], {
      labels: { ours: 'HEAD', theirs: 'feature' },
    });

    // Assert
    expect(bytesEqual(sut, expected)).toBe(true);
  });

  it('Given theirs-lines ending without LF, When writeConflictMarkers called, Then output ends with >>>>>>> <label>\\n (canonical)', () => {
    // Arrange & Act
    const sut = writeConflictMarkers([enc('a\n')], [enc('a\n'), enc('b')], {
      labels: { ours: 'HEAD', theirs: 'feature' },
    });

    // Assert
    const text = new TextDecoder().decode(sut);
    expect(text.endsWith('>>>>>>> feature\n')).toBe(true);
    // Previous theirs content 'b' padded with a newline before the close marker
    expect(text).toContain('a\nb\n>>>>>>> feature\n');
  });

  it('Given ours-lines ending without LF, When writeConflictMarkers called, Then separator appears on its own line', () => {
    // Arrange & Act
    const sut = writeConflictMarkers([enc('a\n'), enc('b')], [enc('c\n')]);

    // Assert
    const text = new TextDecoder().decode(sut);
    expect(text).toContain('a\nb\n=======\n');
  });

  it('Given default options (no labels), When writeConflictMarkers called, Then uses default ours/theirs labels', () => {
    // Arrange & Act
    const sut = writeConflictMarkers([enc('a\n')], [enc('b\n')]);

    // Assert
    const text = new TextDecoder().decode(sut);
    expect(text).toContain('<<<<<<< ours\n');
    expect(text).toContain('>>>>>>> theirs\n');
  });

  it('Given valid base label present in options, When writeConflictMarkers called, Then accepted', () => {
    // Arrange & Act — base label validated but not emitted (v1 two-way markers)
    const sut = writeConflictMarkers([enc('a\n')], [enc('b\n')], {
      labels: { ours: 'HEAD', theirs: 'feature', base: 'main' },
    });

    // Assert — call succeeds, no base marker in v1 output
    const text = new TextDecoder().decode(sut);
    expect(text).not.toContain('|||||||');
  });

  it('Given empty ours and empty theirs, When writeConflictMarkers called, Then markers emit on consecutive lines', () => {
    // Arrange & Act
    const sut = writeConflictMarkers([], []);

    // Assert
    const text = new TextDecoder().decode(sut);
    expect(text).toBe('<<<<<<< ours\n=======\n>>>>>>> theirs\n');
  });
});

describe('writeConflictMarkers — label validation (negative)', () => {
  it('Given label with \\n, When writeConflictMarkers called, Then throws INVALID_MERGE_INPUT', () => {
    // Arrange
    // Assert
    expectMergeError(() =>
      writeConflictMarkers([], [], { labels: { ours: 'a\nb', theirs: 'HEAD' } }),
    );
  });

  it('Given label with \\r, When writeConflictMarkers called, Then throws INVALID_MERGE_INPUT', () => {
    // Arrange
    // Assert
    expectMergeError(() =>
      writeConflictMarkers([], [], { labels: { ours: 'a\rb', theirs: 'HEAD' } }),
    );
  });

  it('Given label with \\x1b (C0 ANSI escape), When writeConflictMarkers called, Then throws INVALID_MERGE_INPUT', () => {
    // Arrange
    // Assert
    expectMergeError(() =>
      writeConflictMarkers([], [], {
        labels: { ours: 'HEAD\x1b[31mred', theirs: 'HEAD' },
      }),
    );
  });

  it('Given label with \\x7f (DEL), When writeConflictMarkers called, Then throws INVALID_MERGE_INPUT', () => {
    // Arrange
    // Assert
    expectMergeError(() =>
      writeConflictMarkers([], [], {
        labels: { ours: 'HEAD\x7fX', theirs: 'HEAD' },
      }),
    );
  });

  it('Given label with \\x9b (C1 control), When writeConflictMarkers called, Then throws INVALID_MERGE_INPUT', () => {
    // Arrange
    // Assert
    expectMergeError(() =>
      writeConflictMarkers([], [], {
        labels: { ours: 'HEAD\u009b', theirs: 'HEAD' },
      }),
    );
  });

  it('Given label containing <<<<<<<, When writeConflictMarkers called, Then throws INVALID_MERGE_INPUT', () => {
    // Arrange
    // Assert
    expectMergeError(() =>
      writeConflictMarkers([], [], { labels: { ours: '<<<<<<<', theirs: 'HEAD' } }),
    );
  });

  it('Given label containing =======, When writeConflictMarkers called, Then throws INVALID_MERGE_INPUT', () => {
    // Arrange
    // Assert
    expectMergeError(() =>
      writeConflictMarkers([], [], { labels: { ours: '=======', theirs: 'HEAD' } }),
    );
  });

  it('Given label containing >>>>>>>, When writeConflictMarkers called, Then throws INVALID_MERGE_INPUT', () => {
    // Arrange
    // Assert
    expectMergeError(() =>
      writeConflictMarkers([], [], { labels: { ours: '>>>>>>>', theirs: 'HEAD' } }),
    );
  });

  it('Given label containing |||||||, When writeConflictMarkers called, Then throws INVALID_MERGE_INPUT', () => {
    // Arrange
    // Assert
    expectMergeError(() =>
      writeConflictMarkers([], [], { labels: { ours: '|||||||', theirs: 'HEAD' } }),
    );
  });

  it('Given label of all printable ASCII (U+0020\u2013U+007E), When writeConflictMarkers called, Then accepted (no char treated as control)', () => {
    // Arrange \u2014 every printable code point; none is a control or bidi/invisible char
    let printable = '';
    for (let code = 0x20; code <= 0x7e; code++) {
      const ch = String.fromCharCode(code);
      // skip marker-substring-forming chars handled by a separate guard
      if (ch === '<' || ch === '=' || ch === '>' || ch === '|') continue;
      printable += ch;
    }

    // Act
    const sut = writeConflictMarkers([enc('a\n')], [enc('b\n')], {
      labels: { ours: printable, theirs: 'HEAD' },
    });

    // Assert \u2014 label round-trips verbatim; isControlCode returned false for every char
    const text = new TextDecoder().decode(sut);
    expect(text).toContain(`<<<<<<< ${printable}\n`);
  });

  it('Given label with U+001F (C0 control upper boundary), When writeConflictMarkers called, Then throws INVALID_MERGE_INPUT', () => {
    // Arrange
    // Assert
    expectMergeError(
      () => writeConflictMarkers([], [], { labels: { ours: 'HEAD\u001F', theirs: 'HEAD' } }),
      'forbidden control character',
    );
  });

  it('Given label with U+009F (C1 control upper boundary), When writeConflictMarkers called, Then throws INVALID_MERGE_INPUT', () => {
    // Arrange
    // Assert
    expectMergeError(
      () => writeConflictMarkers([], [], { labels: { ours: 'HEAD\u009F', theirs: 'HEAD' } }),
      'forbidden control character',
    );
  });

  it('Given label with U+202A (bidi LRE, lower boundary of override range), When writeConflictMarkers called, Then throws INVALID_MERGE_INPUT', () => {
    // Arrange
    // Assert
    expectMergeError(
      () => writeConflictMarkers([], [], { labels: { ours: 'HEAD\u202A', theirs: 'HEAD' } }),
      'forbidden control character',
    );
  });

  it('Given label with U+2066 (bidi isolate LRI, lower boundary), When writeConflictMarkers called, Then throws INVALID_MERGE_INPUT', () => {
    // Arrange
    // Assert
    expectMergeError(
      () => writeConflictMarkers([], [], { labels: { ours: 'HEAD\u2066', theirs: 'HEAD' } }),
      'forbidden control character',
    );
  });

  it('Given label with U+2069 (bidi isolate PDI, upper boundary), When writeConflictMarkers called, Then throws INVALID_MERGE_INPUT', () => {
    // Arrange
    // Assert
    expectMergeError(
      () => writeConflictMarkers([], [], { labels: { ours: 'HEAD\u2069', theirs: 'HEAD' } }),
      'forbidden control character',
    );
  });

  it('Given label with U+200C (ZWNJ invisible), When writeConflictMarkers called, Then throws INVALID_MERGE_INPUT', () => {
    // Arrange
    // Assert
    expectMergeError(
      () => writeConflictMarkers([], [], { labels: { ours: 'HEAD\u200C', theirs: 'HEAD' } }),
      'forbidden control character',
    );
  });

  it('Given label with U+2060 (WORD JOINER invisible), When writeConflictMarkers called, Then throws INVALID_MERGE_INPUT', () => {
    // Arrange
    // Assert
    expectMergeError(
      () => writeConflictMarkers([], [], { labels: { ours: 'HEAD\u2060', theirs: 'HEAD' } }),
      'forbidden control character',
    );
  });

  it('Given label with U+202E (bidi RLO override), When writeConflictMarkers called, Then throws INVALID_MERGE_INPUT', () => {
    // Arrange
    // Assert
    expectMergeError(() =>
      writeConflictMarkers([], [], { labels: { ours: 'HEAD\u202E<<<', theirs: 'HEAD' } }),
    );
  });

  it('Given label with U+200D (ZWJ invisible), When writeConflictMarkers called, Then throws INVALID_MERGE_INPUT', () => {
    // Arrange
    // Assert
    expectMergeError(() =>
      writeConflictMarkers([], [], { labels: { ours: 'HEAD\u200D', theirs: 'HEAD' } }),
    );
  });

  it('Given label with U+200B (ZERO WIDTH SPACE), When writeConflictMarkers called, Then throws INVALID_MERGE_INPUT', () => {
    // Arrange
    // Assert
    expectMergeError(() =>
      writeConflictMarkers([], [], { labels: { ours: 'HEAD\u200B', theirs: 'HEAD' } }),
    );
  });

  it('Given label with U+FEFF (BOM), When writeConflictMarkers called, Then throws INVALID_MERGE_INPUT', () => {
    // Arrange
    // Assert
    expectMergeError(() =>
      writeConflictMarkers([], [], { labels: { ours: 'HEAD\uFEFF', theirs: 'HEAD' } }),
    );
  });

  it("Given empty label '', When writeConflictMarkers called, Then throws INVALID_MERGE_INPUT", () => {
    // Arrange
    // Assert
    expectMergeError(
      () => writeConflictMarkers([], [], { labels: { ours: '', theirs: 'HEAD' } }),
      'empty or whitespace-only',
    );
  });

  it("Given whitespace-only label ' \\t\\v\\f ', When writeConflictMarkers called, Then throws INVALID_MERGE_INPUT", () => {
    // Arrange
    // Assert
    expectMergeError(
      () => writeConflictMarkers([], [], { labels: { ours: ' \t\v\f ', theirs: 'HEAD' } }),
      'empty or whitespace-only',
    );
  });

  it('Given invalid base label, When writeConflictMarkers called, Then throws INVALID_MERGE_INPUT', () => {
    // Arrange
    // Assert
    expectMergeError(
      () =>
        writeConflictMarkers([], [], {
          labels: { ours: 'HEAD', theirs: 'HEAD', base: '<<<<<<<' },
        }),
      'base label contains forbidden marker substring',
    );
  });

  it('Given label of exactly 255 chars, When writeConflictMarkers called, Then succeeds (at-boundary)', () => {
    // Arrange
    const label = 'a'.repeat(255);

    // Act & Assert
    // Assert
    expect(() =>
      writeConflictMarkers([], [], { labels: { ours: label, theirs: 'HEAD' } }),
    ).not.toThrow();
  });

  it('Given label of 256 chars, When writeConflictMarkers called, Then throws INVALID_MERGE_INPUT', () => {
    // Arrange
    const label = 'a'.repeat(256);

    // Act & Assert
    // Assert
    expectMergeError(
      () => writeConflictMarkers([], [], { labels: { ours: label, theirs: 'HEAD' } }),
      'exceeds maximum length',
    );
  });

  it('Given invalid theirs label, When writeConflictMarkers called, Then throws INVALID_MERGE_INPUT with theirs in reason', () => {
    // Arrange
    // Assert
    expectMergeError(
      () =>
        writeConflictMarkers([], [], {
          labels: { ours: 'HEAD', theirs: 'a\nb' },
        }),
      'theirs',
    );
  });

  it('Given label with forbidden char at last position, When writeConflictMarkers called, Then throws INVALID_MERGE_INPUT (loop reaches final index)', () => {
    // Arrange — NUL at the very last character position; ensures the loop bound reaches the last index
    // Assert
    expectMergeError(
      () =>
        writeConflictMarkers([], [], {
          labels: { ours: 'abc\x00', theirs: 'HEAD' },
        }),
      'forbidden control character',
    );
  });

  it('Given any invalid label, When writeConflictMarkers called, Then error reason does NOT contain the label value (branch-name privacy)', () => {
    // Arrange — secret branch name that must not leak into diagnostics
    const secret = 'secret-branch-name';
    const hostile = `${secret}\n`;

    // Act & Assert
    // Assert
    expectMergeError(
      () =>
        writeConflictMarkers([], [], {
          labels: { ours: hostile, theirs: 'HEAD' },
        }),
      undefined,
      (reason) => {
        expect(reason).not.toContain(secret);
      },
    );
  });

  it("Given conflictStyle 'diff3' option, When writeConflictMarkers called, Then throws INVALID_MERGE_INPUT containing 'diff3'", () => {
    // Arrange
    // Assert
    expectMergeError(
      () =>
        writeConflictMarkers([], [], {
          conflictStyle: 'diff3',
          labels: { ours: 'HEAD', theirs: 'HEAD' },
        }),
      'diff3',
    );
  });
});

describe('writeConflictMarkers — output-size cap', () => {
  it('Given combined bytes equal MAX_CONFLICT_OUTPUT_BYTES, When writeConflictMarkers called, Then succeeds', () => {
    // Arrange — build ours + theirs exactly at the cap; split across two tiny lines to bound memory
    const halfBytes = MAX_CONFLICT_OUTPUT_BYTES / 2;
    const oursLine = new Uint8Array(halfBytes);
    oursLine.fill(0x61);
    const theirsLine = new Uint8Array(halfBytes);
    theirsLine.fill(0x62);

    // Act — append LF via trailing ensureTrailingLf; no throw expected
    // Assert
    expect(() =>
      writeConflictMarkers([oursLine], [theirsLine], {
        labels: { ours: 'H', theirs: 'H' },
      }),
    ).not.toThrow();
  });

  it('Given combined bytes one over MAX_CONFLICT_OUTPUT_BYTES, When writeConflictMarkers called, Then throws INVALID_MERGE_INPUT containing cap name', () => {
    // Arrange
    const halfBytes = MAX_CONFLICT_OUTPUT_BYTES / 2;
    const oursLine = new Uint8Array(halfBytes);
    const theirsLine = new Uint8Array(halfBytes + 1);

    // Act & Assert
    // Assert
    expectMergeError(
      () =>
        writeConflictMarkers([oursLine], [theirsLine], {
          labels: { ours: 'H', theirs: 'H' },
        }),
      'MAX_CONFLICT_OUTPUT_BYTES',
    );
  });
});
