import { describe, expect, it } from 'vitest';
import { buildCombinedMessage } from '../../../../src/domain/rebase/index.js';

describe('rebase squash combined-message builder', () => {
  describe('Given buildCombinedMessage', () => {
    describe('When given two messages', () => {
      it('Then emits git 2.54 combination template (`1st` then `#2`)', () => {
        // Arrange + Act
        const sut = buildCombinedMessage(['t2 subject', 't3 subject']);

        // Assert — byte-faithful to git (verified `od -c`)
        expect(sut).toBe(
          '# This is a combination of 2 commits.\n' +
            '# This is the 1st commit message:\n' +
            '\n' +
            't2 subject\n' +
            '\n' +
            '# This is the commit message #2:\n' +
            '\n' +
            't3 subject\n',
        );
      });
    });

    describe('When given three messages', () => {
      it('Then numbers the third block `#3`', () => {
        // Arrange + Act
        const sut = buildCombinedMessage(['t1 subject', 't2 subject', 't3 subject']);

        // Assert
        expect(sut).toBe(
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
        );
      });
    });

    describe('When given a single message', () => {
      it('Then uses the singular header and only the first block', () => {
        // Arrange + Act
        const sut = buildCombinedMessage(['solo']);

        // Assert
        expect(sut).toBe(
          '# This is a combination of 1 commit.\n# This is the 1st commit message:\n\nsolo\n',
        );
      });
    });

    describe('When a message carries a trailing newline', () => {
      it('Then normalises it to exactly one separating newline', () => {
        // Arrange + Act
        const withNewline = buildCombinedMessage(['a\n', 'b\n']);
        const without = buildCombinedMessage(['a', 'b']);

        // Assert
        expect(withNewline).toBe(without);
      });
    });

    describe('When a message is multi-line', () => {
      it('Then preserves the internal body lines', () => {
        // Arrange + Act
        const sut = buildCombinedMessage(['subject\n\nbody line', 'second']);

        // Assert
        expect(sut).toBe(
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
        );
      });
    });
  });
});
