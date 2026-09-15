import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { matchRefGlob } from '../../../../src/domain/refs/ref-glob.js';

const asciiArb = fc.string({ minLength: 0, maxLength: 12 });
const literalArb = fc.stringMatching(/^[a-z/0-9-]{0,12}$/);
/** A single ASCII byte outside every glob metacharacter (`*?[]\`) — safe to
 *  escape or embed as a lone bracket member without perturbing the grammar. */
const plainCharArb = fc.stringMatching(/^[a-zA-Z0-9/]$/);

describe('Given any ASCII pattern and ref', () => {
  describe('When matching with matchRefGlob', () => {
    it('Then it never throws', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(asciiArb, asciiArb, (pattern, ref) => {
          expect(() => matchRefGlob(pattern, ref)).not.toThrow();
        }),
        { numRuns: 100 },
      );
    });
  });
});

describe('Given an all-`*` pattern', () => {
  describe('When matching any ref', () => {
    it('Then it matches everything', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(asciiArb, (ref) => {
          expect(matchRefGlob('*', ref)).toBe(true);
        }),
        { numRuns: 100 },
      );
    });
  });
});

describe('Given a metacharacter-free literal pattern', () => {
  describe('When matching a ref', () => {
    it('Then it matches iff the ref is identical', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(literalArb, literalArb, (pattern, ref) => {
          expect(matchRefGlob(pattern, ref)).toBe(pattern === ref);
        }),
        { numRuns: 50 },
      );
    });
  });
});

describe('Given every character of a string individually escaped', () => {
  describe('When matching the original string', () => {
    it('Then the fully-escaped pattern matches exactly that string', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(asciiArb, (text) => {
          const escaped = [...text].map((ch) => `\\${ch}`).join('');
          expect(matchRefGlob(escaped, text)).toBe(true);
        }),
        { numRuns: 100 },
      );
    });
  });
});

describe('Given a single-member bracket set `[c]` over a non-special character', () => {
  describe('When matching', () => {
    it('Then it behaves exactly like the literal `c`', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(plainCharArb, plainCharArb, (c, text) => {
          expect(matchRefGlob(`[${c}]`, text)).toBe(matchRefGlob(c, text));
        }),
        { numRuns: 100 },
      );
    });
  });
});

describe('Given two token-grammar patterns, each already matching its own text', () => {
  describe('When concatenating both patterns and both texts', () => {
    it('Then the combined pattern matches the combined text', () => {
      // Arrange — each half is a fully-escaped literal (no trailing `\`, no
      // unterminated `[`), so `p` matches `r` (itself) and `q` matches `s`
      // (itself) by construction; tokenising `p + q` yields exactly
      // `tokens(p) ++ tokens(q)` because a well-formed half never leaves an
      // open escape or bracket for the next half to close.
      const escapeAll = (raw: string): string => [...raw].map((ch) => `\\${ch}`).join('');

      // Act + Assert
      fc.assert(
        fc.property(asciiArb, asciiArb, (p, q) => {
          expect(matchRefGlob(escapeAll(p) + escapeAll(q), p + q)).toBe(true);
        }),
        { numRuns: 50 },
      );
    });
  });
});
