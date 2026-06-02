import { describe, expect, it } from 'vitest';

import type { AuthorIdentity, CommitData, ObjectId } from '../../../../src/domain/objects/index.js';
import { renderCommitBlock } from '../../../../src/domain/show/render-commit.js';

const ID = '1377f4f38aca6c947ec77a2abfebb713f0fde8d4' as ObjectId;
const TREE = 'ae7617af6291aabc261ad7f1f06d54044b943043' as ObjectId;
const PARENT_A = '80d1ead1c99346b02fd5c78d3a64a45164344d3c' as ObjectId;
const PARENT_B = '5164635f157d25cd94d62a684fd720caa57a851d' as ObjectId;

const author: AuthorIdentity = {
  name: 'A U Thor',
  email: 'author@example.com',
  timestamp: 1700000000,
  timezoneOffset: '+0000',
};
// Distinct committer date so a test can prove the Author line uses the author.
const committer: AuthorIdentity = { ...author, timestamp: 1799999999 };

const commit = (overrides: Partial<CommitData> = {}): CommitData => ({
  tree: TREE,
  parents: [],
  author,
  committer,
  message: 'modify a.txt',
  extraHeaders: [],
  ...overrides,
});

describe('renderCommitBlock', () => {
  describe('Given a non-merge commit with a patch, When renderCommitBlock runs', () => {
    it('Then header, author date, indented message, and patch are joined', () => {
      // Arrange
      const patchText = 'diff --git a/a.txt b/a.txt\n@@ -1 +1 @@\n-a\n+b\n';

      // Act
      const sut = renderCommitBlock({ id: ID, commit: commit(), patchText });

      // Assert
      expect(sut).toBe(
        `commit ${ID}\nAuthor: A U Thor <author@example.com>\nDate:   Tue Nov 14 22:13:20 2023 +0000\n\n    modify a.txt\n\n${patchText}`,
      );
    });
  });

  describe('Given a non-merge commit without a patch, When renderCommitBlock runs', () => {
    it('Then the block ends after the indented message', () => {
      // Arrange + Act
      const sut = renderCommitBlock({ id: ID, commit: commit() });

      // Assert
      expect(sut).toBe(
        `commit ${ID}\nAuthor: A U Thor <author@example.com>\nDate:   Tue Nov 14 22:13:20 2023 +0000\n\n    modify a.txt\n`,
      );
    });
  });

  describe('Given an empty patch string, When renderCommitBlock runs', () => {
    it('Then no patch tail is appended', () => {
      // Arrange + Act
      const sut = renderCommitBlock({ id: ID, commit: commit(), patchText: '' });

      // Assert
      expect(sut.endsWith('    modify a.txt\n')).toBe(true);
    });
  });

  describe('Given a merge commit, When renderCommitBlock runs', () => {
    it('Then a Merge line precedes the author and a trailing blank terminates the block', () => {
      // Arrange + Act
      const sut = renderCommitBlock({
        id: ID,
        commit: commit({ parents: [PARENT_A, PARENT_B], message: 'merge feature' }),
      });

      // Assert — git terminates a no-patch merge with a trailing blank line.
      expect(sut).toBe(
        `commit ${ID}\nMerge: 80d1ead 5164635\nAuthor: A U Thor <author@example.com>\nDate:   Tue Nov 14 22:13:20 2023 +0000\n\n    merge feature\n\n`,
      );
    });
  });

  describe('Given a single-parent commit, When renderCommitBlock runs', () => {
    it('Then no Merge line is emitted', () => {
      // Arrange + Act
      const sut = renderCommitBlock({ id: ID, commit: commit({ parents: [PARENT_A] }) });

      // Assert
      expect(sut.includes('Merge:')).toBe(false);
    });
  });
});
