import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { buildCombinedMessage } from '../../../../src/domain/rebase/index.js';
import { arbSubject } from './arbitraries.js';

describe('rebase squash combined-message properties', () => {
  describe('Given an arbitrary list of >=2 kept messages, When built into the template', () => {
    it('Then the header counts them and one numbered sub-header exists per later message', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(fc.array(arbSubject(), { minLength: 2, maxLength: 8 }), (messages) => {
          const sut = buildCombinedMessage(messages.map((message) => ({ message })));
          const n = messages.length;
          expect(sut.startsWith(`# This is a combination of ${n} commits.\n`)).toBe(true);
          const numbered = sut
            .split('\n')
            .filter((line) => /^# This is the commit message #\d+:$/.test(line));
          expect(numbered).toHaveLength(n - 1);
          expect(sut).toContain('# This is the 1st commit message:\n');
        }),
        { numRuns: 200 },
      );
    });
  });
});
