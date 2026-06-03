import { describe, expect, it } from 'vitest';

import type { AuthorIdentity, CommitData, ObjectId } from '../../../../src/domain/objects/index.js';
import { defaultDateFormatter } from '../../../../src/domain/show/identity-header.js';
import type { PrettyFormat } from '../../../../src/domain/show/pretty-format.js';
import {
  type PrettyCommitContext,
  renderPrettyCommit,
} from '../../../../src/domain/show/render-pretty.js';

const author: AuthorIdentity = {
  name: 'A U Thor',
  email: 'author@example.com',
  timestamp: 1_700_000_100,
  timezoneOffset: '+0000',
};
const ID = 'dc989f9ef804aeba7f0f84db263d05419abafa29' as ObjectId;
const commit: CommitData = {
  tree: 'ae7617af6291aabc261ad7f1f06d54044b943043' as ObjectId,
  parents: [],
  author,
  committer: author,
  message: 'subj\n',
  extraHeaders: [],
};
const ctx: PrettyCommitContext = {
  id: ID,
  commit,
  formatDate: defaultDateFormatter,
  dateMode: { kind: 'default' },
  now: 0,
  refs: [],
};

const PATCH = 'diff --git a/a b/a\n';
const custom = (terminator: boolean): PrettyFormat => ({
  kind: 'custom',
  template: '%h %s',
  terminator,
});

describe('Given renderPrettyCommit framing', () => {
  describe('When oneline', () => {
    it('Then the patch attaches with no blank line', () => {
      // Arrange + Act + Assert
      expect(
        renderPrettyCommit({ kind: 'builtin', name: 'oneline' }, ctx, {
          noPatch: false,
          patchText: PATCH,
        }),
      ).toBe(`${ID} subj\n${PATCH}`);
    });
  });

  describe('When a format: custom (no terminator)', () => {
    it('Then no-patch omits the trailing newline and patch attaches after one newline', () => {
      // Arrange + Act + Assert
      expect(renderPrettyCommit(custom(false), ctx, { noPatch: true })).toBe('dc989f9 subj');
      expect(renderPrettyCommit(custom(false), ctx, { noPatch: false, patchText: PATCH })).toBe(
        `dc989f9 subj\n${PATCH}`,
      );
    });
  });

  describe('When a tformat: custom (terminator)', () => {
    it('Then no-patch terminates and the patch attaches after a blank line', () => {
      // Arrange + Act + Assert
      expect(renderPrettyCommit(custom(true), ctx, { noPatch: true })).toBe('dc989f9 subj\n');
      expect(renderPrettyCommit(custom(true), ctx, { noPatch: false, patchText: PATCH })).toBe(
        `dc989f9 subj\n\n${PATCH}`,
      );
    });
  });

  describe('When medium with no patch supplied', () => {
    it('Then the block ends after the message with a single newline', () => {
      // Arrange + Act
      const sut = renderPrettyCommit({ kind: 'builtin', name: 'medium' }, ctx, { noPatch: false });

      // Assert
      expect(sut.endsWith('    subj\n')).toBe(true);
    });
  });

  describe('When a custom format reads decoration on the HEAD branch tip', () => {
    it('Then %d resolves through the threaded headBranch', () => {
      // Arrange — exercises the custom-path headBranch spread.
      const decorated: PrettyCommitContext = {
        ...ctx,
        refs: [{ fullName: 'refs/heads/main', kind: 'head' }],
        headBranch: 'refs/heads/main',
      };

      // Act
      const sut = renderPrettyCommit(
        { kind: 'custom', template: '%d', terminator: false },
        decorated,
        {
          noPatch: true,
        },
      );

      // Assert
      expect(sut).toBe(' (HEAD -> main)');
    });
  });

  describe('When a custom format reads decoration on a detached HEAD', () => {
    it('Then %D resolves through the threaded detachedHead flag', () => {
      // Arrange — exercises the custom-path detachedHead spread.
      const detached: PrettyCommitContext = { ...ctx, refs: [], detachedHead: true };

      // Act
      const sut = renderPrettyCommit(
        { kind: 'custom', template: '%D', terminator: false },
        detached,
        {
          noPatch: true,
        },
      );

      // Assert
      expect(sut).toBe('HEAD');
    });
  });
});
