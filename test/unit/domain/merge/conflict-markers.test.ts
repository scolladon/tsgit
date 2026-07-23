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

function expectMergeError(fn: () => unknown, reasonSubstr: string): void {
  let thrown: unknown;
  try {
    fn();
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeDefined();
  const data = (thrown as { data: { code: string; reason: string } }).data;
  expect(data.code).toBe('INVALID_MERGE_INPUT');
  expect(data.reason).toContain(reasonSubstr);
}

describe('writeConflictMarkers — positive', () => {
  describe("Given ours ['a\\\\n','b\\\\n'] and theirs ['a\\\\n','c\\\\n'] with labels HEAD/feature", () => {
    describe('When writeConflictMarkers called', () => {
      it('Then output equals golden byte-exact fixture', () => {
        // Arrange
        const expected = enc('<<<<<<< HEAD\na\nb\n=======\na\nc\n>>>>>>> feature\n');

        // Act
        const sut = writeConflictMarkers([enc('a\n'), enc('b\n')], [enc('a\n'), enc('c\n')], {
          labels: { ours: 'HEAD', theirs: 'feature' },
        });

        // Assert
        expect(bytesEqual(sut, expected)).toBe(true);
      });
    });
  });

  describe('Given theirs-lines ending without LF', () => {
    describe('When writeConflictMarkers called', () => {
      it('Then output ends with >>>>>>> <label>\\n (canonical)', () => {
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
    });
  });

  describe('Given ours-lines ending without LF', () => {
    describe('When writeConflictMarkers called', () => {
      it('Then separator appears on its own line', () => {
        // Arrange & Act
        const sut = writeConflictMarkers([enc('a\n'), enc('b')], [enc('c\n')]);

        // Assert
        const text = new TextDecoder().decode(sut);
        expect(text).toContain('a\nb\n=======\n');
      });
    });
  });

  describe('Given default options (no labels)', () => {
    describe('When writeConflictMarkers called', () => {
      it('Then uses default ours/theirs labels', () => {
        // Arrange & Act
        const sut = writeConflictMarkers([enc('a\n')], [enc('b\n')]);

        // Assert
        const text = new TextDecoder().decode(sut);
        expect(text).toContain('<<<<<<< ours\n');
        expect(text).toContain('>>>>>>> theirs\n');
      });
    });
  });

  describe('Given a base label in options', () => {
    describe('When writeConflictMarkers called', () => {
      it('Then it is not emitted (v1 two-way markers)', () => {
        // Arrange & Act
        const sut = writeConflictMarkers([enc('a\n')], [enc('b\n')], {
          labels: { ours: 'HEAD', theirs: 'feature', base: 'main' },
        });

        // Assert — no base marker in v1 output
        const text = new TextDecoder().decode(sut);
        expect(text).not.toContain('|||||||');
      });
    });
  });

  describe('Given empty ours and empty theirs', () => {
    describe('When writeConflictMarkers called', () => {
      it('Then markers emit on consecutive lines', () => {
        // Arrange & Act
        const sut = writeConflictMarkers([], []);

        // Assert
        const text = new TextDecoder().decode(sut);
        expect(text).toBe('<<<<<<< ours\n=======\n>>>>>>> theirs\n');
      });
    });
  });
});

describe('writeConflictMarkers — marker size', () => {
  describe('Given a markerSize option', () => {
    describe('When writeConflictMarkers called', () => {
      it.each([
        { markerSize: 1, repeat: 1, label: 'every marker run is a single character' },
        { markerSize: 15, repeat: 15, label: 'every marker run is 15 characters long' },
        { markerSize: undefined, repeat: 7, label: "it defaults to git's 7-character markers" },
      ])('Then $label', ({ markerSize, repeat }) => {
        // Arrange + Act
        const sut = writeConflictMarkers([enc('a\n')], [enc('b\n')], {
          labels: { ours: 'HEAD', theirs: 'feature' },
          ...(markerSize === undefined ? {} : { markerSize }),
        });

        // Assert
        const text = new TextDecoder().decode(sut);
        expect(text).toBe(
          `${'<'.repeat(repeat)} HEAD\na\n${'='.repeat(repeat)}\nb\n${'>'.repeat(repeat)} feature\n`,
        );
      });
    });
  });
});

describe('writeConflictMarkers — verbatim labels', () => {
  describe('Given a label value', () => {
    describe('When writeConflictMarkers called', () => {
      it.each([
        {
          oursLabel: 'HEAD',
          theirsLabel: 'HEAD',
          label: 'a printable ASCII label appears in both markers',
        },
        {
          oursLabel: 'feature/Ⓐ',
          theirsLabel: 'feature/Ⓐ',
          label: 'a multi-byte UTF-8 label round-trips verbatim',
        },
        {
          oursLabel: ' HEAD ',
          theirsLabel: ' HEAD ',
          label: 'a label with surrounding spaces is written verbatim',
        },
        {
          oursLabel: 'x'.repeat(300),
          theirsLabel: 'has ======= and \x1b[31m',
          label:
            'a long label and one carrying a marker substring / control character are written ' +
            'verbatim (git-faithful, no validation)',
        },
      ])('Then $label', ({ oursLabel, theirsLabel }) => {
        // Arrange & Act
        const sut = writeConflictMarkers([enc('a\n')], [enc('b\n')], {
          labels: { ours: oursLabel, theirs: theirsLabel },
        });

        // Assert
        const text = new TextDecoder().decode(sut);
        expect(text).toContain(`<<<<<<< ${oursLabel}\n`);
        expect(text).toContain(`>>>>>>> ${theirsLabel}\n`);
      });
    });
  });
});

describe('writeConflictMarkers — unsupported diff3', () => {
  describe("Given conflictStyle 'diff3' option", () => {
    describe('When writeConflictMarkers called', () => {
      it("Then throws INVALID_MERGE_INPUT containing 'diff3'", () => {
        // Arrange + Assert
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
  });
});

describe('writeConflictMarkers — output-size cap', () => {
  describe('Given combined bytes equal MAX_CONFLICT_OUTPUT_BYTES', () => {
    describe('When writeConflictMarkers called', () => {
      it('Then succeeds', () => {
        // Arrange — build ours + theirs exactly at the cap; split across two tiny lines to bound memory
        const halfBytes = MAX_CONFLICT_OUTPUT_BYTES / 2;
        const oursLine = new Uint8Array(halfBytes);
        oursLine.fill(0x61);
        const theirsLine = new Uint8Array(halfBytes);
        theirsLine.fill(0x62);

        // Assert
        expect(() =>
          writeConflictMarkers([oursLine], [theirsLine], {
            labels: { ours: 'H', theirs: 'H' },
          }),
        ).not.toThrow();
      });
    });
  });

  describe('Given combined bytes one over MAX_CONFLICT_OUTPUT_BYTES', () => {
    describe('When writeConflictMarkers called', () => {
      it('Then throws INVALID_MERGE_INPUT containing cap name', () => {
        // Arrange
        const halfBytes = MAX_CONFLICT_OUTPUT_BYTES / 2;
        const oursLine = new Uint8Array(halfBytes);
        const theirsLine = new Uint8Array(halfBytes + 1);

        // Act & Assert
        expectMergeError(
          () =>
            writeConflictMarkers([oursLine], [theirsLine], {
              labels: { ours: 'H', theirs: 'H' },
            }),
          'MAX_CONFLICT_OUTPUT_BYTES',
        );
      });
    });
  });
});

describe('MAX_CONFLICT_OUTPUT_BYTES — cap magnitude', () => {
  describe('Given the conflict output-size cap', () => {
    describe('When its value is read', () => {
      it('Then equals 256 MiB (268435456 bytes)', () => {
        // Arrange
        const sut = MAX_CONFLICT_OUTPUT_BYTES;

        // Assert
        expect(sut).toBe(256 * 1024 * 1024);
      });
    });
  });
});
