import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { LineKey, WhitespaceMode } from '../../../../src/domain/diff/whitespace.js';
import {
  digestIsBlank,
  digestNormalizedLine,
  digestsEqual,
  isBlankLine,
  linesEqualUnder,
  normalizeLine,
} from '../../../../src/domain/diff/whitespace.js';
import { bytesEqual } from '../../../../src/domain/objects/encoding.js';
import { expectedDigest, FNV_OFFSET_BASIS } from './digest-oracle.js';

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

// Extends arbLineWithWhitespace's alphabet with CR, so a property drawing from
// it also exercises the fold's CR-tail handling (§D1.2), not just WS runs.
function arbLineWithWhitespaceAndCr(): fc.Arbitrary<Uint8Array> {
  const ws = fc.constantFrom(0x20, 0x09, 0x0d); // space, tab, or CR
  const nonWs = fc.integer({ min: 0x21, max: 0x7e });
  const byte = fc.oneof(ws, nonWs);
  return fc
    .tuple(fc.array(byte, { minLength: 0, maxLength: 32 }), fc.boolean())
    .map(([codes, withLf]) => {
      const suffix = withLf ? [0x0a] : [];
      return new Uint8Array([...codes, ...suffix]);
    });
}

// Arbitrary: a line over {a, b, SP, TAB, CR} with an optional trailing LF —
// denser CR/WS interleaving than arbLineWithWhitespace, for the bit-identity
// property that the fold's design rests on.
function arbCrLine(): fc.Arbitrary<Uint8Array> {
  const byte = fc.constantFrom(0x61, 0x62, 0x20, 0x09, 0x0d); // a, b, SP, TAB, CR
  return fc
    .tuple(fc.array(byte, { minLength: 0, maxLength: 16 }), fc.boolean())
    .map(([codes, withLf]) => new Uint8Array(withLf ? [...codes, 0x0a] : codes));
}

// Arbitrary: any byte except NUL, with LF only ever the optional trailing
// terminator — the fold's documented safe subset (no interior LF, no NUL).
function arbSafeLine(): fc.Arbitrary<Uint8Array> {
  const byte = fc.integer({ min: 1, max: 255 }).filter((b) => b !== 0x0a);
  return fc
    .tuple(fc.array(byte, { minLength: 0, maxLength: 64 }), fc.boolean())
    .map(([codes, withLf]) => new Uint8Array(withLf ? [...codes, 0x0a] : codes));
}

// Arbitrary: a whitespace-run-then-optional-CR tail — the fold's droppable
// TAIL grammar (WS* CR?) from §D1.2, nothing more.
function arbTailOnly(): fc.Arbitrary<Uint8Array> {
  return fc
    .tuple(fc.array(fc.constantFrom(0x20, 0x09), { minLength: 0, maxLength: 4 }), fc.boolean())
    .map(([ws, withCr]) => new Uint8Array(withCr ? [...ws, 0x0d] : ws));
}

// Arbitrary: a LineKey whose mode makes whitespace soft (excludes 'none').
function arbActiveModeKey(): fc.Arbitrary<LineKey> {
  return fc.record({
    mode: fc.constantFrom<WhitespaceMode>('all', 'change', 'at-eol'),
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

  describe('Given an arbitrary line x and key k', () => {
    describe('When digestNormalizedLine(x, k) is applied twice (reflexivity)', () => {
      it('Then digestsEqual reports the two digests equal', () => {
        // Arrange
        fc.assert(
          fc.property(arbLineWithWhitespace(), arbLineKey(), (x, key) => {
            // Act
            const once = digestNormalizedLine(x, key);
            const twice = digestNormalizedLine(x, key);
            // Assert
            expect(digestsEqual(once, twice)).toBe(true);
          }),
          { numRuns: 200 },
        );
      });
    });
  });

  describe('Given arbitrary CR-bearing lines a and b and an arbitrary key k', () => {
    describe('When digestsEqual(digest(a,k), digest(b,k)) is compared to linesEqualUnder(a,b,k)', () => {
      it('Then the predicate digest and the stat-path normalizer agree', () => {
        // Arrange
        fc.assert(
          fc.property(
            arbLineWithWhitespaceAndCr(),
            arbLineWithWhitespaceAndCr(),
            arbLineKey(),
            (a, b, key) => {
              // Act
              const digestVerdict = digestsEqual(
                digestNormalizedLine(a, key),
                digestNormalizedLine(b, key),
              );
              const normalizeVerdict = linesEqualUnder(a, b, key);
              // Assert
              expect(digestVerdict).toBe(normalizeVerdict);
            },
          ),
          { numRuns: 100 },
        );
      });
    });
  });

  describe('Given an arbitrary line x and key k', () => {
    describe('When digestIsBlank(digest(x,k)) is compared to isBlankLine(x,k)', () => {
      it('Then the digest blank flag agrees with the normalizer-derived blank check', () => {
        // Arrange
        fc.assert(
          fc.property(arbLineWithWhitespace(), arbLineKey(), (x, key) => {
            // Act
            const digestBlank = digestIsBlank(digestNormalizedLine(x, key));
            const normalizeBlank = isBlankLine(x, key);
            // Assert
            expect(digestBlank).toBe(normalizeBlank);
          }),
          { numRuns: 100 },
        );
      });
    });
  });

  // Lens 2 (compositional aggregator): the incremental fold is a left-fold
  // driving digestNormalizedLine — this is the property the whole design
  // rests on (§D1.5). The oracle allocates the normalized array via
  // normalizeLine and hashes it independently; it is not a copy of the fold.
  describe('Given an arbitrary line over {a, b, SP, TAB, CR} with an optional trailing LF, and an arbitrary key', () => {
    describe('When digestNormalizedLine folds it incrementally', () => {
      it('Then the digest matches the independent normalizeLine+FNV oracle, field by field', () => {
        // Arrange
        fc.assert(
          fc.property(arbCrLine(), arbLineKey(), (lineBytes, key) => {
            // Act
            const result = digestNormalizedLine(lineBytes, key);
            const expected = expectedDigest(lineBytes, key);
            // Assert
            expect(result.length).toBe(expected.length);
            expect(result.terminated).toBe(expected.terminated);
            expect(result.hash).toBe(expected.hash);
          }),
          { numRuns: 200 },
        );
      });
    });
  });

  // Lens 3 (total function over an algebraic grammar): no caps bound the fold
  // any more, so totality over the safe subset is itself the finding.
  describe('Given an arbitrary line over the safe subset (no NUL, no interior LF), and an arbitrary key', () => {
    describe('When digestNormalizedLine folds it', () => {
      it('Then it never throws and always returns a digest', () => {
        // Arrange
        fc.assert(
          fc.property(arbSafeLine(), arbLineKey(), (lineBytes, key) => {
            // Act
            const result = digestNormalizedLine(lineBytes, key);
            // Assert
            expect(result).toBeDefined();
          }),
          { numRuns: 100 },
        );
      });
    });
  });

  // Lens 2 (compositional aggregator): closeRun's promotion/drop invariants,
  // independent of the bit-identity oracle above.
  describe('closeRun invariants', () => {
    describe('Given an empty line, When digestNormalizedLine folds it under an arbitrary key', () => {
      it('Then the result is the identity digest', () => {
        // Arrange
        fc.assert(
          fc.property(arbLineKey(), (key) => {
            // Act
            const result = digestNormalizedLine(new Uint8Array(0), key);
            // Assert
            expect(result).toEqual({ length: 0, terminated: false, hash: FNV_OFFSET_BASIS });
          }),
          { numRuns: 100 },
        );
      });
    });

    describe('Given an unterminated line and an arbitrary key, When a hard byte is appended', () => {
      it('Then the digested length strictly increases', () => {
        // Arrange
        fc.assert(
          fc.property(
            arbLineWithWhitespace(),
            arbLineKey(),
            fc.constantFrom(0x61, 0x62, 0x63),
            (base, key, hardByte) => {
              const withoutLf =
                base.length > 0 && base[base.length - 1] === 0x0a
                  ? base.subarray(0, base.length - 1)
                  : base;
              const appended = new Uint8Array([...withoutLf, hardByte]);
              // Act
              const before = digestNormalizedLine(withoutLf, key);
              const after = digestNormalizedLine(appended, key);
              // Assert
              expect(after.length).toBeGreaterThan(before.length);
            },
          ),
          { numRuns: 100 },
        );
      });
    });

    describe('Given a hard-content-only base line and a WS* CR? tail, and a key where whitespace is soft', () => {
      describe('When the tail is appended to the base', () => {
        it('Then the emitted digest is unchanged', () => {
          // Arrange
          fc.assert(
            fc.property(
              arbPrintableBytes(false),
              arbTailOnly(),
              arbActiveModeKey(),
              (base, tail, key) => {
                const withTail = new Uint8Array([...base, ...tail]);
                // Act
                const before = digestNormalizedLine(base, key);
                const after = digestNormalizedLine(withTail, key);
                // Assert
                expect(digestsEqual(before, after)).toBe(true);
              },
            ),
            { numRuns: 100 },
          );
        });
      });
    });
  });

  // Lens 1 (round-trip) does not fit: a digest has no inverse, so there is no
  // decode/deserialize half to pair it with. Recorded per the four-lens
  // discipline rather than silently omitted.
});
