import { execFileSync } from 'node:child_process';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { sqQuote } from '../../../../../src/application/commands/internal/ssh-argv.js';
import { pathArb } from './arbitraries.js';

const hasSh = (): boolean => {
  try {
    execFileSync('sh', ['-c', 'true']);
    return true;
  } catch {
    return false;
  }
};

const SH_AVAILABLE = hasSh();

describe.skipIf(!SH_AVAILABLE)('sqQuote properties', () => {
  describe('Given an arbitrary printable-ASCII path (incl. quotes and spaces)', () => {
    describe('When sq-quoted and unwrapped by a real POSIX shell', () => {
      it('Then the shell recovers the original string verbatim', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(pathArb(), (path) => {
            const token = sqQuote(path);
            const result = execFileSync('sh', ['-c', `printf %s ${token}`]).toString();
            expect(result).toBe(path);
          }),
          { numRuns: 200 },
        );
      });
    });
  });
});
