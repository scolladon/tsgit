/**
 * Properties of git's squash message: one `commit <id>` entry per commit in
 * the order given, and no rendered line ends in whitespace
 * but an inner blank body line, which keeps git's bare indent.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { squashMessage } from '../../../../src/domain/merge/squash-message.js';
import type { ObjectId } from '../../../../src/domain/objects/index.js';

const author = { name: 'a', email: 'a@x', timestamp: 1_700_000_000, timezoneOffset: '+0000' };
const message = fc.string({ unit: fc.constantFrom('a', ' ', '\t', '\n', '\r'), maxLength: 40 });
const commit = fc.record({
  id: fc.stringMatching(/^[0-9a-f]{40}$/).map((id) => id as ObjectId),
  mergeParents: fc.constant([] as ReadonlyArray<string>),
  author: fc.constant(author),
  message,
});

describe('squashMessage properties', () => {
  describe('Given any commits', () => {
    describe('When rendered', () => {
      it('Then each is listed once, in order, with only bare indents ending in whitespace', () => {
        // Arrange
        const sut = squashMessage;

        // Act & Assert
        fc.assert(
          fc.property(fc.array(commit, { maxLength: 5 }), (commits) => {
            const result = sut(commits);
            const ids = [...result.matchAll(/^commit ([0-9a-f]{40})$/gm)].map((m) => m[1]);
            expect(ids).toEqual(commits.map((c) => c.id));
            const trailing = result.split('\n').filter((line) => /[ \t\r]$/.test(line));
            expect(trailing.every((line) => line === '    ')).toBe(true);
          }),
        );
      });
    });
  });
});
