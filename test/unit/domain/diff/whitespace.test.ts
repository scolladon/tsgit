import { describe, expect, it } from 'vitest';
import type {
  LineDigest,
  LineKey,
  WhitespaceMode,
} from '../../../../src/domain/diff/whitespace.js';
import {
  createLineDigestFold,
  digestIsBlank,
  digestNormalizedLine,
  digestsEqual,
  isBlankLine,
  lineKeyIsActive,
  linesEqualUnder,
  NONE_KEY,
  normalizeLine,
  resolveLineKey,
} from '../../../../src/domain/diff/whitespace.js';
import { expectedDigest } from './digest-oracle.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

// Build a line exactly as splitLines would return it: content + optional LF terminator
const line = (s: string): Uint8Array => enc(s);

const ALL_LINE_KEYS: ReadonlyArray<LineKey> = (
  ['all', 'change', 'at-eol', 'none'] as const
).flatMap((mode) => [
  { mode, ignoreCrAtEol: false },
  { mode, ignoreCrAtEol: true },
]);

describe('normalizeLine', () => {
  describe("Given mode 'all' (ignore all space/tab)", () => {
    const key: LineKey = { mode: 'all', ignoreCrAtEol: false };

    describe('When the line has whitespace to drop', () => {
      it.each([
        {
          input: 'a b\n',
          expected: 'ab',
          label:
            'internal spaces are dropped and the terminator is stripped under an active key (W1, C4)',
        },
        {
          input: '\tbeta gamma\n',
          expected: 'betagamma',
          label: 'a tab byte is dropped along with space bytes and the terminator (W1, C4)',
        },
        {
          input: 'a\r\n',
          expected: 'a',
          label:
            'a trailing CR is dropped as part of all-whitespace removal, and the terminator too (CR1, C4)',
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
        // Arrange & Act
        const a = normalizeLine(line('x\n'), key);
        const b = normalizeLine(line('  x\n'), key);
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
          expected: 'a b',
          label:
            'a run ending a terminated line drops the collapsed trailing space and the terminator (C4)',
        },
        {
          input: 'a b   ',
          expected: 'a b',
          label: 'a run ending an unterminated line drops the collapsed trailing space (no LF)',
        },
        {
          // guards the pop against firing on a non-space last byte
          input: 'ab\n',
          expected: 'ab',
          label:
            'the line ending in a non-whitespace byte leaves the final byte intact, terminator stripped (C4)',
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
        // Arrange & Act
        const a = normalizeLine(line('a\n'), key);
        const b = normalizeLine(line('a   \n'), key);
        // Assert
        expect(a).toEqual(b);
      });
    });

    describe('When trailing whitespace before the LF is normalized', () => {
      it.each([
        {
          // pins the terminator byte, not just cross-line equality
          input: 'a   \n',
          expected: 'a',
          label:
            'trailing whitespace preceding the LF terminator drops the run and, under an active key, the terminator too (C4)',
        },
        {
          input: '   \n',
          expected: '',
          label:
            'a line entirely whitespace before the LF collapses to empty content, terminator stripped (C4)',
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
        // Arrange & Act
        const withCr = normalizeLine(line('a\r\n'), key);
        const withoutCr = normalizeLine(line('a\n'), key);
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
        const input = line('a b\n');
        // Act
        const result = normalizeLine(input, key);
        // Assert
        expect(result).toEqual(input);
      });
    });

    describe('When a trailing CR precedes the LF terminator', () => {
      it('Then the CR is preserved (none mode never drops the CR)', () => {
        // Arrange — without ignoreCrAtEol the CR is significant content
        const input = line('a\r\n');
        // Act
        const result = normalizeLine(input, key);
        // Assert
        expect(result).toEqual(enc('a\r\n'));
      });
    });
  });

  describe('Given ignoreCrAtEol: true with mode none', () => {
    const key: LineKey = { mode: 'none', ignoreCrAtEol: true };

    describe('When a trailing CR is present before the LF (CR1)', () => {
      it('Then drops the trailing CR', () => {
        // Arrange & Act
        const withCr = normalizeLine(line('a\r\n'), key);
        const withoutCr = normalizeLine(line('a\n'), key);
        // Assert
        expect(withCr).toEqual(withoutCr);
      });
    });

    describe('When a CR appears mid-line (not at EOL)', () => {
      it('Then the mid-line CR is preserved (CR-narrow)', () => {
        // Arrange & Act
        const a = normalizeLine(line('a\rb\n'), key);
        const b = normalizeLine(line('ab\n'), key);
        // Assert
        expect(a).not.toEqual(b);
      });
    });

    describe('When a trailing CR ends an incomplete final line (no LF)', () => {
      it('Then the CR is kept as content, not stripped as whitespace (C6)', () => {
        // Arrange & Act
        const result = normalizeLine(line('x y\r'), key);
        // Assert
        expect(result).toEqual(enc('x y\r'));
      });
    });

    describe('When the CR guard is evaluated near unterminated or CR-free content', () => {
      it.each([
        {
          input: 'a\r',
          expected: 'a\r',
          label:
            'a trailing CR ending unterminated content (no final LF) is content, not whitespace, and is kept (C6)',
        },
        {
          // the crPos === 0 boundary of the CR guard is exercised by the
          // terminated counterpart of this input, in the branch-exhaustive suite
          input: '\r',
          expected: '\r',
          label: 'unterminated content that is a single CR is kept as content, not dropped (C6)',
        },
        {
          input: 'a  \n',
          expected: 'a  ',
          label:
            'when no CR is present, trailing space is preserved but the terminator is stripped (ignoreCrAtEol activates the key, C4)',
        },
      ])('Then $label', ({ input, expected }) => {
        // Arrange + Act
        const result = normalizeLine(line(input), key);
        // Assert
        expect(result).toEqual(enc(expected));
      });
    });
  });

  describe('Given a long line whose normalization removes bytes', () => {
    // The output is built in ONE buffer sized for the input and returned as a
    // view of it. A per-byte `number[]` accumulator would instead cost ~8 bytes
    // plus growth slack per INPUT byte before the copy — an order-of-magnitude
    // amplification on a line whose length is bounded only by the blob's.
    const input = enc(`${'a   b\t\t\tc'.repeat(1_000)}\n`);

    describe("When normalizeLine runs under mode 'all'", () => {
      it('Then the result views a buffer sized for the input, not one sized for the output', () => {
        // Arrange & Act
        const result = normalizeLine(input, { mode: 'all', ignoreCrAtEol: false });
        // Assert
        expect(result.length).toBeLessThan(input.length);
        expect(result.buffer.byteLength).toBe(input.length);
      });
    });

    describe("When normalizeLine runs under mode 'change'", () => {
      it('Then the result views a buffer sized for the input, not one sized for the output', () => {
        // Arrange & Act
        const result = normalizeLine(input, { mode: 'change', ignoreCrAtEol: false });
        // Assert
        expect(result.length).toBeLessThan(input.length);
        expect(result.buffer.byteLength).toBe(input.length);
      });
    });
  });

  describe('Given an unterminated line (no trailing LF, as with last line in no-newline file)', () => {
    const key: LineKey = { mode: 'at-eol', ignoreCrAtEol: false };

    describe('When trailing whitespace is in an unterminated line', () => {
      it('Then drops trailing whitespace before end of content (D2 support)', () => {
        // Arrange & Act
        const a = normalizeLine(enc('a'), key);
        const b = normalizeLine(enc('a   '), key);
        // Assert
        expect(a).toEqual(b);
      });
    });
  });
});

describe('normalizeLine — C4: a final-line terminator is whitespace under an active key', () => {
  const ACTIVE_SHAPES: ReadonlyArray<{ readonly label: string; readonly key: LineKey }> = [
    { label: "mode 'all'", key: { mode: 'all', ignoreCrAtEol: false } },
    { label: "mode 'change'", key: { mode: 'change', ignoreCrAtEol: false } },
    { label: "mode 'at-eol'", key: { mode: 'at-eol', ignoreCrAtEol: false } },
    { label: "mode 'none' with ignoreCrAtEol", key: { mode: 'none', ignoreCrAtEol: true } },
  ];

  describe('Given every active key shape, When a terminated line is compared to its unterminated counterpart', () => {
    it.each(
      ACTIVE_SHAPES.flatMap(({ label, key }) => [
        {
          key,
          terminated: 'ab\n',
          unterminated: 'ab',
          label: `${label}, a non-blank line`,
        },
        {
          key,
          terminated: '\n',
          unterminated: '',
          label: `${label}, a blank line`,
        },
      ]),
    )(
      'Then $label normalizes both forms to the same bytes',
      ({ key, terminated, unterminated }) => {
        // Arrange + Act
        const withLf = normalizeLine(enc(terminated), key);
        const withoutLf = normalizeLine(enc(unterminated), key);
        // Assert
        expect(withLf).toEqual(withoutLf);
      },
    );
  });

  describe("Given the inactive key ({ mode: 'none', ignoreCrAtEol: false })", () => {
    describe('When a terminated line is compared to its unterminated counterpart', () => {
      it('Then the two forms remain distinct (the terminator stays significant)', () => {
        // Arrange
        const key: LineKey = { mode: 'none', ignoreCrAtEol: false };
        // Act
        const withLf = normalizeLine(enc('ab\n'), key);
        const withoutLf = normalizeLine(enc('ab'), key);
        // Assert
        expect(withLf).not.toEqual(withoutLf);
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
        // Arrange & Act
        const result = linesEqualUnder(line('a\n'), line('a   \n'), key);
        // Assert
        expect(result).toBe(true);
      });
    });

    describe('When internal whitespace also differs (W3)', () => {
      it('Then returns false', () => {
        // Arrange & Act
        const result = linesEqualUnder(line('\tbeta gamma\n'), line('  beta  gamma   \n'), key);
        // Assert
        expect(result).toBe(false);
      });
    });

    describe('When only the final terminator differs (C4)', () => {
      it('Then returns true (linesEqualUnder inherits the C4 rule)', () => {
        // Arrange & Act
        const result = linesEqualUnder(line('a'), line('a\n'), key);
        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe("Given mode 'none'", () => {
    const key: LineKey = { mode: 'none', ignoreCrAtEol: false };

    describe('When trailing whitespace differs', () => {
      it('Then returns false (exact compare)', () => {
        // Arrange & Act
        const result = linesEqualUnder(line('a\n'), line('a   \n'), key);
        // Assert
        expect(result).toBe(false);
      });
    });

    describe('When only the final terminator differs (C4 does not apply, inactive key)', () => {
      it('Then returns false (the terminator stays significant)', () => {
        // Arrange & Act
        const result = linesEqualUnder(line('a'), line('a\n'), key);
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
      // Arrange & Act
      const result = resolveLineKey({ ignoreCrAtEol: true });
      // Assert
      expect(result.ignoreCrAtEol).toBe(true);
    });
  });

  describe('Given ignoreCrAtEol is absent, When resolveLineKey runs', () => {
    it('Then ignoreCrAtEol is false on the key', () => {
      // Arrange & Act
      const result = resolveLineKey({});
      // Assert
      expect(result.ignoreCrAtEol).toBe(false);
    });
  });

  describe('Given ignoreBlankLines is set, When resolveLineKey runs', () => {
    it('Then ignoreBlankLines does NOT appear on the returned LineKey', () => {
      // Arrange & Act
      const result = resolveLineKey({ ignoreBlankLines: true });
      // Assert
      // LineKey only has mode and ignoreCrAtEol
      expect(Object.keys(result).sort()).toEqual(['ignoreCrAtEol', 'mode']);
    });
  });
});

describe('lineKeyIsActive', () => {
  describe('Given a lineKey mode with ignoreCrAtEol false', () => {
    describe('When lineKeyIsActive runs', () => {
      it.each([
        { mode: 'all' as const, expected: true, label: "mode 'all' returns true" },
        { mode: 'change' as const, expected: true, label: "mode 'change' returns true" },
        { mode: 'at-eol' as const, expected: true, label: "mode 'at-eol' returns true" },
        { mode: 'none' as const, expected: false, label: "mode 'none' returns false" },
      ])('Then $label', ({ mode, expected }) => {
        // Arrange
        const key: LineKey = { mode, ignoreCrAtEol: false };

        // Act
        const result = lineKeyIsActive(key);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });

  describe("Given mode 'none' and ignoreCrAtEol true", () => {
    describe('When lineKeyIsActive runs', () => {
      it('Then returns true because ignoreCrAtEol alone activates the key', () => {
        // Arrange
        const key: LineKey = { mode: 'none', ignoreCrAtEol: true };

        // Act
        const result = lineKeyIsActive(key);

        // Assert
        expect(result).toBe(true);
      });
    });
  });
});

describe('NONE_KEY', () => {
  describe('Given the constant, When normalizeLine is called on a line with a trailing CR', () => {
    it('Then the CR is preserved (ignoreCrAtEol is false)', () => {
      // Arrange
      const input = line('a\r\n');
      // Act
      const result = normalizeLine(input, NONE_KEY);
      // Assert
      expect(result).toEqual(enc('a\r\n'));
    });
  });
});

describe('digestNormalizedLine', () => {
  describe('Given two lines equal under normalizeLine, When digesting both', () => {
    it.each([
      {
        mode: 'all' as const,
        left: '\tbeta gamma\n',
        right: '  beta  gamma   \n',
        label: "mode 'all': whitespace-only difference (W1) digests equal",
      },
      {
        mode: 'change' as const,
        left: 'a b\n',
        right: 'a    b\n',
        label: "mode 'change': a run growing but staying non-zero (B-run) digests equal",
      },
      {
        mode: 'at-eol' as const,
        left: 'a\n',
        right: 'a   \n',
        label: "mode 'at-eol': trailing whitespace added (EOL1) digests equal",
      },
    ])('Then $label', ({ mode, left, right }) => {
      // Arrange
      const key: LineKey = { mode, ignoreCrAtEol: false };
      const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

      // Act
      const leftDigest = digestNormalizedLine(enc(left), key);
      const rightDigest = digestNormalizedLine(enc(right), key);

      // Assert
      expect(digestsEqual(leftDigest, rightDigest)).toBe(true);
    });
  });

  describe('Given two lines that differ in real content under a given mode, When digesting both', () => {
    it.each([
      {
        mode: 'all' as const,
        left: 'real\n',
        right: 'REAL\n',
        label: "mode 'all': non-whitespace content differs, digests unequal",
      },
      {
        mode: 'change' as const,
        left: 'a b\n',
        right: 'ab\n',
        label: "mode 'change': internal space fully removed (B-zero) digests unequal",
      },
      {
        mode: 'at-eol' as const,
        left: '\tbeta gamma\n',
        right: '  beta  gamma   \n',
        label: "mode 'at-eol': internal whitespace differs (W3) digests unequal",
      },
      {
        mode: 'none' as const,
        left: 'a b\n',
        right: 'ab\n',
        label: "mode 'none': exact compare, whitespace difference digests unequal",
      },
    ])('Then $label', ({ mode, left, right }) => {
      // Arrange
      const key: LineKey = { mode, ignoreCrAtEol: false };
      const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

      // Act
      const leftDigest = digestNormalizedLine(enc(left), key);
      const rightDigest = digestNormalizedLine(enc(right), key);

      // Assert
      expect(digestsEqual(leftDigest, rightDigest)).toBe(false);
    });
  });

  describe('Given a line whose trailing whitespace run touches the content boundary, When digesting under mode change', () => {
    it('Then the collapsed trailing space is dropped from the digest', () => {
      // Arrange
      const key: LineKey = { mode: 'change', ignoreCrAtEol: false };
      const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

      // Act
      const withTrailingRun = digestNormalizedLine(enc('a b \n'), key);
      const withoutTrailingRun = digestNormalizedLine(enc('a b\n'), key);

      // Assert
      expect(digestsEqual(withTrailingRun, withoutTrailingRun)).toBe(true);
    });
  });

  describe('Given a line whose trailing whitespace run touches the content boundary, When digesting under mode at-eol', () => {
    it('Then an internal (non-trailing) run stays intact while the trailing one is dropped', () => {
      // Arrange — internal run preserved verbatim (not collapsed), trailing run dropped
      const key: LineKey = { mode: 'at-eol', ignoreCrAtEol: false };
      const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

      // Act
      const digest = digestNormalizedLine(enc('a  b   \n'), key);
      const expected = digestNormalizedLine(enc('a  b\n'), key);

      // Assert
      expect(digestsEqual(digest, expected)).toBe(true);
    });
  });

  describe('Given a terminated line and its unterminated content-identical counterpart, When digesting both', () => {
    it('Then the digests are unequal (terminator is significant)', () => {
      // Arrange
      const key: LineKey = { mode: 'none', ignoreCrAtEol: false };
      const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

      // Act
      const terminated = digestNormalizedLine(enc('a\n'), key);
      const unterminated = digestNormalizedLine(enc('a'), key);

      // Assert
      expect(digestsEqual(terminated, unterminated)).toBe(false);
    });
  });

  describe('Given ignoreCrAtEol true with mode none, When digesting a CR-terminated line', () => {
    const key: LineKey = { mode: 'none', ignoreCrAtEol: true };

    it('Then a trailing CR before the LF is dropped from the digest', () => {
      // Arrange & Act
      const withCr = digestNormalizedLine(new TextEncoder().encode('a\r\n'), key);
      const withoutCr = digestNormalizedLine(new TextEncoder().encode('a\n'), key);

      // Assert
      expect(digestsEqual(withCr, withoutCr)).toBe(true);
    });
  });

  describe('Given ignoreCrAtEol true with mode none, When digesting an incomplete final line ending in CR', () => {
    const key: LineKey = { mode: 'none', ignoreCrAtEol: true };

    it('Then the CR is content, not whitespace — the digest differs from its terminated counterpart (C6)', () => {
      // Arrange & Act
      const unterminated = digestNormalizedLine(new TextEncoder().encode('x y\r'), key);
      const terminated = digestNormalizedLine(new TextEncoder().encode('x y\r\n'), key);

      // Assert
      expect(digestsEqual(unterminated, terminated)).toBe(false);
    });
  });
});

describe('digestNormalizedLine — C4: a final-line terminator is whitespace under an active key', () => {
  describe('Given "x y" (unterminated) and "x y\\n" (terminated), When digesting both under every LineKey shape', () => {
    it.each(
      ALL_LINE_KEYS.map((key) => ({
        key,
        active: lineKeyIsActive(key),
        label: `mode ${key.mode} ignoreCrAtEol=${key.ignoreCrAtEol}`,
      })),
    )('Then $label digests equal iff the key is active', ({ key, active }) => {
      // Arrange
      const terminated = digestNormalizedLine(enc('x y\n'), key);
      const unterminated = digestNormalizedLine(enc('x y'), key);

      // Act
      const result = digestsEqual(terminated, unterminated);

      // Assert
      expect(result).toBe(active);
    });
  });
});

describe('digestNormalizedLine — branch-exhaustive cross-check', () => {
  describe('Given a line and key exercising a specific digest branch, When digested', () => {
    it.each([
      {
        mode: 'none' as WhitespaceMode,
        ignoreCrAtEol: false,
        input: 'a\r\n',
        label: "a CR is retained under mode 'none' without ignoreCrAtEol (crApplies is false)",
      },
      {
        mode: 'all' as WhitespaceMode,
        ignoreCrAtEol: false,
        input: 'a\r\n',
        label:
          "a CR is dropped under mode 'all' without ignoreCrAtEol (crApplies is true via mode!=='none' alone)",
      },
      {
        mode: 'none' as WhitespaceMode,
        ignoreCrAtEol: true,
        input: '\r\n',
        label:
          'a lone CR at the content-start boundary is stripped under ignoreCrAtEol (crPos===0)',
      },
      {
        mode: 'all' as WhitespaceMode,
        ignoreCrAtEol: false,
        input: 'ab\n',
        label:
          'an all-mode line with no trailing CR takes the non-CR ternary branch and keeps every byte',
      },
      {
        mode: 'none' as WhitespaceMode,
        ignoreCrAtEol: false,
        input: 'a',
        label: "an unterminated mode 'none' line never mixes a synthetic terminator into the hash",
      },
      {
        mode: 'all' as WhitespaceMode,
        ignoreCrAtEol: false,
        input: 'ab',
        label: 'an unterminated all-mode line never mixes a synthetic terminator into the hash',
      },
      {
        mode: 'all' as WhitespaceMode,
        ignoreCrAtEol: false,
        input: 'a  b\n',
        label: 'an all-mode internal run of two spaces is fully dropped, not collapsed to one',
      },
      {
        mode: 'change' as WhitespaceMode,
        ignoreCrAtEol: false,
        input: 'ab\n',
        label:
          'a change-mode line starting with non-whitespace never injects a phantom leading space',
      },
      {
        mode: 'change' as WhitespaceMode,
        ignoreCrAtEol: false,
        input: 'a bc\n',
        label:
          "a change-mode run's collapse state resets after each run, not sticking to the next byte",
      },
      {
        mode: 'change' as WhitespaceMode,
        ignoreCrAtEol: false,
        input: 'ab',
        label: 'an unterminated change-mode line never mixes a synthetic terminator into the hash',
      },
      {
        mode: 'at-eol' as WhitespaceMode,
        ignoreCrAtEol: false,
        input: '  b\n',
        label:
          "an at-eol leading run's start index is captured on its first whitespace byte, not lost",
      },
      {
        mode: 'at-eol' as WhitespaceMode,
        ignoreCrAtEol: false,
        input: 'ab\n',
        label: 'an at-eol line with no whitespace run never enters the commit-run branch',
      },
      {
        mode: 'at-eol' as WhitespaceMode,
        ignoreCrAtEol: false,
        input: 'a b c\n',
        label: "an at-eol run commit resets its start sentinel to 'no run', not to a stray index",
      },
      {
        mode: 'at-eol' as WhitespaceMode,
        ignoreCrAtEol: false,
        input: 'ab',
        label: 'an unterminated at-eol line never mixes a synthetic terminator into the hash',
      },
      {
        mode: 'at-eol' as WhitespaceMode,
        ignoreCrAtEol: false,
        input: 'a  b\n',
        label:
          'an at-eol internal run commits exactly its whitespace bytes, not the byte after it too',
      },
      {
        mode: 'at-eol' as WhitespaceMode,
        ignoreCrAtEol: false,
        input: 'a   b\n',
        label:
          "an at-eol run's start index stays pinned across the whole run, not just its last byte",
      },
    ])(
      'Then the digest matches the independent normalizeLine+FNV oracle ($label)',
      ({ mode, ignoreCrAtEol, input }) => {
        // Arrange
        const key: LineKey = { mode, ignoreCrAtEol };
        const bytes = enc(input);

        // Act
        const result = digestNormalizedLine(bytes, key);

        // Assert
        expect(result).toEqual(expectedDigest(bytes, key));
      },
    );
  });
});

describe('digestNormalizedLine — tail-grammar exhaustive rows', () => {
  // The four worked cases from the tail grammar TAIL := WS* CR?, each run
  // against every LineKey shape and both termination states.
  const TAIL_CASES = ['a  \r', 'a \r ', 'a\r\r', 'a  \r  '] as const;

  describe('Given every LineKey shape and termination state, When a tail-grammar line is digested', () => {
    const rows = ALL_LINE_KEYS.flatMap((key) =>
      [false, true].flatMap((terminated) =>
        TAIL_CASES.map((tail) => {
          const input = terminated ? `${tail}\n` : tail;
          const shape = `mode ${key.mode} ignoreCrAtEol=${key.ignoreCrAtEol} ${
            terminated ? 'terminated' : 'unterminated'
          }`;
          return { key, input, label: `${shape} "${tail.replace(/\r/g, '\\r')}"` };
        }),
      ),
    );

    it.each(rows)('Then $label matches the independent oracle', ({ key, input }) => {
      // Arrange
      const bytes = enc(input);

      // Act
      const result = digestNormalizedLine(bytes, key);

      // Assert
      expect(result).toEqual(expectedDigest(bytes, key));
    });
  });

  describe('Given a leading whitespace run, When digesting under change vs at-eol', () => {
    it.each([
      {
        mode: 'change' as const,
        input: '  a',
        label: "mode 'change' collapses a leading space run to one SPACE",
      },
      {
        mode: 'change' as const,
        input: '\ta',
        label: "mode 'change' collapses a leading tab run to one SPACE",
      },
      {
        mode: 'at-eol' as const,
        input: '  a',
        label: "mode 'at-eol' preserves a leading space run verbatim",
      },
      {
        mode: 'at-eol' as const,
        input: '\ta',
        label: "mode 'at-eol' preserves a leading tab run verbatim",
      },
    ])('Then $label, matching the independent oracle', ({ mode, input }) => {
      // Arrange
      const key: LineKey = { mode, ignoreCrAtEol: false };
      const bytes = enc(input);

      // Act
      const result = digestNormalizedLine(bytes, key);

      // Assert
      expect(result).toEqual(expectedDigest(bytes, key));
    });
  });

  describe('Given a line whose whole content is tail, When digesting under every LineKey shape', () => {
    const ALL_TAIL_CASES = ['   ', '\r', '', '\n'] as const;
    const rows = ALL_LINE_KEYS.flatMap((key) =>
      ALL_TAIL_CASES.map((input) => ({
        key,
        input,
        label: `mode ${key.mode} ignoreCrAtEol=${key.ignoreCrAtEol} on ${JSON.stringify(input)}`,
      })),
    );

    it.each(rows)('Then $label matches the independent oracle', ({ key, input }) => {
      // Arrange
      const bytes = enc(input);

      // Act
      const result = digestNormalizedLine(bytes, key);

      // Assert
      expect(result).toEqual(expectedDigest(bytes, key));
    });
  });

  describe('Given a reviewer-adversarial CR-adjacent shape, When digesting under every LineKey shape', () => {
    // blind-spot 5: multiple CRs sharing a line with whitespace runs, and a CR
    // as the very first content byte.
    const BLIND_SPOT_CASES = ['a\r \r', '  \r  \r', '\r', '\ra'] as const;
    const rows = ALL_LINE_KEYS.flatMap((key) =>
      BLIND_SPOT_CASES.map((input) => ({
        key,
        input,
        label: `mode ${key.mode} ignoreCrAtEol=${key.ignoreCrAtEol} on ${JSON.stringify(input)}`,
      })),
    );

    it.each(rows)('Then $label matches the independent oracle', ({ key, input }) => {
      // Arrange
      const bytes = enc(input);

      // Act
      const result = digestNormalizedLine(bytes, key);

      // Assert
      expect(result).toEqual(expectedDigest(bytes, key));
    });
  });
});

describe('createLineDigestFold', () => {
  describe('Given a fresh fold, When no byte has been pushed yet', () => {
    it('Then lineHasBytes is false', () => {
      // Arrange
      const sut = createLineDigestFold(NONE_KEY);

      // Act & Assert
      expect(sut.lineHasBytes).toBe(false);
    });
  });

  describe('Given a fold that has received a content byte, When lineHasBytes is read', () => {
    it('Then lineHasBytes is true', () => {
      // Arrange
      const sut = createLineDigestFold(NONE_KEY);

      // Act
      sut.push(0x61); // 'a'

      // Assert
      expect(sut.lineHasBytes).toBe(true);
    });
  });

  describe('Given a fold that just finished a line, When endLine resets the per-line state', () => {
    it('Then lineHasBytes reports false again', () => {
      // Arrange
      const sut = createLineDigestFold(NONE_KEY);
      sut.push(0x61); // 'a'
      sut.push(0x0a); // LF

      // Act
      sut.endLine();

      // Assert
      expect(sut.lineHasBytes).toBe(false);
    });
  });

  describe('Given a byte that is not the LF terminator, When push is called', () => {
    it('Then push returns false', () => {
      // Arrange
      const sut = createLineDigestFold(NONE_KEY);

      // Act
      const result = sut.push(0x61); // 'a'

      // Assert
      expect(result).toBe(false);
    });
  });

  describe('Given the LF terminator byte, When push is called', () => {
    it('Then push returns true', () => {
      // Arrange
      const sut = createLineDigestFold(NONE_KEY);

      // Act
      const result = sut.push(0x0a);

      // Assert
      expect(result).toBe(true);
    });
  });

  describe('Given a fold driven byte-by-byte over a whole line, When endLine is called', () => {
    it('Then the emitted digest matches digestNormalizedLine over the same bytes', () => {
      // Arrange
      const key: LineKey = { mode: 'change', ignoreCrAtEol: true };
      const bytes = enc('a  b\r\n');
      const sut = createLineDigestFold(key);
      for (let i = 0; i < bytes.length; i++) sut.push(bytes[i] as number);

      // Act
      const result = sut.endLine();

      // Assert
      expect(result).toEqual(digestNormalizedLine(bytes, key));
    });
  });
});

describe('digestsEqual', () => {
  describe('Given two digests whose length differs but terminated and hash match, When comparing them', () => {
    it('Then returns false (length is significant, not shadowed by hash agreement)', () => {
      // Arrange
      const a: LineDigest = { length: 1, terminated: true, hash: 99 };
      const b: LineDigest = { length: 2, terminated: true, hash: 99 };

      // Act
      const result = digestsEqual(a, b);

      // Assert
      expect(result).toBe(false);
    });
  });

  describe('Given two digests whose terminated flag differs but length and hash match, When comparing them', () => {
    it('Then returns false (terminated is significant, not shadowed by hash agreement)', () => {
      // Arrange
      const a: LineDigest = { length: 1, terminated: true, hash: 99 };
      const b: LineDigest = { length: 1, terminated: false, hash: 99 };

      // Act
      const result = digestsEqual(a, b);

      // Assert
      expect(result).toBe(false);
    });
  });
});

describe('digestIsBlank', () => {
  describe("Given mode 'all' and a spaces-only line, When checking blankness", () => {
    it('Then reports blank (matches isBlankLine)', () => {
      // Arrange
      const key: LineKey = { mode: 'all', ignoreCrAtEol: false };
      const line = new TextEncoder().encode('   \n');

      // Act
      const result = digestIsBlank(digestNormalizedLine(line, key));

      // Assert
      expect(result).toBe(true);
      expect(result).toBe(isBlankLine(line, key));
    });
  });

  describe('Given NONE_KEY and a non-blank line, When checking blankness', () => {
    it('Then reports not blank', () => {
      // Arrange
      const line = new TextEncoder().encode('a\n');

      // Act
      const result = digestIsBlank(digestNormalizedLine(line, NONE_KEY));

      // Assert
      expect(result).toBe(false);
    });
  });
});

describe('isBlankLine', () => {
  describe("Given mode 'all'", () => {
    const key: LineKey = { mode: 'all', ignoreCrAtEol: false };

    describe('When the line normalizes to empty', () => {
      it('Then a spaces-only line is blank', () => {
        // Arrange & Act
        const result = isBlankLine(line('   \n'), key);
        // Assert
        expect(result).toBe(true);
      });
    });

    describe('When the line has a single non-whitespace char', () => {
      it('Then it is not blank (content length is 1, not 0)', () => {
        // Arrange & Act
        const result = isBlankLine(line('a\n'), key);
        // Assert
        expect(result).toBe(false);
      });
    });

    describe('When the same spaces-only line is unterminated (C4 regression)', () => {
      it('Then it is still blank — isBlankLine is unaffected by the terminator fix', () => {
        // Arrange & Act
        const result = isBlankLine(line('   '), key);
        // Assert
        expect(result).toBe(true);
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
