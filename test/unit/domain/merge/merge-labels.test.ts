import { describe, expect, it } from 'vitest';

import {
  abbreviateOid,
  mergeLabels,
  replayLabels,
  revertLabels,
  STASH_LABELS,
} from '../../../../src/domain/merge/merge-labels.js';
import { ObjectId } from '../../../../src/domain/objects/object-id.js';

describe('abbreviateOid', () => {
  describe('Given a full oid', () => {
    describe('When abbreviated', () => {
      it('Then it returns the leading 7 hex characters', () => {
        // Arrange
        const oid = ObjectId.from('2c77705abcdef0123456789abcdef0123456789a');

        // Act
        const result = abbreviateOid(oid);

        // Assert
        expect(result).toBe('2c77705');
      });
    });
  });
});

describe('replayLabels', () => {
  describe('Given a commit oid and subject', () => {
    describe('When building the cherry-pick / rebase labels', () => {
      it('Then ours is HEAD, theirs is the commit label, base is its parent', () => {
        // Arrange
        const oid = ObjectId.from('2c77705abcdef0123456789abcdef0123456789a');

        // Act
        const result = replayLabels(oid, 'feat subject');

        // Assert
        expect(result).toEqual({
          ours: 'HEAD',
          theirs: '2c77705 (feat subject)',
          base: 'parent of 2c77705 (feat subject)',
        });
      });
    });
  });
});

describe('revertLabels', () => {
  describe('Given a commit oid and subject', () => {
    describe('When building the revert labels', () => {
      it('Then theirs is the parent and base is the commit (the inverse of replay)', () => {
        // Arrange
        const oid = ObjectId.from('2c77705abcdef0123456789abcdef0123456789a');

        // Act
        const result = revertLabels(oid, 'change to X');

        // Assert
        expect(result).toEqual({
          ours: 'HEAD',
          theirs: 'parent of 2c77705 (change to X)',
          base: '2c77705 (change to X)',
        });
      });
    });
  });
});

describe('mergeLabels', () => {
  describe('Given a rev name and a merge base', () => {
    describe('When building the merge labels', () => {
      it('Then ours is HEAD, theirs is the rev verbatim, base is the abbreviated merge base', () => {
        // Arrange
        const base = ObjectId.from('4ed8aa7bcdef0123456789abcdef0123456789ab');

        // Act
        const result = mergeLabels('feature', base);

        // Assert
        expect(result).toEqual({ ours: 'HEAD', theirs: 'feature', base: '4ed8aa7' });
      });
    });
  });

  describe('Given a rev name and no merge base', () => {
    describe('When building the merge labels', () => {
      it('Then the base label is empty', () => {
        // Arrange
        const revName = 'feature';

        // Act
        const result = mergeLabels(revName, undefined);

        // Assert
        expect(result).toEqual({ ours: 'HEAD', theirs: 'feature', base: '' });
      });
    });
  });
});

describe('STASH_LABELS', () => {
  describe('Given the fixed stash labels', () => {
    describe('When read', () => {
      it('Then they are git`s Updated upstream / Stashed changes / Stash base', () => {
        // Arrange + Act + Assert
        expect(STASH_LABELS).toEqual({
          ours: 'Updated upstream',
          theirs: 'Stashed changes',
          base: 'Stash base',
        });
      });
    });
  });
});
