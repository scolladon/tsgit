import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { buildCombinedMessage, firstCommitMessage } from '../../../../src/domain/rebase/index.js';
import { arbSubject } from './arbitraries.js';

describe('rebase squash combined-message properties', () => {
  describe('Given an arbitrary list of >=2 kept messages, When built into the template', () => {
    it('Then the header counts them and one numbered sub-header exists per later message', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(fc.array(arbSubject(), { minLength: 2, maxLength: 8 }), (messages) => {
          const result = buildCombinedMessage(messages.map((message) => ({ message })));
          const n = messages.length;
          expect(result.startsWith(`# This is a combination of ${n} commits.\n`)).toBe(true);
          const numbered = result
            .split('\n')
            .filter((line) => /^# This is the commit message #\d+:$/.test(line));
          expect(numbered).toHaveLength(n - 1);
          expect(result).toContain('# This is the 1st commit message:\n');
        }),
        { numRuns: 200 },
      );
    });
  });

  describe('Given an arbitrary list of messages, When the template is read back', () => {
    it('Then the first commit message is the base, whatever follows it', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(
          arbSubject(),
          fc.array(fc.tuple(arbSubject(), fc.boolean()), { maxLength: 6 }),
          (base, rest) => {
            const template = buildCombinedMessage([
              { message: base },
              ...rest.map(([message, skip]) => ({ message, skip })),
            ]);
            expect(firstCommitMessage(template)).toBe(`${base.replace(/\n+$/, '')}\n`);
          },
        ),
        { numRuns: 200 },
      );
    });
  });
});
