import { describe, expect, it } from 'vitest';
import { mergeTagHeader } from '../../../../src/domain/merge/merge-tag-header.js';
import type { Commit, ObjectId } from '../../../../src/domain/objects/index.js';
import { serializeCommitContent } from '../../../../src/domain/objects/index.js';

const TAG = 'object abc\ntype commit\ntag v1\n\nbody\n-----BEGIN PGP SIGNATURE-----\n';

const IDENTITY = { name: 'A', email: 'a@x', timestamp: 0, timezoneOffset: '+0000' };

const commitWith = (value: string): string => {
  const commit: Commit = {
    type: 'commit',
    id: '' as ObjectId,
    data: {
      tree: 'tree' as ObjectId,
      parents: [],
      author: IDENTITY,
      committer: IDENTITY,
      message: 'm\n',
      extraHeaders: [{ key: 'mergetag', value }],
    },
  };
  return new TextDecoder().decode(serializeCommitContent(commit));
};

describe('mergeTagHeader', () => {
  describe('Given a tag object ending in a newline', () => {
    describe('When made a merge header', () => {
      it('Then it is a mergetag header holding the object without that newline', () => {
        // Arrange
        const sut = mergeTagHeader;

        // Act
        const result = sut(TAG);

        // Assert
        expect(result).toEqual({ key: 'mergetag', value: TAG.slice(0, -1) });
      });

      it("Then a commit carries it as git's strbuf_add_lines indents it", () => {
        // Arrange
        const sut = mergeTagHeader;

        // Act
        const result = commitWith(sut(TAG).value);

        // Assert
        expect(result).toContain(
          'mergetag object abc\n type commit\n tag v1\n \n body\n -----BEGIN PGP SIGNATURE-----\n\nm\n',
        );
      });
    });
  });

  describe('Given a tag object with no final newline', () => {
    describe('When made a merge header', () => {
      it('Then the object is kept whole', () => {
        // Arrange
        const sut = mergeTagHeader;

        // Act
        const result = sut('object abc\n\nbody');

        // Assert
        expect(result).toEqual({ key: 'mergetag', value: 'object abc\n\nbody' });
      });
    });
  });
});
