import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { AuthorIdentity, CommitData, ObjectId } from '../../../../src/domain/objects/index.js';
import {
  buildCommitFields,
  expandTemplate,
} from '../../../../src/domain/show/pretty-placeholders.js';

const author: AuthorIdentity = {
  name: 'A U Thor',
  email: 'a@e',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};
const commit: CommitData = {
  tree: 'ae7617af6291aabc261ad7f1f06d54044b943043' as ObjectId,
  parents: [],
  author,
  committer: author,
  message: 'subj\n',
  extraHeaders: [],
};
const fields = buildCommitFields({
  id: 'dc989f9ef804aeba7f0f84db263d05419abafa29' as ObjectId,
  commit,
  dateMode: { kind: 'default' },
  now: 0,
  refs: [],
});

describe('Given an arbitrary template', () => {
  describe('When it is expanded', () => {
    it('Then expansion is total — it never throws', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(fc.string(), (template) => {
          expandTemplate(template, fields);
        }),
        { numRuns: 200 },
      );
    });
  });

  describe('When the template has no percent sign', () => {
    it('Then it passes through verbatim', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(
          fc.string().filter((s) => !s.includes('%')),
          (literal) => {
            expect(expandTemplate(literal, fields)).toBe(literal);
          },
        ),
        { numRuns: 200 },
      );
    });
  });
});
