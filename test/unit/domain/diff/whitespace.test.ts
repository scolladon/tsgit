import { describe, expect, it } from 'vitest';
import type { LineKey, WhitespaceMode } from '../../../../src/domain/diff/whitespace.js';
import {
  lineKeyIsActive,
  linesEqualUnder,
  normalizeLine,
  resolveLineKey,
} from '../../../../src/domain/diff/whitespace.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

// Build a line exactly as splitLines would return it: content + optional LF terminator
const line = (s: string): Uint8Array => enc(s);

describe('normalizeLine', () => {
  describe("Given mode 'all' (ignore all space/tab)", () => {
    const key: LineKey = { mode: 'all', ignoreCrAtEol: false };

    describe('When the line has internal spaces', () => {
      it('Then drops all space bytes (W1)', () => {
        // Arrange
        const sut = normalizeLine;
        // Act
        const result = sut(line('a b\n'), key);
        // Assert
        expect(result).toEqual(enc('ab\n'));
      });
    });

    describe('When the line has a tab byte', () => {
      it('Then drops tab along with space bytes (W1)', () => {
        // Arrange
        const sut = normalizeLine;
        // Act
        const result = sut(line('\tbeta gamma\n'), key);
        // Assert
        expect(result).toEqual(enc('betagamma\n'));
      });
    });

    describe('When the line has leading whitespace turning to none (B-none case under all)', () => {
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

    describe('When a trailing CR is present before the LF terminator', () => {
      it('Then drops the CR as part of all-whitespace removal (CR1)', () => {
        // Arrange
        const sut = normalizeLine;
        // Act
        const result = sut(line('a\r\n'), key);
        // Assert
        expect(result).toEqual(enc('a\n'));
      });
    });
  });

  describe("Given mode 'change' (ignore space-change / -b)", () => {
    const key: LineKey = { mode: 'change', ignoreCrAtEol: false };

    describe('When a run grows but stays non-zero (B-run)', () => {
      it('Then collapses both runs to single space so lines are equal', () => {
        // Arrange
        const sut = normalizeLine;
        // Act
        const a = sut(line('xx a b yy\n'), key);
        const b = sut(line('xx a    b yy\n'), key);
        // Assert
        expect(a).toEqual(b);
      });
    });

    describe('When tab is swapped for space in a run (B-tab)', () => {
      it('Then collapses both to single space so keys are equal', () => {
        // Arrange
        const sut = normalizeLine;
        // Act
        const a = sut(line('a\tb\n'), key);
        const b = sut(line('a b\n'), key);
        // Assert
        expect(a).toEqual(b);
      });
    });

    describe('When leading whitespace amount changes from tab to spaces (B-amt)', () => {
      it('Then normalizes both to same leading representation', () => {
        // Arrange
        const sut = normalizeLine;
        // Act
        const a = sut(line('\tx\n'), key);
        const b = sut(line('    x\n'), key);
        // Assert
        expect(a).toEqual(b);
      });
    });

    describe('When space is fully removed from internal position (B-zero: some→none)', () => {
      it('Then the keys differ because presence changed', () => {
        // Arrange
        const sut = normalizeLine;
        // Act
        const a = sut(line('a b\n'), key);
        const b = sut(line('ab\n'), key);
        // Assert
        expect(a).not.toEqual(b);
      });
    });

    describe('When leading whitespace is added where none existed (B-none)', () => {
      it('Then the keys differ because presence changed', () => {
        // Arrange
        const sut = normalizeLine;
        // Act
        const a = sut(line('x\n'), key);
        const b = sut(line('  x\n'), key);
        // Assert
        expect(a).not.toEqual(b);
      });
    });

    describe('When a trailing CR is present before the LF terminator', () => {
      it('Then drops the trailing CR as EOL whitespace (CR1 under -b)', () => {
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
      it('Then the mid-line CR is preserved and the keys differ (CR-narrow)', () => {
        // Arrange
        const sut = normalizeLine;
        // Act
        const a = sut(line('a\rb\n'), key);
        const b = sut(line('ab\n'), key);
        // Assert
        expect(a).not.toEqual(b);
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

    describe('When internal whitespace differs (W3)', () => {
      it('Then internal whitespace is preserved so keys differ', () => {
        // Arrange
        const sut = normalizeLine;
        // Act
        const a = sut(line('\tbeta gamma\n'), key);
        const b = sut(line('  beta  gamma   \n'), key);
        // Assert
        expect(a).not.toEqual(b);
      });
    });

    describe('When leading whitespace amount changes (B-amt2)', () => {
      it('Then leading difference is preserved so keys differ', () => {
        // Arrange
        const sut = normalizeLine;
        // Act
        const a = sut(line('\tx\n'), key);
        const b = sut(line('    x\n'), key);
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

    describe('When a CR appears mid-line (not at EOL)', () => {
      it('Then the mid-line CR is preserved and the keys differ (CR-narrow)', () => {
        // Arrange
        const sut = normalizeLine;
        // Act
        const a = sut(line('a\rb\n'), key);
        const b = sut(line('ab\n'), key);
        // Assert
        expect(a).not.toEqual(b);
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

    describe('When no CR is present', () => {
      it('Then trailing space is preserved (ignoreCrAtEol does not touch spaces)', () => {
        // Arrange
        const sut = normalizeLine;
        // Act
        const withTrailingSpace = sut(line('a  \n'), key);
        // Assert
        expect(withTrailingSpace).toEqual(enc('a  \n'));
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

    describe('When lines differ only in whitespace (W1)', () => {
      it('Then returns true', () => {
        // Arrange
        const sut = linesEqualUnder;
        // Act
        const result = sut(line('\tbeta gamma\n'), line('  beta  gamma   \n'), key);
        // Assert
        expect(result).toBe(true);
      });
    });

    describe('When lines differ in non-whitespace content', () => {
      it('Then returns false', () => {
        // Arrange
        const sut = linesEqualUnder;
        // Act
        const result = sut(line('real\n'), line('REAL\n'), key);
        // Assert
        expect(result).toBe(false);
      });
    });

    describe('When lines have space removed entirely (B-zero under all)', () => {
      it('Then returns true because all space is dropped', () => {
        // Arrange
        const sut = linesEqualUnder;
        // Act
        const result = sut(line('a b\n'), line('ab\n'), key);
        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe("Given mode 'change'", () => {
    const key: LineKey = { mode: 'change', ignoreCrAtEol: false };

    describe('When run amount grows but neither side goes to zero (B-run)', () => {
      it('Then returns true', () => {
        // Arrange
        const sut = linesEqualUnder;
        // Act
        const result = sut(line('a b\n'), line('a    b\n'), key);
        // Assert
        expect(result).toBe(true);
      });
    });

    describe('When internal space is completely removed (B-zero)', () => {
      it('Then returns false because presence changed', () => {
        // Arrange
        const sut = linesEqualUnder;
        // Act
        const result = sut(line('a b\n'), line('ab\n'), key);
        // Assert
        expect(result).toBe(false);
      });
    });

    describe('When space is added where none existed (B-none)', () => {
      it('Then returns false because presence changed', () => {
        // Arrange
        const sut = linesEqualUnder;
        // Act
        const result = sut(line('x\n'), line('  x\n'), key);
        // Assert
        expect(result).toBe(false);
      });
    });

    describe('When leading whitespace amount changes (B-amt)', () => {
      it('Then returns true because amount-only change is ignored', () => {
        // Arrange
        const sut = linesEqualUnder;
        // Act
        const result = sut(line('\tx\n'), line('    x\n'), key);
        // Assert
        expect(result).toBe(true);
      });
    });

    describe('When tab is swapped for space (B-tab)', () => {
      it('Then returns true', () => {
        // Arrange
        const sut = linesEqualUnder;
        // Act
        const result = sut(line('a\tb\n'), line('a b\n'), key);
        // Assert
        expect(result).toBe(true);
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
  describe("When ignoreWhitespace is 'all'", () => {
    it("Then mode is 'all'", () => {
      // Arrange
      const sut = resolveLineKey;
      // Act
      const result = sut({ ignoreWhitespace: 'all' });
      // Assert
      expect(result.mode).toBe('all');
    });
  });

  describe("When ignoreWhitespace is 'change'", () => {
    it("Then mode is 'change'", () => {
      // Arrange
      const sut = resolveLineKey;
      // Act
      const result = sut({ ignoreWhitespace: 'change' });
      // Assert
      expect(result.mode).toBe('change');
    });
  });

  describe("When ignoreWhitespace is 'at-eol'", () => {
    it("Then mode is 'at-eol'", () => {
      // Arrange
      const sut = resolveLineKey;
      // Act
      const result = sut({ ignoreWhitespace: 'at-eol' });
      // Assert
      expect(result.mode).toBe('at-eol');
    });
  });

  describe('When ignoreWhitespace is absent', () => {
    it("Then mode is 'none'", () => {
      // Arrange
      const sut = resolveLineKey;
      // Act
      const result = sut({});
      // Assert
      expect(result.mode).toBe('none');
    });
  });

  describe('When ignoreCrAtEol is true', () => {
    it('Then ignoreCrAtEol is true on the key', () => {
      // Arrange
      const sut = resolveLineKey;
      // Act
      const result = sut({ ignoreCrAtEol: true });
      // Assert
      expect(result.ignoreCrAtEol).toBe(true);
    });
  });

  describe('When ignoreCrAtEol is absent', () => {
    it('Then ignoreCrAtEol is false on the key', () => {
      // Arrange
      const sut = resolveLineKey;
      // Act
      const result = sut({});
      // Assert
      expect(result.ignoreCrAtEol).toBe(false);
    });
  });

  describe('When ignoreBlankLines is set', () => {
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
    describe(`Given mode '${mode}' and ignoreCrAtEol false`, () => {
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

  describe("Given mode 'none' and ignoreCrAtEol true", () => {
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
