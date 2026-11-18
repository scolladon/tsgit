import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { FilePath } from '../../../../src/domain/objects/object-id.js';
import { buildConeSpec, coneMatcher } from '../../../../src/domain/sparse/cone.js';
import { arbCaseMask, flipAsciiCase } from '../path/arbitraries.js';

const NUM_RUNS = 100;
const arbSegment = fc.stringMatching(/^[aAbB]{1,2}$/);
const arbDir = fc.array(arbSegment, { minLength: 1, maxLength: 3 }).map((s) => s.join('/'));
const arbSpec = fc.array(arbDir, { minLength: 1, maxLength: 3 }).map((dirs) => buildConeSpec(dirs));
const arbPath = fc
  .array(arbSegment, { minLength: 1, maxLength: 4 })
  .map((s) => FilePath.from(s.join('/')));
const arbMask = arbCaseMask();

describe('coneMatcher properties', () => {
  describe('Given ignoreCase', () => {
    describe('When the path has its ASCII case flipped', () => {
      it('Then the verdict is unchanged', () => {
        fc.assert(
          fc.property(arbSpec, arbPath, arbMask, (spec, p, mask) => {
            // Arrange
            const sut = coneMatcher(spec, { ignoreCase: true });

            // Act
            const result = sut(FilePath.from(flipAsciiCase(p, mask)));

            // Assert
            expect(result).toBe(sut(p));
          }),
          { numRuns: NUM_RUNS },
        );
      });
    });

    describe('When the exact matcher includes a path', () => {
      it('Then the folded matcher includes it too', () => {
        fc.assert(
          fc.property(arbSpec, arbPath, (spec, p) => {
            // Arrange
            const sut = coneMatcher(spec, { ignoreCase: true });

            // Act
            const result = sut(p);

            // Assert
            expect(result || !coneMatcher(spec)(p)).toBe(true);
          }),
          { numRuns: NUM_RUNS },
        );
      });
    });
  });

  describe('Given omitted options', () => {
    describe('When compared with ignoreCase false', () => {
      it('Then both matchers agree', () => {
        fc.assert(
          fc.property(arbSpec, arbPath, (spec, p) => {
            // Arrange
            const sut = coneMatcher(spec);

            // Act
            const result = sut(p);

            // Assert
            expect(result).toBe(coneMatcher(spec, { ignoreCase: false })(p));
          }),
          { numRuns: NUM_RUNS },
        );
      });
    });
  });
});
