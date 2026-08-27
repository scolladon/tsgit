import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { Commit, CommitData } from '../../../../src/domain/objects/commit.js';
import {
  parseCommitContent,
  serializeCommitContent,
} from '../../../../src/domain/objects/commit.js';
import { ObjectId } from '../../../../src/domain/objects/object-id.js';
import {
  arbArmorBlock,
  arbAuthorIdentity,
  arbCommitMessageWithOptionalBom,
  arbExtraHeader,
  arbObjectId,
} from './arbitraries.js';

const DUMMY_ID = ObjectId.from('a'.repeat(40));

// `gpgSignature` is a genuinely optional key (`fc.record`'s `requiredKeys`
// omits it entirely on some runs, never sets it to `undefined`) — the same
// conditional-spread shape `parseCommitContent` produces, so a run sometimes
// covers the "no signature" branch and sometimes the "signed" branch of both
// serialize and parse. `tree`/`parents` share one hash width per run (`.chain`
// correlates them, matching how a real repository never mixes SHA-1 and
// SHA-256 pointers within one commit) so both the 40- and 64-char oid shapes
// are exercised, not only the historical SHA-1 width.
function arbCommitData(): fc.Arbitrary<CommitData> {
  return fc.constantFrom(40 as const, 64 as const).chain((width) =>
    fc.record(
      {
        tree: arbObjectId(width),
        parents: fc.array(arbObjectId(width), { maxLength: 3 }),
        author: arbAuthorIdentity(),
        committer: arbAuthorIdentity(),
        message: arbCommitMessageWithOptionalBom(),
        gpgSignature: arbArmorBlock(),
        extraHeaders: fc.array(arbExtraHeader(), { maxLength: 3 }),
      },
      { requiredKeys: ['tree', 'parents', 'author', 'committer', 'message', 'extraHeaders'] },
    ),
  );
}

const buildCommit = (data: CommitData): Commit => ({ type: 'commit', id: DUMMY_ID, data });

describe('commit properties', () => {
  describe('Given an arbitrary commit', () => {
    describe('When serialized then parsed', () => {
      it('Then it round-trips structurally', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(arbCommitData(), (data) => {
            const commit = buildCommit(data);
            const bytes = serializeCommitContent(commit);
            const result = parseCommitContent(DUMMY_ID, bytes);
            expect(result.data).toEqual(data);
          }),
          { numRuns: 200 },
        );
      });

      it('Then gpgSignature key presence round-trips', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(arbCommitData(), (data) => {
            const commit = buildCommit(data);
            const bytes = serializeCommitContent(commit);
            const result = parseCommitContent(DUMMY_ID, bytes);
            expect('gpgSignature' in result.data).toBe('gpgSignature' in data);
          }),
          { numRuns: 200 },
        );
      });
    });
  });
});
