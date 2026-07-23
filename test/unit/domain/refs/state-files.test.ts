import { describe, expect, it } from 'vitest';
import {
  CHERRY_PICK_HEAD,
  FETCH_HEAD,
  MERGE_HEAD,
  MERGE_MSG,
  ORIG_HEAD,
  REBASE_HEAD,
  REVERT_HEAD,
} from '../../../../src/domain/refs/state-files.js';

const sut = {
  MERGE_HEAD,
  MERGE_MSG,
  ORIG_HEAD,
  CHERRY_PICK_HEAD,
  REVERT_HEAD,
  REBASE_HEAD,
  FETCH_HEAD,
} as const;

describe('Given the git state-marker filenames', () => {
  describe('When reading the canonical constants', () => {
    it.each([
      { key: 'MERGE_HEAD', label: 'is the merge marker filename' },
      { key: 'MERGE_MSG', label: 'is the merge-message filename' },
      { key: 'ORIG_HEAD', label: 'is the original-HEAD filename' },
      { key: 'CHERRY_PICK_HEAD', label: 'is the cherry-pick marker filename' },
      { key: 'REVERT_HEAD', label: 'is the revert marker filename' },
      { key: 'REBASE_HEAD', label: 'is the rebase marker filename' },
      { key: 'FETCH_HEAD', label: 'is the fetch marker filename' },
    ] as const)('Then $key $label', ({ key }) => {
      // Arrange / Act / Assert
      expect(sut[key]).toBe(key);
    });
  });
});
