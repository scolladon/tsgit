import { describe, expect, it } from 'vitest';
import { buildCombinedMessage } from '../../../../src/domain/rebase/index.js';

const keep = (message: string) => ({ message });
const skip = (message: string) => ({ message, skip: true });

describe('rebase squash combined-message builder', () => {
  describe('Given buildCombinedMessage', () => {
    describe('When given a mix of kept and/or skipped messages', () => {
      it.each([
        {
          label: 'emits git 2.54 combination template (`1st` then `#2`) for two kept messages',
          messages: [keep('t2 subject'), keep('t3 subject')],
          // byte-faithful to git (verified `od -c`)
          expected:
            '# This is a combination of 2 commits.\n' +
            '# This is the 1st commit message:\n' +
            '\n' +
            't2 subject\n' +
            '\n' +
            '# This is the commit message #2:\n' +
            '\n' +
            't3 subject\n',
        },
        {
          label: 'numbers the third block `#3` for three kept messages',
          messages: [keep('t1 subject'), keep('t2 subject'), keep('t3 subject')],
          expected:
            '# This is a combination of 3 commits.\n' +
            '# This is the 1st commit message:\n' +
            '\n' +
            't1 subject\n' +
            '\n' +
            '# This is the commit message #2:\n' +
            '\n' +
            't2 subject\n' +
            '\n' +
            '# This is the commit message #3:\n' +
            '\n' +
            't3 subject\n',
        },
        {
          label: 'comments out a fixup body under a `will be skipped` header',
          messages: [keep('t1 subject'), keep('t2 subject'), skip('t3 subject')],
          // byte-faithful to git (verified `od -c`)
          expected:
            '# This is a combination of 3 commits.\n' +
            '# This is the 1st commit message:\n' +
            '\n' +
            't1 subject\n' +
            '\n' +
            '# This is the commit message #2:\n' +
            '\n' +
            't2 subject\n' +
            '\n' +
            '# The commit message #3 will be skipped:\n' +
            '\n' +
            '# t3 subject\n',
        },
        {
          label: 'uses the singular header and only the first block for a single message',
          messages: [keep('solo')],
          expected:
            '# This is a combination of 1 commit.\n# This is the 1st commit message:\n\nsolo\n',
        },
        {
          label: 'strips every trailing newline down to the single separator',
          messages: [keep('a\n\n'), keep('b\n\n\n')],
          expected:
            '# This is a combination of 2 commits.\n' +
            '# This is the 1st commit message:\n' +
            '\n' +
            'a\n' +
            '\n' +
            '# This is the commit message #2:\n' +
            '\n' +
            'b\n',
        },
        {
          label: 'comments every body line of a skipped multi-line message',
          messages: [keep('base'), skip('subject\n\nbody')],
          expected:
            '# This is a combination of 2 commits.\n' +
            '# This is the 1st commit message:\n' +
            '\n' +
            'base\n' +
            '\n' +
            '# The commit message #2 will be skipped:\n' +
            '\n' +
            '# subject\n' +
            '#\n' +
            '# body\n',
        },
        {
          label: 'preserves the internal body lines of a kept multi-line message',
          messages: [keep('subject\n\nbody line'), keep('second')],
          expected:
            '# This is a combination of 2 commits.\n' +
            '# This is the 1st commit message:\n' +
            '\n' +
            'subject\n' +
            '\n' +
            'body line\n' +
            '\n' +
            '# This is the commit message #2:\n' +
            '\n' +
            'second\n',
        },
      ])('Then $label', ({ messages, expected }) => {
        // Arrange + Act
        const sut = buildCombinedMessage(messages);

        // Assert
        expect(sut).toBe(expected);
      });
    });

    describe('When a message carries a trailing newline', () => {
      it('Then normalises it to exactly one separating newline', () => {
        // Arrange + Act
        const withNewline = buildCombinedMessage([keep('a\n'), keep('b\n')]);
        const without = buildCombinedMessage([keep('a'), keep('b')]);

        // Assert
        expect(withNewline).toBe(without);
      });
    });
  });
});
