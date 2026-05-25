import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { FILE_MODE, normalizeFileMode } from '../../../../src/domain/objects/file-mode.js';
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

  describe('Given an arbitrary raw octal mode string that is NOT a canonical form', () => {
    describe('When normalizeFileMode is called', () => {
      it('Then it throws unless the string is the directory zero-pad alias "040000" (which normalises to "40000")', () => {
        // Arrange + Act + Assert
        // Restrict the input to octal digits up to 8 chars to keep the
        // input space meaningful — the validator rejects anything not in
        // the canonical set, except for the documented "040000" alias.
        const arbRawOctal = fc
          .array(fc.constantFrom(...'01234567'.split('')), { minLength: 1, maxLength: 8 })
          .map((chars) => chars.join(''))
          .filter(
            (s) =>
              s !== FILE_MODE.REGULAR &&
              s !== FILE_MODE.EXECUTABLE &&
              s !== FILE_MODE.SYMLINK &&
              s !== FILE_MODE.DIRECTORY &&
              s !== FILE_MODE.GITLINK,
          );
        fc.assert(
          fc.property(arbRawOctal, (raw) => {
            if (raw === '040000') {
              const sut = normalizeFileMode(raw);
              expect(sut).toBe(FILE_MODE.DIRECTORY);
              return;
            }
            expect(() => normalizeFileMode(raw)).toThrow(
              expect.objectContaining({
                data: expect.objectContaining({ code: 'INVALID_FILE_MODE' }),
              }),
            );
          }),
          { numRuns: 100 },
        );
      });
    });
  });
});
