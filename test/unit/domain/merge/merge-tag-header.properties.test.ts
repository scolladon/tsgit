/**
 * Properties of the `mergetag` header: a commit carrying any tag object's text
 * parses back to that text, its completed final line restored.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { mergeTagHeader } from '../../../../src/domain/merge/merge-tag-header.js';
import type { Commit, ObjectId } from '../../../../src/domain/objects/index.js';
import {
  parseCommitContent,
  serializeCommitContent,
} from '../../../../src/domain/objects/index.js';

const TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904' as ObjectId;
const IDENTITY = { name: 'A', email: 'a@x', timestamp: 0, timezoneOffset: '+0000' };

const line = fc.stringMatching(/^[\t a-z#-]{0,12}$/);
const tagText = fc
  .array(line, { minLength: 1, maxLength: 6 })
  .map((lines) => `object x\n${lines.join('\n')}\n`);

const roundTrip = (value: string): string | undefined => {
  const commit: Commit = {
    type: 'commit',
    id: '' as ObjectId,
    data: {
      tree: TREE,
      parents: [],
      author: IDENTITY,
      committer: IDENTITY,
      message: 'm\n',
      extraHeaders: [{ key: 'mergetag', value }],
    },
  };
  const parsed = parseCommitContent(TREE, serializeCommitContent(commit));
  return parsed.data.extraHeaders[0]?.value;
};

describe('mergeTagHeader properties', () => {
  describe('Given any tag object text', () => {
    describe('When carried by a commit and parsed back', () => {
      it('Then the completed header value is the tag text', () => {
        // Arrange
        const sut = mergeTagHeader;

        // Act & Assert
        fc.assert(
          fc.property(tagText, (tag) => {
            const result = roundTrip(sut(tag).value);
            expect(`${result}\n`).toBe(tag);
          }),
        );
      });
    });
  });
});
