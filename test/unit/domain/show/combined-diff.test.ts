import { describe, expect, it } from 'vitest';

import type { FileMode, ObjectId } from '../../../../src/domain/objects/index.js';
import {
  type CombinedFile,
  renderCombinedDiff,
} from '../../../../src/domain/show/combined-diff.js';

const REGULAR = '100644' as FileMode;
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const oid = (prefix: string): ObjectId => prefix.padEnd(40, '0') as ObjectId;

const P0 = oid('aaaaaaa');
const P1 = oid('bbbbbbb');
const P2 = oid('ccccccc');
const R = oid('ddddddd');

// The canonical two-parent example: main edits l2→MAIN2, feature edits l4→FEAT4.
const twoParent: CombinedFile = {
  path: 'a.txt',
  resultContent: enc('l1\nMAIN2\nl3\nFEAT4\nl5\n'),
  resultBlob: R,
  resultMode: REGULAR,
  parents: [
    { content: enc('l1\nMAIN2\nl3\nl4\nl5\n'), blob: P0, mode: REGULAR },
    { content: enc('l1\nl2\nl3\nFEAT4\nl5\n'), blob: P1, mode: REGULAR },
  ],
};

describe('Given renderCombinedDiff on a two-parent merge', () => {
  describe('When the merge combines changes from both sides', () => {
    it('Then it matches git --cc byte-for-byte', () => {
      // Arrange + Act
      const sut = renderCombinedDiff([twoParent], true);

      // Assert
      expect(sut).toBe(
        'diff --cc a.txt\n' +
          'index aaaaaaa,bbbbbbb..ddddddd\n' +
          '--- a/a.txt\n' +
          '+++ b/a.txt\n' +
          '@@@ -1,5 -1,5 +1,5 @@@\n' +
          '  l1\n' +
          ' -l2\n' +
          ' +MAIN2\n' +
          '  l3\n' +
          '- l4\n' +
          '+ FEAT4\n' +
          '  l5\n',
      );
    });

    it('Then -c (non-dense) uses the --combined marker', () => {
      // Arrange + Act
      const sut = renderCombinedDiff([twoParent], false);

      // Assert
      expect(sut.startsWith('diff --combined a.txt\n')).toBe(true);
    });
  });
});

describe('Given a merge that took one parent verbatim', () => {
  // Result equals parent 0; only parent 1 differs.
  const trivial: CombinedFile = {
    path: 'a.txt',
    resultContent: enc('l1\nKEPT\nl3\n'),
    resultBlob: R,
    resultMode: REGULAR,
    parents: [
      { content: enc('l1\nKEPT\nl3\n'), blob: P0, mode: REGULAR },
      { content: enc('l1\nOTHER\nl3\n'), blob: P1, mode: REGULAR },
    ],
  };

  describe('When dense (--cc)', () => {
    it('Then the file is dropped (single-parent change)', () => {
      // Arrange + Act + Assert
      expect(renderCombinedDiff([trivial], true)).toBe('');
    });
  });

  describe('When non-dense (-c)', () => {
    it('Then the single-parent change is still shown', () => {
      // Arrange + Act + Assert
      expect(renderCombinedDiff([trivial], false)).toContain('diff --combined a.txt\n');
    });
  });
});

describe('Given both parents deleting the same line at the same position', () => {
  // The lost line is shared, so it merges into one row with two `-` columns.
  const sharedDelete: CombinedFile = {
    path: 'd.txt',
    resultContent: enc('x\ny\n'),
    resultBlob: R,
    resultMode: REGULAR,
    parents: [
      { content: enc('x\nDEL\ny\n'), blob: P0, mode: REGULAR },
      { content: enc('x\nDEL\ny\n'), blob: P1, mode: REGULAR },
    ],
  };

  describe('When rendered dense', () => {
    it('Then the shared lost line shows two minus columns', () => {
      // Arrange + Act
      const sut = renderCombinedDiff([sharedDelete], true);

      // Assert
      expect(sut).toContain('@@@ -1,3 -1,3 +1,2 @@@\n');
      expect(sut).toContain('--DEL\n');
    });
  });
});

describe('Given a file identical to every parent', () => {
  const unchanged: CombinedFile = {
    path: 'same.txt',
    resultContent: enc('a\nb\n'),
    resultBlob: R,
    resultMode: REGULAR,
    parents: [
      { content: enc('a\nb\n'), blob: P0, mode: REGULAR },
      { content: enc('a\nb\n'), blob: P1, mode: REGULAR },
    ],
  };

  describe('When rendered', () => {
    it('Then it produces no diff (no interesting rows)', () => {
      // Arrange + Act + Assert
      expect(renderCombinedDiff([unchanged], true)).toBe('');
    });
  });
});

describe('Given two changes far apart in one file', () => {
  // Both parents are identical and differ from the result at two distant lines,
  // so the combined diff emits two separate @@@ hunks.
  const baseLines = Array.from({ length: 14 }, (_, i) => `line${i}`).join('\n');
  const resultLines = baseLines.replace('line1', 'TOP').replace('line12', 'BOTTOM');
  const twoHunks: CombinedFile = {
    path: 'big.txt',
    resultContent: enc(`${resultLines}\n`),
    resultBlob: R,
    resultMode: REGULAR,
    parents: [
      { content: enc(`${baseLines}\n`), blob: P0, mode: REGULAR },
      { content: enc(`${baseLines}\n`), blob: P1, mode: REGULAR },
    ],
  };

  describe('When rendered dense', () => {
    it('Then it emits two hunks', () => {
      // Arrange + Act
      const sut = renderCombinedDiff([twoHunks], true);

      // Assert
      const hunkHeaders = sut.match(/@@@ /g) ?? [];
      expect(hunkHeaders.length).toBe(2);
      expect(sut).toContain('TOP');
      expect(sut).toContain('BOTTOM');
    });
  });
});

describe('Given an octopus (three-parent) merge', () => {
  // Each parent differs on a distinct line; the result combines all three.
  const octopus: CombinedFile = {
    path: 'o.txt',
    resultContent: enc('A\nB\nC\n'),
    resultBlob: R,
    resultMode: REGULAR,
    parents: [
      { content: enc('X\nB\nC\n'), blob: P0, mode: REGULAR },
      { content: enc('A\nY\nC\n'), blob: P1, mode: REGULAR },
      { content: enc('A\nB\nZ\n'), blob: P2, mode: REGULAR },
    ],
  };

  describe('When rendered dense', () => {
    it('Then the header has four @ and three parent ranges, and lines carry three columns', () => {
      // Arrange + Act
      const sut = renderCombinedDiff([octopus], true);

      // Assert
      expect(sut).toContain('@@@@ -1,3 -1,3 -1,3 +1,3 @@@@\n');
      // `A` is added vs parent 0 (X), context for parents 1 and 2.
      expect(sut).toContain('+  A\n');
      // `Y` was lost from parent 1 only.
      expect(sut).toContain(' - Y\n');
    });
  });
});
