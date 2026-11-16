/**
 * Lens 3 — a total function over a declared safe subset: resolving a pattern built
 * from safe ASCII components never throws, whatever its length or count of `*` and `?`.
 * Lens 1 (round-trip), lens 2 (oracle) and lens 4 (algebraic law) do not fit: resolving
 * is not invertible, the matcher is its own oracle, and no operation composes.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { resolvePathspec } from '../../../../../src/application/commands/internal/resolve-pathspec.js';
import type { FilePath } from '../../../../../src/domain/objects/object-id.js';
import { isDotGitAlias } from '../../../../../src/domain/path/verify-path.js';
import { matchesPathspec } from '../../../../../src/domain/pathspec/match-pathspec.js';

const NUM_RUNS = 100;
const FIRST_PRINTABLE = 0x20;
const LAST_BMP_SCALAR = 0xd7ff;
const DELETE = 0x7f;
const WILDCARDS = ['*', '?'];
const SEPARATORS = new Set(['/', '\\']);
const GLOB_SPECIAL = new Set(['*', '?', '[']);
const MAX_COMPONENT_LENGTH = 600;
const MAX_COMPONENTS = 40;
const DRIVE_PREFIX = /^[A-Za-z]?:/;

const codeUnit = fc
  .integer({ min: FIRST_PRINTABLE, max: LAST_BMP_SCALAR })
  .filter((code) => code !== DELETE)
  .map((code) => String.fromCharCode(code))
  .filter((c) => !SEPARATORS.has(c));

const LITERAL_UNIT = codeUnit.filter((c) => !GLOB_SPECIAL.has(c));
const WILDCARD_UNIT = fc.oneof(LITERAL_UNIT, fc.constantFrom(...WILDCARDS));

const isUsableComponent = (c: string): boolean => c !== '.' && c !== '..' && !isDotGitAlias(c);

const componentOf = (unit: fc.Arbitrary<string>) =>
  fc
    .array(unit, {
      minLength: 1,
      maxLength: MAX_COMPONENT_LENGTH,
      size: 'max',
    })
    .map((chars) => chars.join(''))
    .filter(isUsableComponent);

const patternOf = (unit: fc.Arbitrary<string>) =>
  fc
    .array(componentOf(unit), { minLength: 1, maxLength: MAX_COMPONENTS, size: 'max' })
    .map((components) => components.join('/'))
    .filter((p) => !DRIVE_PREFIX.test(p) && !p.startsWith('!'));

describe('resolvePathspec properties', () => {
  describe('Given a literal of any length', () => {
    describe('When resolved', () => {
      it('Then a literal of any length resolves to itself and matches itself', () => {
        // Arrange
        const sut = resolvePathspec;

        // Act + Assert
        fc.assert(
          fc.property(patternOf(LITERAL_UNIT), (pattern) => {
            const { matcher } = sut([pattern]);
            expect(matcher[0]?.body).toBe(pattern);
            expect(matchesPathspec(matcher, pattern as FilePath)).toBe(true);
          }),
          { numRuns: NUM_RUNS },
        );
      });
    });
  });

  describe('Given a pattern of any count of * and ?', () => {
    describe('When resolved', () => {
      it('Then a pattern of any count of * and ? never throws', () => {
        // Arrange
        const sut = resolvePathspec;
        const pattern = patternOf(WILDCARD_UNIT).filter((p) =>
          WILDCARDS.some((w) => p.includes(w)),
        );

        // Act + Assert
        fc.assert(
          fc.property(pattern, (p) => {
            const { matcher } = sut([p]);
            expect(matcher).toHaveLength(1);
            expect(matcher[0]?.isLiteral).toBe(false);
          }),
          { numRuns: NUM_RUNS },
        );
      });
    });
  });
});
