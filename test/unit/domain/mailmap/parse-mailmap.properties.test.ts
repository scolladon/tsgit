import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseMailmap } from '../../../../src/domain/mailmap/parse-mailmap.js';

const TOTALITY_RUNS = 200;
const COUNTING_RUNS = 100;

const nameArb = fc.stringMatching(/^[A-Za-z][A-Za-z #.]{0,10}$/).map((name) => name.trim());
const emailArb = fc.stringMatching(/^[a-z]{1,8}@[a-z]{1,6}$/);

const wellFormedLineArb = fc.oneof(
  fc.tuple(nameArb, emailArb).map(([name, mail]) => `${name} <${mail}>`),
  fc.tuple(emailArb, emailArb).map(([next, old]) => `<${next}> <${old}>`),
  fc.tuple(nameArb, emailArb, emailArb).map(([name, next, old]) => `${name} <${next}> <${old}>`),
  fc
    .tuple(nameArb, emailArb, nameArb, emailArb)
    .map(([name, next, oldName, old]) => `${name} <${next}> ${oldName} <${old}>`),
);

const ignoredLineArb = fc.oneof(
  fc.constant(''),
  fc.constant('   '),
  fc.tuple(nameArb, emailArb).map(([name, mail]) => `# ${name} <${mail}>`),
  nameArb.map((text) => `${text} without brackets`),
  nameArb.map((text) => `${text} <unterminated`),
);

describe('parseMailmap properties', () => {
  describe('Given an arbitrary string, When parsing', () => {
    it('Then parsing is total and every rule has a bracket-free email', () => {
      fc.assert(
        fc.property(fc.string({ unit: 'binary' }), (text) => {
          // Arrange
          const sut = parseMailmap;

          // Act
          const result = sut(text);

          // Assert
          expect(result.every((rule) => !rule.oldEmail.includes('>'))).toBe(true);
        }),
        { numRuns: TOTALITY_RUNS },
      );
    });
  });

  describe('Given k well-formed lines interleaved with ignorable lines, When parsing', () => {
    it('Then exactly k rules come out', () => {
      fc.assert(
        fc.property(
          fc.array(fc.tuple(wellFormedLineArb, ignoredLineArb), { maxLength: 8 }),
          (pairs) => {
            // Arrange
            const sut = parseMailmap;
            const text = pairs.flatMap(([good, noise]) => [noise, good]).join('\n');

            // Act
            const result = sut(text);

            // Assert
            expect(result).toHaveLength(pairs.length);
          },
        ),
        { numRuns: COUNTING_RUNS },
      );
    });
  });
});
