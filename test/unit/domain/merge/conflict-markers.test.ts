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
  describe("Given printable ASCII label 'HEAD'", () => {
    describe('When writeConflictMarkers called', () => {
      it('Then label appears in markers', () => {
        // Arrange & Act
        const sut = writeConflictMarkers([enc('a\n')], [enc('b\n')], {
          labels: { ours: 'HEAD', theirs: 'HEAD' },
        });

        // Assert
        const text = new TextDecoder().decode(sut);
        expect(text).toContain('<<<<<<< HEAD\n');
        expect(text).toContain('>>>>>>> HEAD\n');
      });
    });
  });

  describe("Given multi-byte UTF-8 label 'feature/Ⓐ'", () => {
    describe('When writeConflictMarkers called', () => {
      it('Then label round-trips verbatim', () => {
        // Arrange & Act
        const sut = writeConflictMarkers([enc('a\n')], [enc('b\n')], {
          labels: { ours: 'feature/Ⓐ', theirs: 'feature/Ⓐ' },
        });

        // Assert
        const text = new TextDecoder().decode(sut);
        expect(text).toContain('<<<<<<< feature/Ⓐ\n');
        expect(text).toContain('>>>>>>> feature/Ⓐ\n');
      });
    });
  });

  describe('Given label with surrounding spaces', () => {
    describe('When writeConflictMarkers called', () => {
      it('Then it is written verbatim', () => {
        // Arrange — leading/trailing spaces preserved verbatim in output
        const sut = writeConflictMarkers([enc('a\n')], [enc('b\n')], {
          labels: { ours: ' HEAD ', theirs: ' HEAD ' },
        });

        // Assert
        const text = new TextDecoder().decode(sut);
        expect(text).toContain('<<<<<<<  HEAD \n');
        expect(text).toContain('>>>>>>>  HEAD \n');
      });
    });
  });

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
  describe('Given markerSize 1', () => {
    describe('When writeConflictMarkers called', () => {
      it('Then all three markers are a single character', () => {
        // Arrange + Act
        const sut = writeConflictMarkers([enc('a\n')], [enc('b\n')], {
          labels: { ours: 'HEAD', theirs: 'feature' },
          markerSize: 1,
        });

        // Assert
        const text = new TextDecoder().decode(sut);
        expect(text).toBe('< HEAD\na\n=\nb\n> feature\n');
      });
    });
  });

  describe('Given markerSize 15', () => {
    describe('When writeConflictMarkers called', () => {
      it('Then every marker run is 15 characters long', () => {
        // Arrange + Act
        const sut = writeConflictMarkers([enc('a\n')], [enc('b\n')], {
          labels: { ours: 'HEAD', theirs: 'feature' },
          markerSize: 15,
        });

        // Assert
        const text = new TextDecoder().decode(sut);
        expect(text).toContain(`${'<'.repeat(15)} HEAD\n`);
        expect(text).toContain(`${'='.repeat(15)}\n`);
        expect(text).toContain(`${'>'.repeat(15)} feature\n`);
      });
    });
  });

  describe('Given markerSize omitted', () => {
    describe('When writeConflictMarkers called', () => {
      it('Then it defaults to git`s 7-character markers', () => {
        // Arrange + Act
        const sut = writeConflictMarkers([enc('a\n')], [enc('b\n')], {
          labels: { ours: 'HEAD', theirs: 'feature' },
        });

        // Assert
        const text = new TextDecoder().decode(sut);
        expect(text).toBe('<<<<<<< HEAD\na\n=======\nb\n>>>>>>> feature\n');
      });
    });
  });
});

describe('writeConflictMarkers — verbatim labels', () => {
  describe('Given a long label carrying a marker substring and a control character', () => {
    describe('When writeConflictMarkers called', () => {
      it('Then the label bytes are written verbatim (git-faithful, no validation)', () => {
        // Arrange — git writes any label bytes into the marker, including long
        // subjects and control / marker characters; the library is faithful and
        // leaves display-time sanitisation to the consumer.
        const long = 'x'.repeat(300);
        const noisy = 'has ======= and \x1b[31m';

        // Act
        const sut = writeConflictMarkers([enc('a\n')], [enc('b\n')], {
          labels: { ours: long, theirs: noisy },
        });

        // Assert
        const text = new TextDecoder().decode(sut);
        expect(text).toContain(`<<<<<<< ${long}\n`);
        expect(text).toContain(`>>>>>>> ${noisy}\n`);
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
