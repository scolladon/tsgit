import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { normalizeFileMode } from '../../../../src/domain/objects/file-mode.js';
import { arbFileModeEnum } from './arbitraries.js';

describe('file-mode properties', () => {
  describe('Given an arbitrary canonical FileMode value', () => {
    describe('When normalizeFileMode is called on it', () => {
      it('Then it returns the same canonical value (identity)', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(arbFileModeEnum(), (mode) => {
            const sut = normalizeFileMode(mode);
            expect(sut).toBe(mode);
          }),
          { numRuns: 50 },
        );
      });
    });
  });
});
