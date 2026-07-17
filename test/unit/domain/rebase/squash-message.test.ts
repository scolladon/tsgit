import { describe, expect, it } from 'vitest';
import { buildCombinedMessage } from '../../../../src/domain/rebase/index.js';

const keep = (message: string) => ({ message });
const skip = (message: string) => ({ message, skip: true });

describe('rebase squash combined-message builder', () => {
  describe('Given buildCombinedMessage', () => {
    describe('When given two kept (squash) messages', () => {
      it('Then emits git 2.54 combination template (`1st` then `#2`)', () => {
        // Arrange + Act
        const sut = buildCombinedMessage([keep('t2 subject'), keep('t3 subject')]);

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

    describe('When given three kept messages', () => {
      it('Then numbers the third block `#3`', () => {
        // Arrange + Act
        const sut = buildCombinedMessage([
          keep('t1 subject'),
          keep('t2 subject'),
          keep('t3 subject'),
        ]);

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

    describe('When a later member is a fixup (skipped)', () => {
      it('Then comments out its body under a `will be skipped` header', () => {
        // Arrange + Act
        const sut = buildCombinedMessage([
          keep('t1 subject'),
          keep('t2 subject'),
          skip('t3 subject'),
        ]);

        // Assert — byte-faithful to git (verified `od -c`)
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
            '# The commit message #3 will be skipped:\n' +
            '\n' +
            '# t3 subject\n',
        );
      });
    });

    describe('When given a single message', () => {
      it('Then uses the singular header and only the first block', () => {
        // Arrange + Act
        const sut = buildCombinedMessage([keep('solo')]);

        // Assert
        expect(sut).toBe(
          '# This is a combination of 1 commit.\n# This is the 1st commit message:\n\nsolo\n',
        );
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

    describe('When a message carries multiple trailing newlines', () => {
      it('Then strips every trailing newline down to the single separator', () => {
        // Arrange + Act
        const sut = buildCombinedMessage([keep('a\n\n'), keep('b\n\n\n')]);

        // Assert
        expect(sut).toBe(
          '# This is a combination of 2 commits.\n' +
            '# This is the 1st commit message:\n' +
            '\n' +
            'a\n' +
            '\n' +
            '# This is the commit message #2:\n' +
            '\n' +
            'b\n',
        );
      });
    });

    describe('When a skipped message is multi-line', () => {
      it('Then comments every body line', () => {
        // Arrange + Act
        const sut = buildCombinedMessage([keep('base'), skip('subject\n\nbody')]);

        // Assert
        expect(sut).toBe(
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
        );
      });
    });

    describe('When a kept message is multi-line', () => {
      it('Then preserves the internal body lines', () => {
        // Arrange + Act
        const sut = buildCombinedMessage([keep('subject\n\nbody line'), keep('second')]);

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
