import { describe, expect, it } from 'vitest';

import type { AuthorIdentity, CommitData, ObjectId } from '../../../../src/domain/objects/index.js';
import { defaultDateFormatter } from '../../../../src/domain/show/identity-header.js';
import {
  type BuiltinParts,
  renderBuiltinHeader,
} from '../../../../src/domain/show/pretty-builtin.js';

const author: AuthorIdentity = {
  name: 'A U Thor',
  email: 'author@example.com',
  timestamp: 1_700_000_100,
  timezoneOffset: '+0200',
};
const committer: AuthorIdentity = {
  name: 'C O Mitter',
  email: 'committer@example.com',
  timestamp: 1_700_000_200,
  timezoneOffset: '+0000',
};

const ID = 'dc989f9ef804aeba7f0f84db263d05419abafa29' as ObjectId;
const TREE = 'ae7617af6291aabc261ad7f1f06d54044b943043' as ObjectId;
const PARENT = '2d0dc1ca224cca512ba435f0f152c5aaa3ca1141' as ObjectId;

const commit: CommitData = {
  tree: TREE,
  parents: [PARENT],
  author,
  committer,
  message: 'modify a.txt\n\nbody line\n',
  extraHeaders: [],
};

const parts: BuiltinParts = { id: ID, commit, formatDate: defaultDateFormatter, now: 0 };

describe('Given renderBuiltinHeader', () => {
  describe('When oneline', () => {
    it('Then it is the full oid and subject', () => {
      // Arrange + Act + Assert
      expect(renderBuiltinHeader('oneline', parts)).toBe(`${ID} modify a.txt`);
    });
  });

  describe('When short', () => {
    it('Then it shows Author and the indented subject only', () => {
      // Arrange + Act + Assert
      expect(renderBuiltinHeader('short', parts)).toBe(
        `commit ${ID}\nAuthor: A U Thor <author@example.com>\n\n    modify a.txt`,
      );
    });
  });

  describe('When full', () => {
    it('Then it adds the Commit line and the full message, no dates', () => {
      // Arrange + Act + Assert
      expect(renderBuiltinHeader('full', parts)).toBe(
        `commit ${ID}\nAuthor: A U Thor <author@example.com>\nCommit: C O Mitter <committer@example.com>\n\n    modify a.txt\n    \n    body line`,
      );
    });
  });

  describe('When fuller', () => {
    it('Then Author/AuthorDate/Commit/CommitDate align to column 12', () => {
      // Arrange + Act + Assert
      expect(renderBuiltinHeader('fuller', parts)).toBe(
        `commit ${ID}\nAuthor:     A U Thor <author@example.com>\nAuthorDate: Wed Nov 15 00:15:00 2023 +0200\nCommit:     C O Mitter <committer@example.com>\nCommitDate: Tue Nov 14 22:16:40 2023 +0000\n\n    modify a.txt\n    \n    body line`,
      );
    });
  });

  describe('When raw', () => {
    it('Then it shows verbatim tree/parent/author/committer header lines', () => {
      // Arrange + Act + Assert
      expect(renderBuiltinHeader('raw', parts)).toBe(
        `commit ${ID}\ntree ${TREE}\nparent ${PARENT}\nauthor A U Thor <author@example.com> 1700000100 +0200\ncommitter C O Mitter <committer@example.com> 1700000200 +0000\n\n    modify a.txt\n    \n    body line`,
      );
    });
  });

  describe('When reference', () => {
    it('Then it is the abbreviated oid with subject and author short-date', () => {
      // Arrange + Act + Assert
      expect(renderBuiltinHeader('reference', parts)).toBe('dc989f9 (modify a.txt, 2023-11-15)');
    });
  });

  describe('When email', () => {
    it('Then it is the mbox envelope plus the blank line and body', () => {
      // Arrange + Act + Assert
      expect(renderBuiltinHeader('email', parts)).toBe(
        `From ${ID} Mon Sep 17 00:00:00 2001\nFrom: A U Thor <author@example.com>\nDate: Wed, 15 Nov 2023 00:15:00 +0200\nSubject: [PATCH] modify a.txt\n\nbody line\n`,
      );
    });
  });

  describe('When email on a no-body commit', () => {
    it('Then the Subject is followed by a blank line and an empty body', () => {
      // Arrange
      const noBody: CommitData = { ...commit, message: 'just a subject\n' };

      // Act + Assert
      expect(renderBuiltinHeader('email', { ...parts, commit: noBody })).toBe(
        `From ${ID} Mon Sep 17 00:00:00 2001\nFrom: A U Thor <author@example.com>\nDate: Wed, 15 Nov 2023 00:15:00 +0200\nSubject: [PATCH] just a subject\n\n`,
      );
    });
  });

  describe('When mboxrd with a From-quoted body line', () => {
    it('Then body lines matching ^>*From get a leading >', () => {
      // Arrange
      const fromBody: CommitData = { ...commit, message: 'subj\n\nFrom here\n' };

      // Act + Assert
      expect(renderBuiltinHeader('mboxrd', { ...parts, commit: fromBody })).toBe(
        `From ${ID} Mon Sep 17 00:00:00 2001\nFrom: A U Thor <author@example.com>\nDate: Wed, 15 Nov 2023 00:15:00 +0200\nSubject: [PATCH] subj\n\n>From here\n`,
      );
    });
  });

  describe('When a merge commit is rendered with a commit-header format', () => {
    it('Then the Merge line lists abbreviated parents', () => {
      // Arrange
      const merge: CommitData = { ...commit, parents: [PARENT, TREE] };

      // Act
      const sut = renderBuiltinHeader('short', { ...parts, commit: merge });

      // Assert
      expect(sut).toContain(`\nMerge: ${PARENT.slice(0, 7)} ${TREE.slice(0, 7)}\n`);
    });
  });
});
