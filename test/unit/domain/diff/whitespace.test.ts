import { describe, expect, it } from 'vitest';
import type { LineKey, WhitespaceMode } from '../../../../src/domain/diff/whitespace.js';
import {
  isBlankLine,
  lineKeyIsActive,
  linesEqualUnder,
  NONE_KEY,
  normalizeLine,
  resolveLineKey,
} from '../../../../src/domain/diff/whitespace.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

// Build a line exactly as splitLines would return it: content + optional LF terminator
const line = (s: string): Uint8Array => enc(s);

describe('normalizeLine', () => {
  describe("Given mode 'all' (ignore all space/tab)", () => {
    const key: LineKey = { mode: 'all', ignoreCrAtEol: false };

    describe('When the line has whitespace to drop', () => {
      it.each([
        {
          input: 'a b\n',
          expected: 'ab\n',
          label: 'internal spaces are dropped, exactly one trailing LF preserved (W1)',
        },
        {
          input: '\tbeta gamma\n',
          expected: 'betagamma\n',
          label: 'a tab byte is dropped along with space bytes (W1)',
        },
        {
          input: 'a\r\n',
          expected: 'a\n',
          label: 'a trailing CR is dropped as part of all-whitespace removal (CR1)',
        },
        {
          input: 'a b',
          expected: 'ab',
          label: 'an unterminated line drops whitespace without appending a terminator',
        },
      ])('Then $label', ({ input, expected }) => {
        // Arrange + Act
        const result = normalizeLine(line(input), key);
        // Assert
        expect(result).toEqual(enc(expected));
      });
    });

    describe('When leading whitespace amount differs (presence irrelevant under all)', () => {
      it('Then drops leading space so x and "  x" are equal keys', () => {
        // Arrange
        const sut = normalizeLine;
        // Act
        const a = sut(line('x\n'), key);
        const b = sut(line('  x\n'), key);
        // Assert
        expect(a).toEqual(b);
      });
    });
  });

  describe("Given mode 'change' (ignore space-change / -b)", () => {
    const key: LineKey = { mode: 'change', ignoreCrAtEol: false };

    describe('When two lines differ only by whitespace amount or tab/space swap', () => {
      it.each([
        {
          left: 'xx a b yy\n',
          right: 'xx a    b yy\n',
          label:
            'a run that grows but stays non-zero (B-run) collapses both runs to a single space so lines are equal',
        },
        {
          left: 'a\tb\n',
          right: 'a b\n',
          label:
            'a tab swapped for a space in a run (B-tab) collapses both to a single space so keys are equal',
        },
        {
          left: '\tx\n',
          right: '    x\n',
          label:
            'leading whitespace amount changing from tab to spaces (B-amt) normalizes both to the same leading representation',
        },
        {
          left: 'a\r\n',
          right: 'a\n',
          label:
            'a trailing CR before the LF terminator is dropped as EOL whitespace (CR1 under -b)',
        },
      ])('Then $label', ({ left, right }) => {
        // Arrange + Act
        const a = normalizeLine(line(left), key);
        const b = normalizeLine(line(right), key);
        // Assert
        expect(a).toEqual(b);
      });
    });

    describe('When whitespace presence (not just amount) changes between two lines', () => {
      it.each([
        {
          left: 'a b\n',
          right: 'ab\n',
          label:
            'space fully removed from an internal position (B-zero: some→none) makes the keys differ because presence changed',
        },
        {
          left: 'x\n',
          right: '  x\n',
          label:
            'leading whitespace added where none existed (B-none) makes the keys differ because presence changed',
        },
        {
          left: 'a\rb\n',
          right: 'ab\n',
          label: 'a CR appearing mid-line (not at EOL) is preserved so the keys differ (CR-narrow)',
        },
      ])('Then $label', ({ left, right }) => {
        // Arrange + Act
        const a = normalizeLine(line(left), key);
        const b = normalizeLine(line(right), key);
        // Assert
        expect(a).not.toEqual(b);
      });
    });

    describe('When a trailing whitespace run ends the line', () => {
      it.each([
        {
          input: 'a b \n',
          expected: 'a b\n',
          label: 'a run ending a terminated line drops the collapsed trailing space (keeps the LF)',
        },
        {
          input: 'a b   ',
          expected: 'a b',
          label: 'a run ending an unterminated line drops the collapsed trailing space (no LF)',
        },
        {
          // guards the pop against firing on a non-space last byte
          input: 'ab\n',
          expected: 'ab\n',
          label: 'the line ending in a non-whitespace byte leaves the final byte intact',
        },
      ])('Then $label', ({ input, expected }) => {
        // Arrange + Act
        const result = normalizeLine(line(input), key);
        // Assert
        expect(result).toEqual(enc(expected));
      });
    });
  });

  describe("Given mode 'at-eol' (ignore space at EOL)", () => {
    const key: LineKey = { mode: 'at-eol', ignoreCrAtEol: false };

    describe('When trailing whitespace is added (EOL1)', () => {
      it('Then drops trailing run so keys are equal', () => {
        // Arrange
        const sut = normalizeLine;
        // Act
        const a = sut(line('a\n'), key);
        const b = sut(line('a   \n'), key);
        // Assert
        expect(a).toEqual(b);
      });
    });

    describe('When trailing whitespace before the LF is normalized', () => {
      it.each([
        {
          // pins the terminator byte, not just cross-line equality
          input: 'a   \n',
          expected: 'a\n',
          label:
            'trailing whitespace preceding the LF terminator drops the run and re-appends exactly one LF',
        },
        {
          input: '   \n',
          expected: '\n',
          label: 'a line entirely whitespace before the LF collapses to a bare LF',
        },
        {
          input: 'a   ',
          expected: 'a',
          label:
            'trailing whitespace ending an unterminated line drops the run without inventing an LF',
        },
      ])('Then $label', ({ input, expected }) => {
        // Arrange + Act
        const result = normalizeLine(enc(input), key);
        // Assert
        expect(result).toEqual(enc(expected));
      });
    });

    describe('When a distinguishing difference between two lines is preserved (keys differ)', () => {
      it.each([
        {
          left: '\tbeta gamma\n',
          right: '  beta  gamma   \n',
          label: 'internal whitespace differing (W3) is preserved so keys differ',
        },
        {
          left: '\tx\n',
          right: '    x\n',
          label: 'leading whitespace amount changing (B-amt2) is preserved so keys differ',
        },
        {
          left: 'a\rb\n',
          right: 'ab\n',
          label: 'a CR appearing mid-line (not at EOL) is preserved so the keys differ (CR-narrow)',
        },
      ])('Then $label', ({ left, right }) => {
        // Arrange + Act
        const a = normalizeLine(line(left), key);
        const b = normalizeLine(line(right), key);
        // Assert
        expect(a).not.toEqual(b);
      });
    });

    describe('When a trailing CR is present before the LF terminator', () => {
      it('Then drops the trailing CR as EOL whitespace (CR1 under at-eol)', () => {
        // Arrange
        const sut = normalizeLine;
        // Act
        const withCr = sut(line('a\r\n'), key);
        const withoutCr = sut(line('a\n'), key);
        // Assert
        expect(withCr).toEqual(withoutCr);
      });
    });
  });

  describe("Given mode 'none' (exact compare)", () => {
    const key: LineKey = { mode: 'none', ignoreCrAtEol: false };

    describe('When whitespace differs', () => {
      it('Then returns the line unchanged', () => {
        // Arrange
        const sut = normalizeLine;
        const input = line('a b\n');
        // Act
        const result = sut(input, key);
        // Assert
        expect(result).toEqual(input);
      });
    });

    describe('When a trailing CR precedes the LF terminator', () => {
      it('Then the CR is preserved (none mode never drops the CR)', () => {
        // Arrange — without ignoreCrAtEol the CR is significant content
        const sut = normalizeLine;
        const input = line('a\r\n');
        // Act
        const result = sut(input, key);
        // Assert
        expect(result).toEqual(enc('a\r\n'));
      });
    });
  });

  describe('Given ignoreCrAtEol: true with mode none', () => {
    const key: LineKey = { mode: 'none', ignoreCrAtEol: true };

    describe('When a trailing CR is present before the LF (CR1)', () => {
      it('Then drops the trailing CR', () => {
        // Arrange
        const sut = normalizeLine;
        // Act
        const withCr = sut(line('a\r\n'), key);
        const withoutCr = sut(line('a\n'), key);
        // Assert
        expect(withCr).toEqual(withoutCr);
      });
    });

    describe('When a CR appears mid-line (not at EOL)', () => {
      it('Then the mid-line CR is preserved (CR-narrow)', () => {
        // Arrange
        const sut = normalizeLine;
        // Act
        const a = sut(line('a\rb\n'), key);
        const b = sut(line('ab\n'), key);
        // Assert
        expect(a).not.toEqual(b);
      });
    });

    describe('When the CR guard is evaluated near unterminated or CR-free content', () => {
      it.each([
        {
          input: 'a\r',
          expected: 'a',
          label:
            'a trailing CR ending unterminated content (no final LF) drops the CR without appending an LF',
        },
        {
          // exercises the crPos === 0 boundary of the CR guard
          input: '\r',
          expected: '',
          label:
            'unterminated content that is a single CR drops it to an empty line (CR at index 0)',
        },
        {
          input: 'a  \n',
          expected: 'a  \n',
          label:
            'when no CR is present, trailing space is preserved (ignoreCrAtEol does not touch spaces)',
        },
      ])('Then $label', ({ input, expected }) => {
        // Arrange + Act
        const result = normalizeLine(line(input), key);
        // Assert
        expect(result).toEqual(enc(expected));
      });
    });
  });

  describe('Given an unterminated line (no trailing LF, as with last line in no-newline file)', () => {
    const key: LineKey = { mode: 'at-eol', ignoreCrAtEol: false };

    describe('When trailing whitespace is in an unterminated line', () => {
      it('Then drops trailing whitespace before end of content (D2 support)', () => {
        // Arrange
        const sut = normalizeLine;
        // Act
        const a = sut(enc('a'), key);
        const b = sut(enc('a   '), key);
        // Assert
        expect(a).toEqual(b);
      });
    });
  });
});

describe('linesEqualUnder', () => {
  describe("Given mode 'all'", () => {
    const key: LineKey = { mode: 'all', ignoreCrAtEol: false };

    describe('When two lines are compared', () => {
      it.each([
        {
          left: '\tbeta gamma\n',
          right: '  beta  gamma   \n',
          expected: true,
          label: 'lines differing only in whitespace (W1) are equal',
        },
        {
          left: 'real\n',
          right: 'REAL\n',
          expected: false,
          label: 'lines differing in non-whitespace content are not equal',
        },
        {
          left: 'a b\n',
          right: 'ab\n',
          expected: true,
          label:
            'lines with space removed entirely (B-zero under all) are equal because all space is dropped',
        },
      ])('Then $label', ({ left, right, expected }) => {
        // Arrange + Act
        const result = linesEqualUnder(line(left), line(right), key);
        // Assert
        expect(result).toBe(expected);
      });
    });
  });

  describe("Given mode 'change'", () => {
    const key: LineKey = { mode: 'change', ignoreCrAtEol: false };

    describe('When two lines are compared', () => {
      it.each([
        {
          left: 'a b\n',
          right: 'a    b\n',
          expected: true,
          label: 'a run amount growing but neither side going to zero (B-run) is equal',
        },
        {
          left: 'a b\n',
          right: 'ab\n',
          expected: false,
          label: 'internal space completely removed (B-zero) is not equal because presence changed',
        },
        {
          left: 'x\n',
          right: '  x\n',
          expected: false,
          label: 'space added where none existed (B-none) is not equal because presence changed',
        },
        {
          left: '\tx\n',
          right: '    x\n',
          expected: true,
          label:
            'leading whitespace amount changing (B-amt) is equal because amount-only change is ignored',
        },
        {
          left: 'a\tb\n',
          right: 'a b\n',
          expected: true,
          label: 'a tab swapped for a space (B-tab) is equal',
        },
      ])('Then $label', ({ left, right, expected }) => {
        // Arrange + Act
        const result = linesEqualUnder(line(left), line(right), key);
        // Assert
        expect(result).toBe(expected);
      });
    });
  });

  describe("Given mode 'at-eol'", () => {
    const key: LineKey = { mode: 'at-eol', ignoreCrAtEol: false };

    describe('When only trailing whitespace differs (EOL1)', () => {
      it('Then returns true', () => {
        // Arrange
        const sut = linesEqualUnder;
        // Act
        const result = sut(line('a\n'), line('a   \n'), key);
        // Assert
        expect(result).toBe(true);
      });
    });

    describe('When internal whitespace also differs (W3)', () => {
      it('Then returns false', () => {
        // Arrange
        const sut = linesEqualUnder;
        // Act
        const result = sut(line('\tbeta gamma\n'), line('  beta  gamma   \n'), key);
        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe("Given mode 'none'", () => {
    const key: LineKey = { mode: 'none', ignoreCrAtEol: false };

    describe('When trailing whitespace differs', () => {
      it('Then returns false (exact compare)', () => {
        // Arrange
        const sut = linesEqualUnder;
        // Act
        const result = sut(line('a\n'), line('a   \n'), key);
        // Assert
        expect(result).toBe(false);
      });
    });
  });
});

describe('resolveLineKey', () => {
  describe('Given an ignoreWhitespace option, When resolveLineKey runs', () => {
    it.each([
      {
        options: { ignoreWhitespace: 'all' as const },
        mode: 'all',
        label: "'all' resolves mode 'all'",
      },
      {
        options: { ignoreWhitespace: 'change' as const },
        mode: 'change',
        label: "'change' resolves mode 'change'",
      },
      {
        options: { ignoreWhitespace: 'at-eol' as const },
        mode: 'at-eol',
        label: "'at-eol' resolves mode 'at-eol'",
      },
      { options: {}, mode: 'none', label: "absent resolves mode 'none'" },
    ])('Then $label', ({ options, mode }) => {
      // Arrange + Act
      const result = resolveLineKey(options);
      // Assert
      expect(result.mode).toBe(mode);
    });
  });

  describe('Given ignoreCrAtEol is true, When resolveLineKey runs', () => {
    it('Then ignoreCrAtEol is true on the key', () => {
      // Arrange
      const sut = resolveLineKey;
      // Act
      const result = sut({ ignoreCrAtEol: true });
      // Assert
      expect(result.ignoreCrAtEol).toBe(true);
    });
  });

  describe('Given ignoreCrAtEol is absent, When resolveLineKey runs', () => {
    it('Then ignoreCrAtEol is false on the key', () => {
      // Arrange
      const sut = resolveLineKey;
      // Act
      const result = sut({});
      // Assert
      expect(result.ignoreCrAtEol).toBe(false);
    });
  });

  describe('Given ignoreBlankLines is set, When resolveLineKey runs', () => {
    it('Then ignoreBlankLines does NOT appear on the returned LineKey', () => {
      // Arrange
      const sut = resolveLineKey;
      // Act
      const result = sut({ ignoreBlankLines: true });
      // Assert
      // LineKey only has mode and ignoreCrAtEol
      expect(Object.keys(result).sort()).toEqual(['ignoreCrAtEol', 'mode']);
    });
  });
});

describe('lineKeyIsActive', () => {
  const modes: ReadonlyArray<WhitespaceMode> = ['all', 'change', 'at-eol', 'none'];

  for (const mode of modes) {
    describe(`Given mode '${mode}' and ignoreCrAtEol false, When lineKeyIsActive runs`, () => {
      it(`Then ${mode !== 'none' ? 'returns true' : 'returns false'}`, () => {
        // Arrange
        const sut = lineKeyIsActive;
        const key: LineKey = { mode, ignoreCrAtEol: false };
        // Act
        const result = sut(key);
        // Assert
        expect(result).toBe(mode !== 'none');
      });
    });
  }

  describe("Given mode 'none' and ignoreCrAtEol true, When lineKeyIsActive runs", () => {
    it('Then returns true because ignoreCrAtEol alone activates the key', () => {
      // Arrange
      const sut = lineKeyIsActive;
      const key: LineKey = { mode: 'none', ignoreCrAtEol: true };
      // Act
      const result = sut(key);
      // Assert
      expect(result).toBe(true);
    });
  });
});

describe('NONE_KEY', () => {
  describe('Given the constant, When normalizeLine is called on a line with a trailing CR', () => {
    it('Then the CR is preserved (ignoreCrAtEol is false)', () => {
      // Arrange
      const sut = normalizeLine;
      const input = line('a\r\n');
      // Act
      const result = sut(input, NONE_KEY);
      // Assert
      expect(result).toEqual(enc('a\r\n'));
    });
  });
});

describe('isBlankLine', () => {
  describe("Given mode 'all'", () => {
    const key: LineKey = { mode: 'all', ignoreCrAtEol: false };

    describe('When the line normalizes to empty', () => {
      it('Then a spaces-only line is blank', () => {
        // Arrange
        const sut = isBlankLine;
        // Act
        const result = sut(line('   \n'), key);
        // Assert
        expect(result).toBe(true);
      });
    });

    describe('When the line has a single non-whitespace char', () => {
      it('Then it is not blank (content length is 1, not 0)', () => {
        // Arrange
        const sut = isBlankLine;
        // Act
        const result = sut(line('a\n'), key);
        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given NONE_KEY (no normalization), When isBlankLine runs', () => {
    it.each([
      { input: '\n', expected: true, label: 'a bare LF is blank' },
      {
        input: '   \n',
        expected: false,
        label:
          'a spaces-only line is NOT blank (spaces are not stripped without a whitespace mode)',
      },
      { input: '', expected: true, label: 'an empty and unterminated line is blank' },
    ])('Then $label', ({ input, expected }) => {
      // Arrange + Act
      const result = isBlankLine(line(input), NONE_KEY);
      // Assert
      expect(result).toBe(expected);
    });
  });
});
