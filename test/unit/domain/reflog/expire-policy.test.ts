import { describe, expect, it } from 'vitest';
import { resolveExpiryCutoff } from '../../../../src/application/primitives/expiry-cutoff.js';
import type { TsgitError } from '../../../../src/domain/error.js';
import type { RefName } from '../../../../src/domain/objects/index.js';
import {
  expiryPolicyFor,
  parseReflogExpiryEntries,
  type ReflogExpiryConfigEntry,
} from '../../../../src/domain/reflog/expire-policy.js';

const SOURCE = '/repo/.git/config';
const NEVER = Number.NEGATIVE_INFINITY;
const DEFAULTS = { expireCut: 30, unreachableCut: 90 };

/** A table-driven `parse`: numeric strings parse to themselves, `never`
 *  parses to `NEVER`, anything else is unparseable — a lightweight double
 *  standing in for `resolveExpiryCutoff` bound to a fixed `now`. */
const stubParse = (raw: string): number | undefined => {
  if (raw === 'never') return NEVER;
  const n = Number(raw);
  return Number.isNaN(n) ? undefined : n;
};

const entry = (overrides: Partial<ReflogExpiryConfigEntry>): ReflogExpiryConfigEntry => ({
  pattern: undefined,
  slot: 'total',
  value: '1',
  key: 'gc.reflogexpire',
  source: SOURCE,
  line: 1,
  ...overrides,
});

const REF = 'refs/heads/main' as RefName;

describe('parseReflogExpiryEntries', () => {
  describe('Given a valueless entry', () => {
    describe('When parsing', () => {
      it('Then it throws CONFIG_MISSING_VALUE naming the entry', () => {
        // Arrange
        const entries = [entry({ value: null, key: 'gc.reflogexpire', line: 3 })];

        // Act
        let caught: unknown;
        try {
          parseReflogExpiryEntries(entries, stubParse);
        } catch (err) {
          caught = err;
        }

        // Assert
        expect((caught as TsgitError).data).toEqual({
          code: 'CONFIG_MISSING_VALUE',
          key: 'gc.reflogexpire',
          source: SOURCE,
          line: 3,
        });
      });
    });
  });

  describe('Given an unparseable entry', () => {
    describe('When parsing', () => {
      it('Then it throws CONFIG_BAD_DATE_VALUE, located', () => {
        // Arrange
        const entries = [entry({ value: 'bogus', key: 'gc.reflogexpire', line: 9 })];

        // Act
        let caught: unknown;
        try {
          parseReflogExpiryEntries(entries, stubParse);
        } catch (err) {
          caught = err;
        }

        // Assert — every field individually (mutation-resistant).
        const data = (caught as TsgitError).data;
        expect(data.code).toBe('CONFIG_BAD_DATE_VALUE');
        if (data.code === 'CONFIG_BAD_DATE_VALUE') {
          expect(data.value).toBe('bogus');
          expect(data.key).toBe('gc.reflogexpire');
          expect(data.source).toBe(SOURCE);
          expect(data.line).toBe(9);
        }
      });
    });
  });

  describe('Given an unparseable entry under a non-matching pattern', () => {
    describe('When parsing', () => {
      it('Then it still throws — patterns validate whether or not they match', () => {
        // Arrange
        const entries = [
          entry({
            pattern: 'refs/tags/*',
            value: 'bogus',
            key: 'gc.refs/tags/*.reflogexpire',
            line: 5,
          }),
        ];

        // Act + Assert
        expect(() => parseReflogExpiryEntries(entries, stubParse)).toThrow();
      });
    });
  });

  describe('Given a bogus entry followed by a later valid one', () => {
    describe('When parsing', () => {
      it('Then the first invalid line dies — not last-wins', () => {
        // Arrange
        const entries = [entry({ value: 'bogus', line: 9 }), entry({ value: '30', line: 10 })];

        // Act
        let caught: unknown;
        try {
          parseReflogExpiryEntries(entries, stubParse);
        } catch (err) {
          caught = err;
        }

        // Assert
        const data = (caught as TsgitError).data;
        expect(data.code).toBe('CONFIG_BAD_DATE_VALUE');
        if (data.code === 'CONFIG_BAD_DATE_VALUE') expect(data.line).toBe(9);
      });
    });
  });

  describe('Given a valid entry followed by a later bogus one', () => {
    describe('When parsing', () => {
      it('Then it still throws at the bogus line', () => {
        // Arrange
        const entries = [entry({ value: 'never', line: 9 }), entry({ value: 'bogus', line: 10 })];

        // Act
        let caught: unknown;
        try {
          parseReflogExpiryEntries(entries, stubParse);
        } catch (err) {
          caught = err;
        }

        // Assert
        const data = (caught as TsgitError).data;
        expect(data.code).toBe('CONFIG_BAD_DATE_VALUE');
        if (data.code === 'CONFIG_BAD_DATE_VALUE') expect(data.line).toBe(10);
      });
    });
  });

  describe('Given two valid entries for the same subsectionless key', () => {
    describe('When parsing', () => {
      it('Then the later value wins', () => {
        // Arrange
        const entries = [entry({ value: '10', line: 1 }), entry({ value: '20', line: 2 })];

        // Act
        const config = parseReflogExpiryEntries(entries, stubParse);

        // Assert
        expect(config.globalTotal).toBe(20);
      });
    });
  });
});

describe('expiryPolicyFor', () => {
  describe('Given no config entries at all', () => {
    describe('When resolving cutoffs for an ordinary ref', () => {
      it('Then the defaults apply', () => {
        // Arrange
        const config = parseReflogExpiryEntries([], stubParse);
        const sut = expiryPolicyFor(config, {}, DEFAULTS);

        // Act
        const result = sut.cutoffsFor(REF);

        // Assert
        expect(result).toEqual({ expireCut: 30, unreachableCut: 90 });
      });
    });

    describe('When resolving cutoffs for refs/stash', () => {
      it('Then both cutoffs are never', () => {
        // Arrange
        const config = parseReflogExpiryEntries([], stubParse);
        const sut = expiryPolicyFor(config, {}, DEFAULTS);

        // Act
        const result = sut.cutoffsFor('refs/stash' as RefName);

        // Assert
        expect(result).toEqual({ expireCut: NEVER, unreachableCut: NEVER });
      });
    });
  });

  describe('Given explicit cutoffs and no config', () => {
    describe('When resolving', () => {
      it('Then the explicit values win over defaults', () => {
        // Arrange
        const config = parseReflogExpiryEntries([], stubParse);
        const sut = expiryPolicyFor(config, { total: 5, unreachable: 6 }, DEFAULTS);

        // Act
        const result = sut.cutoffsFor(REF);

        // Assert
        expect(result).toEqual({ expireCut: 5, unreachableCut: 6 });
      });
    });
  });

  describe('Given a matching pattern with only the total slot set', () => {
    describe('When resolving', () => {
      it("Then the unreachable slot is never — the pattern's own unset default", () => {
        // Arrange
        const config = parseReflogExpiryEntries(
          [entry({ pattern: 'refs/heads/*', slot: 'total', value: '120' })],
          stubParse,
        );
        const sut = expiryPolicyFor(config, {}, DEFAULTS);

        // Act
        const result = sut.cutoffsFor(REF);

        // Assert
        expect(result).toEqual({ expireCut: 120, unreachableCut: NEVER });
      });
    });
  });

  describe('Given a matching pattern with only the unreachable slot set', () => {
    describe('When resolving', () => {
      it('Then the total slot is never', () => {
        // Arrange
        const config = parseReflogExpiryEntries(
          [entry({ pattern: 'refs/heads/*', slot: 'unreachable', value: '45' })],
          stubParse,
        );
        const sut = expiryPolicyFor(config, {}, DEFAULTS);

        // Act
        const result = sut.cutoffsFor(REF);

        // Assert
        expect(result).toEqual({ expireCut: NEVER, unreachableCut: 45 });
      });
    });
  });

  describe('Given the same pattern text set across two config sections', () => {
    describe('When resolving', () => {
      it('Then both slots merge into the one entry', () => {
        // Arrange
        const config = parseReflogExpiryEntries(
          [
            entry({ pattern: 'refs/heads/*', slot: 'total', value: '120' }),
            entry({ pattern: 'refs/heads/*', slot: 'unreachable', value: '45' }),
          ],
          stubParse,
        );
        const sut = expiryPolicyFor(config, {}, DEFAULTS);

        // Act
        const result = sut.cutoffsFor(REF);

        // Assert
        expect(result).toEqual({ expireCut: 120, unreachableCut: 45 });
      });
    });
  });

  describe('Given two non-matching patterns then a matching one, in config order', () => {
    describe('When resolving', () => {
      it('Then the first matching pattern wins, later ones are never consulted', () => {
        // Arrange
        const config = parseReflogExpiryEntries(
          [
            entry({ pattern: 'refs/heads/m*', slot: 'total', value: 'never' }),
            entry({ pattern: 'refs/heads/main', slot: 'total', value: '5' }),
          ],
          stubParse,
        );
        const sut = expiryPolicyFor(config, {}, DEFAULTS);

        // Act
        const result = sut.cutoffsFor(REF);

        // Assert — `refs/heads/m*` (first, and it matches) wins over the
        // later, more specific `refs/heads/main`.
        expect(result.expireCut).toBe(NEVER);
      });
    });

    describe('When the config order is reversed', () => {
      it('Then the now-first pattern wins instead', () => {
        // Arrange
        const config = parseReflogExpiryEntries(
          [
            entry({ pattern: 'refs/heads/main', slot: 'total', value: '5' }),
            entry({ pattern: 'refs/heads/m*', slot: 'total', value: 'never' }),
          ],
          stubParse,
        );
        const sut = expiryPolicyFor(config, {}, DEFAULTS);

        // Act
        const result = sut.cutoffsFor(REF);

        // Assert
        expect(result.expireCut).toBe(5);
      });
    });
  });

  describe('Given a non-matching pattern and a global value', () => {
    describe('When resolving', () => {
      it('Then the global value is used — the pattern never hides it', () => {
        // Arrange
        const config = parseReflogExpiryEntries(
          [
            entry({ pattern: 'refs/tags/*', slot: 'total', value: 'never' }),
            entry({ slot: 'total', value: '15' }),
          ],
          stubParse,
        );
        const sut = expiryPolicyFor(config, {}, DEFAULTS);

        // Act
        const result = sut.cutoffsFor(REF);

        // Assert
        expect(result.expireCut).toBe(15);
      });
    });
  });

  describe('Given a matching pattern and a global value for the same slot', () => {
    describe('When resolving', () => {
      it('Then the matching pattern hides the global entirely', () => {
        // Arrange
        const config = parseReflogExpiryEntries(
          [
            entry({ pattern: 'refs/heads/*', slot: 'total', value: 'never' }),
            entry({ slot: 'total', value: '15' }),
          ],
          stubParse,
        );
        const sut = expiryPolicyFor(config, {}, DEFAULTS);

        // Act
        const result = sut.cutoffsFor(REF);

        // Assert
        expect(result.expireCut).toBe(NEVER);
      });
    });
  });

  describe('Given refs/stash and no pattern matches it', () => {
    describe('When resolving', () => {
      it('Then refs/stash never expires, ignoring any global value', () => {
        // Arrange
        const config = parseReflogExpiryEntries(
          [entry({ slot: 'total', value: '15' }), entry({ slot: 'unreachable', value: '5' })],
          stubParse,
        );
        const sut = expiryPolicyFor(config, {}, DEFAULTS);

        // Act
        const result = sut.cutoffsFor('refs/stash' as RefName);

        // Assert
        expect(result).toEqual({ expireCut: NEVER, unreachableCut: NEVER });
      });
    });
  });

  describe('Given a pattern that explicitly targets refs/stash', () => {
    describe('When resolving', () => {
      it('Then the pattern configures it like any other ref', () => {
        // Arrange
        const config = parseReflogExpiryEntries(
          [entry({ pattern: 'refs/stash', slot: 'total', value: '45' })],
          stubParse,
        );
        const sut = expiryPolicyFor(config, {}, DEFAULTS);

        // Act
        const result = sut.cutoffsFor('refs/stash' as RefName);

        // Assert
        expect(result.expireCut).toBe(45);
      });
    });
  });

  describe('Given a pattern matching the HEAD pseudo-ref', () => {
    describe('When resolving cutoffs for HEAD', () => {
      it('Then the pattern is matched against the literal name HEAD', () => {
        // Arrange
        const config = parseReflogExpiryEntries(
          [entry({ pattern: 'HEAD', slot: 'total', value: 'never' })],
          stubParse,
        );
        const sut = expiryPolicyFor(config, {}, DEFAULTS);

        // Act
        const result = sut.cutoffsFor('HEAD');

        // Assert
        expect(result.expireCut).toBe(NEVER);
      });
    });
  });

  describe('Given explicit flags and a matching pattern', () => {
    describe('When resolving', () => {
      it('Then the explicit flags win over the pattern', () => {
        // Arrange
        const config = parseReflogExpiryEntries(
          [entry({ pattern: 'refs/heads/*', slot: 'total', value: 'never' })],
          stubParse,
        );
        const sut = expiryPolicyFor(config, { total: 3 }, DEFAULTS);

        // Act
        const result = sut.cutoffsFor(REF);

        // Assert
        expect(result.expireCut).toBe(3);
      });
    });
  });

  describe('Given the real resolveExpiryCutoff grammar for never/now', () => {
    describe('When a non-matching pattern sets never, and the ref falls through to the default', () => {
      it('Then the real parser feeds the policy exactly as the stub does', () => {
        // Arrange — `refs/tags/*` never matches `REF`, so its `never` value
        // is validated (parsed successfully) but never selected; the
        // default supplied to `expiryPolicyFor` decides instead.
        const now = 1_700_000_000;
        const parse = (raw: string): number | undefined => resolveExpiryCutoff(raw, now);
        const config = parseReflogExpiryEntries(
          [entry({ pattern: 'refs/tags/*', slot: 'total', value: 'never' })],
          parse,
        );
        const sut = expiryPolicyFor(config, {}, { expireCut: 30, unreachableCut: 90 });

        // Act
        const result = sut.cutoffsFor(REF);

        // Assert
        expect(result).toEqual({ expireCut: 30, unreachableCut: 90 });
      });
    });
  });
});
