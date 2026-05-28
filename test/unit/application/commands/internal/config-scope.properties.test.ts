import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { mergeConfigsByScope } from '../../../../../src/application/commands/internal/config-scope.js';
import type { IniSection } from '../../../../../src/application/primitives/config-read.js';
import type { ConfigScope } from '../../../../../src/domain/commands/config-key.js';

const arbScope = (): fc.Arbitrary<ConfigScope> =>
  fc.constantFrom('system', 'global', 'local', 'worktree');

const arbSection = (): fc.Arbitrary<IniSection> =>
  fc.record({
    section: fc.constantFrom('user', 'core', 'remote', 'extensions'),
    subsection: fc.option(fc.string({ minLength: 1, maxLength: 8 })).map((v) => v ?? undefined),
    entries: fc.array(
      fc.record({
        key: fc.constantFrom('name', 'email', 'url', 'editor'),
        value: fc.string({ maxLength: 16 }),
      }),
      { maxLength: 3 },
    ),
  });

const arbScopedSections = () =>
  fc.array(
    fc.record({
      scope: arbScope(),
      sections: fc.array(arbSection(), { maxLength: 4 }),
    }),
    { maxLength: 6 },
  );

const SCOPE_RANK: Record<ConfigScope, number> = {
  system: 0,
  global: 1,
  local: 2,
  worktree: 3,
};

describe('mergeConfigsByScope properties', () => {
  describe('Given an arbitrary scope-tagged input', () => {
    describe('When mergeConfigsByScope runs', () => {
      it('Then the output length equals the sum of input section counts (dedup-aware)', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(arbScopedSections(), (input) => {
            // The current implementation uses last-write-wins per scope (Map),
            // so duplicate-scope groups collapse to the last entry's sections.
            const lastPerScope = new Map<ConfigScope, ReadonlyArray<IniSection>>();
            for (const { scope, sections } of input) lastPerScope.set(scope, sections);
            const expectedCount = [...lastPerScope.values()].reduce((n, s) => n + s.length, 0);

            const out = mergeConfigsByScope(input);

            expect(out.length).toBe(expectedCount);
          }),
          { numRuns: 100 },
        );
      });
    });
  });

  describe('Given the same input twice, When mergeConfigsByScope runs both times', () => {
    it('Then both outputs are deeply equal (idempotence)', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(arbScopedSections(), (input) => {
          const a = mergeConfigsByScope(input);
          const b = mergeConfigsByScope(input);
          expect(a).toEqual(b);
        }),
        { numRuns: 50 },
      );
    });
  });

  describe('Given any output entry, When consecutive entries are compared by scope rank', () => {
    it('Then consecutive entries are non-decreasing in scope-precedence rank', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(arbScopedSections(), (input) => {
          const out = mergeConfigsByScope(input);
          for (let i = 1; i < out.length; i += 1) {
            const prev = SCOPE_RANK[(out[i - 1] as { scope: ConfigScope }).scope];
            const curr = SCOPE_RANK[(out[i] as { scope: ConfigScope }).scope];
            expect(curr).toBeGreaterThanOrEqual(prev);
          }
        }),
        { numRuns: 100 },
      );
    });
  });
});
