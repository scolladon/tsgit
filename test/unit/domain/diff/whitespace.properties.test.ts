import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { LineKey, WhitespaceMode } from '../../../../src/domain/diff/whitespace.js';
import { linesEqualUnder, normalizeLine } from '../../../../src/domain/diff/whitespace.js';
import { bytesEqual } from '../../../../src/domain/objects/encoding.js';

// Arbitrary: a UTF-8 line (ASCII printable, no space/tab) plus optional LF terminator
function arbPrintableBytes(withLf: boolean): fc.Arbitrary<Uint8Array> {
  return fc
    .array(fc.integer({ min: 0x21, max: 0x7e }), { minLength: 0, maxLength: 32 })
    .map((codes) => {
      const suffix = withLf ? [0x0a] : [];
      return new Uint8Array([...codes, ...suffix]);
    });
}

// Arbitrary: a line with spaces/tabs randomly interspersed (no control chars)
function arbLineWithWhitespace(): fc.Arbitrary<Uint8Array> {
  const ws = fc.constantFrom(0x20, 0x09); // space or tab
  const nonWs = fc.integer({ min: 0x21, max: 0x7e });
  const byte = fc.oneof(ws, nonWs);
  return fc
    .tuple(
      fc.array(byte, { minLength: 0, maxLength: 32 }),
      fc.boolean(), // include LF terminator?
    )
    .map(([codes, withLf]) => {
      const suffix = withLf ? [0x0a] : [];
      return new Uint8Array([...codes, ...suffix]);
    });
}

// Build a whitespace-only re-sprinkling of a base line:
// insert spaces/tabs at arbitrary positions (without changing non-ws bytes)
function arbResprinkle(base: Uint8Array): fc.Arbitrary<Uint8Array> {
  // keep non-ws bytes from base; insert random ws runs between them
  const nonWsBytes = Array.from(base).filter((b) => b !== 0x20 && b !== 0x09 && b !== 0x0a);
  const hasLf = base.length > 0 && base[base.length - 1] === 0x0a;
  const ws = fc.array(fc.constantFrom(0x20, 0x09), { minLength: 0, maxLength: 4 });
  // one ws slot before each non-ws byte plus one at the end (before LF)
  return fc
    .array(ws, { minLength: nonWsBytes.length + 1, maxLength: nonWsBytes.length + 1 })
    .map((wsSlots) => {
      const result: number[] = [];
      for (let i = 0; i < nonWsBytes.length; i++) {
        result.push(...(wsSlots[i] ?? []));
        result.push(nonWsBytes[i] as number);
      }
      result.push(...(wsSlots[nonWsBytes.length] ?? []));
      if (hasLf) result.push(0x0a);
      return new Uint8Array(result);
    });
}

const ALL_MODES: ReadonlyArray<WhitespaceMode> = ['all', 'change', 'at-eol', 'none'];

function arbLineKey(): fc.Arbitrary<LineKey> {
  return fc.record({
    mode: fc.constantFrom(...ALL_MODES),
    ignoreCrAtEol: fc.boolean(),
  });
}

describe('whitespace normalizer properties', () => {
  describe('Given an arbitrary line and mode', () => {
    describe('When normalizeLine is applied twice (idempotence)', () => {
      it('Then the second application yields the same result as the first', () => {
        // Arrange
        fc.assert(
          fc.property(arbLineWithWhitespace(), arbLineKey(), (lineBytes, key) => {
            // Act
            const once = normalizeLine(lineBytes, key);
            const twice = normalizeLine(once, key);
            // Assert
            expect(bytesEqual(once, twice)).toBe(true);
          }),
          { numRuns: 200 },
        );
      });
    });
  });

  describe('Given arbitrary lines a and b', () => {
    describe("When linesEqualUnder(a, b, {mode:'change',...}) is true (dominance)", () => {
      it("Then linesEqualUnder(a, b, {mode:'all',...}) is also true", () => {
        // Arrange
        fc.assert(
          fc.property(
            arbLineWithWhitespace(),
            arbLineWithWhitespace(),
            fc.boolean(),
            (a, b, ignoreCrAtEol) => {
              const changeKey: LineKey = { mode: 'change', ignoreCrAtEol };
              const allKey: LineKey = { mode: 'all', ignoreCrAtEol };
              // Act
              const changeEqual = linesEqualUnder(a, b, changeKey);
              const allEqual = linesEqualUnder(a, b, allKey);
              // Assert: if change says equal, all must also say equal
              if (changeEqual) {
                expect(allEqual).toBe(true);
              }
            },
          ),
          { numRuns: 100 },
        );
      });
    });
  });

  describe('Given an arbitrary line x and key k', () => {
    describe('When linesEqualUnder(x, x, k) is called (reflexivity)', () => {
      it('Then always returns true', () => {
        // Arrange
        fc.assert(
          fc.property(arbLineWithWhitespace(), arbLineKey(), (x, key) => {
            // Act
            const result = linesEqualUnder(x, x, key);
            // Assert
            expect(result).toBe(true);
          }),
          { numRuns: 100 },
        );
      });
    });
  });

  describe("Given an arbitrary base line x and a whitespace re-sprinkling x'", () => {
    describe("When linesEqualUnder(x, x', {mode:'all', ignoreCrAtEol:false}) is called", () => {
      it('Then always returns true (whitespace-only equivalence under all)', () => {
        // Arrange
        fc.assert(
          fc.property(
            arbPrintableBytes(true).chain((base) =>
              arbResprinkle(base).map((resprinkled) => ({ base, resprinkled })),
            ),
            ({ base, resprinkled }) => {
              const key: LineKey = { mode: 'all', ignoreCrAtEol: false };
              // Act
              const result = linesEqualUnder(base, resprinkled, key);
              // Assert
              expect(result).toBe(true);
            },
          ),
          { numRuns: 100 },
        );
      });
    });
  });
});
