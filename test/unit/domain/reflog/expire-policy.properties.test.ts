import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { RefName } from '../../../../src/domain/objects/index.js';
import {
  expiryPolicyFor,
  parseReflogExpiryEntries,
  type ReflogExpiryConfigEntry,
} from '../../../../src/domain/reflog/expire-policy.js';
import { arbExpiryCuts, arbReflogExpiryEntry, arbSafeRefName } from './arbitraries.js';

const NEVER = Number.NEGATIVE_INFINITY;
const STASH = 'refs/stash' as RefName;

const entryFor = (pattern: string): ReflogExpiryConfigEntry => ({
  pattern,
  slot: 'total',
  value: '1',
  key: `gc.${pattern}.reflogexpire`,
  source: '/repo/.git/config',
  line: 1,
});

// Every value here parses trivially — these properties are about the
// AGGREGATOR (which entry decides a slot), not the date grammar.
const parseOne = (): number | undefined => 1;

describe('Given an empty entry list', () => {
  describe('When resolving cutoffs for any non-stash ref', () => {
    it('Then the defaults apply', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(arbSafeRefName(), arbExpiryCuts(), (ref, defaults) => {
          const config = parseReflogExpiryEntries([], parseOne);
          const sut = expiryPolicyFor(config, {}, defaults);
          expect(sut.cutoffsFor(ref as RefName)).toEqual(defaults);
        }),
        { numRuns: 100 },
      );
    });
  });

  describe('When resolving cutoffs for refs/stash', () => {
    it('Then both cutoffs are never, regardless of the defaults', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(arbExpiryCuts(), (defaults) => {
          const config = parseReflogExpiryEntries([], parseOne);
          const sut = expiryPolicyFor(config, {}, defaults);
          expect(sut.cutoffsFor(STASH)).toEqual({ expireCut: NEVER, unreachableCut: NEVER });
        }),
        { numRuns: 100 },
      );
    });
  });
});

describe('Given a policy built from an arbitrary mix of global and pattern entries', () => {
  describe('When a pattern entry that cannot match a given ref is appended', () => {
    it("Then that ref's cutoffs never change — no global or earlier pattern value is hidden", () => {
      // Arrange — the base mixes global entries, entries whose pattern is the
      // ref itself, and entries for unrelated refs; the appended pattern is
      // the ref plus a byte (`Z`) the safe alphabet never produces, so it can
      // neither match the ref nor merge into any base pattern.
      const sut = expiryPolicyFor;
      const arbCase = arbSafeRefName().chain((ref) =>
        fc.record({
          ref: fc.constant(ref),
          base: fc.array(
            arbReflogExpiryEntry(
              fc.oneof(fc.constant(undefined), fc.constant(ref), arbSafeRefName()),
            ),
            { maxLength: 6 },
          ),
          appended: arbReflogExpiryEntry(fc.constant(`${ref}Z`)),
          defaults: arbExpiryCuts(),
        }),
      );

      // Act + Assert
      fc.assert(
        fc.property(arbCase, ({ ref, base, appended, defaults }) => {
          const refName = ref as RefName;
          const before = sut(parseReflogExpiryEntries(base, Number), {}, defaults);
          const after = sut(parseReflogExpiryEntries([...base, appended], Number), {}, defaults);

          expect(after.cutoffsFor(refName)).toEqual(before.cutoffsFor(refName));
        }),
        { numRuns: 100 },
      );
    });
  });
});

describe('Given explicit cutoffs', () => {
  describe('When resolving for any ref and any entries', () => {
    it('Then the explicit values are returned unchanged', () => {
      // Arrange + Act + Assert — explicit flags are checked first, ahead of
      // every pattern, global and default, so no entry list can move them.
      fc.assert(
        fc.property(
          arbSafeRefName(),
          fc.array(fc.string({ minLength: 1, maxLength: 6 }), { maxLength: 3 }),
          arbExpiryCuts(),
          (ref, patterns, explicitCuts) => {
            const entries = patterns.map((pattern) => entryFor(pattern));
            const config = parseReflogExpiryEntries(entries, parseOne);
            const sut = expiryPolicyFor(
              config,
              { total: explicitCuts.expireCut, unreachable: explicitCuts.unreachableCut },
              { expireCut: 0, unreachableCut: 0 },
            );

            expect(sut.cutoffsFor(ref as RefName)).toEqual(explicitCuts);
          },
        ),
        { numRuns: 100 },
      );
    });
  });
});
