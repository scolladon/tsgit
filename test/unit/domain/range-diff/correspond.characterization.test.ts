import { describe, expect, it } from 'vitest';
import type { ObjectId } from '../../../../src/domain/objects/index.js';
import { correspond } from '../../../../src/domain/range-diff/correspond.js';
import type { RenderedPatch } from '../../../../src/domain/range-diff/patch-text.js';

// Characterization — diverse patch series (exact / fuzzy / unique diffs, varied
// counts and creation factors) with the exact matching the engine produces. Pins
// correspond observable output so output-changing mutants die (the byte-faithful
// interop is outside the mutation runner).
const DIFF_POOL: ReadonlyArray<string> = [
  '+l0\n+l1\n+l2\n+l3\n+l4\n+l5\n+l6\n+l7\n+l8\n+l9\n+Y\n+l11\n+l12\n+l13\n+l14\n+l15\n+l16\n+l17\n+l18\n+l19\n+l20\n+l21\n',
  ' ## f ##\n@@\n+a\n',
  '+m0\n+m1\n+m2\n+m3\n+m4\n+m5\n+m6\n+m7\n+m8\n+m9\n+m10\n+m11\n+m12\n+m13\n+m14\n+m15\n+m16\n+m17\n+m18\n+m19\n+m20\n+m21\n+m22\n+m23\n+m24\n+m25\n+m26\n+m27\n+m28\n+m29\n',
  '+l0\n+l1\n+l2\n+l3\n+l4\n+l5\n+l6\n+l7\n+l8\n+l9\n+X\n+l11\n+l12\n+l13\n+l14\n+l15\n+l16\n+l17\n+l18\n+l19\n+l20\n+l21\n',
  ' ## f ##\n@@\n+b\n',
];
const patch = (poolIndex: number, n: number): RenderedPatch => {
  const diff = DIFF_POOL[poolIndex]!;
  return {
    id: String(n).repeat(40) as ObjectId,
    subject: String(n),
    patch: diff,
    diff,
    diffsize: diff.split('\n').length - 1,
  };
};
interface CorrCase {
  readonly o: number[];
  readonly n: number[];
  readonly cf: number;
  readonly oldM: number[];
  readonly newM: number[];
}
const CASES: ReadonlyArray<CorrCase> = [
  { o: [0], n: [1], cf: 0, oldM: [-1], newM: [-1] },
  { o: [1], n: [2], cf: 1, oldM: [-1], newM: [-1] },
  { o: [2], n: [0], cf: 30, oldM: [-1], newM: [-1] },
  { o: [3], n: [0], cf: 60, oldM: [0], newM: [0] },
  { o: [0], n: [2], cf: 90, oldM: [-1], newM: [-1] },
  { o: [2, 4], n: [3, 2], cf: 0, oldM: [1, -1], newM: [-1, 0] },
  { o: [2, 0], n: [3, 3], cf: 1, oldM: [-1, -1], newM: [-1, -1] },
  { o: [0, 2], n: [0, 1], cf: 30, oldM: [0, -1], newM: [0, -1] },
  { o: [1, 3], n: [3, 4], cf: 60, oldM: [-1, 0], newM: [1, -1] },
  { o: [3, 1], n: [3, 0], cf: 90, oldM: [0, -1], newM: [0, -1] },
  { o: [1, 2, 1], n: [1, 2], cf: 0, oldM: [-1, 1, 0], newM: [2, 1] },
  { o: [0, 0, 1], n: [0, 1], cf: 1, oldM: [-1, 0, 1], newM: [1, 2] },
  { o: [1, 1, 4], n: [4, 0], cf: 30, oldM: [-1, -1, 0], newM: [2, -1] },
  { o: [4, 2, 2], n: [2, 0], cf: 60, oldM: [-1, -1, 0], newM: [2, -1] },
  { o: [2, 0, 3], n: [1, 2], cf: 90, oldM: [1, -1, -1], newM: [-1, 0] },
  { o: [2, 0], n: [3, 2, 1], cf: 0, oldM: [1, -1], newM: [-1, 0, -1] },
  { o: [3, 0], n: [0, 0, 3], cf: 1, oldM: [2, 0], newM: [1, -1, 0] },
  { o: [3, 1], n: [2, 2, 1], cf: 30, oldM: [-1, 2], newM: [-1, -1, 1] },
  { o: [3, 2], n: [2, 0, 1], cf: 60, oldM: [1, 0], newM: [1, 0, -1] },
  { o: [2, 2], n: [1, 1, 3], cf: 90, oldM: [-1, -1], newM: [-1, -1, -1] },
  { o: [3, 0, 3], n: [1, 0, 3], cf: 0, oldM: [-1, 1, 2], newM: [-1, 1, 2] },
  { o: [0, 4, 3], n: [4, 3, 0], cf: 1, oldM: [2, 0, 1], newM: [1, 2, 0] },
  { o: [2, 2, 1], n: [4, 1, 2], cf: 30, oldM: [-1, 2, 1], newM: [-1, 2, 1] },
  { o: [2, 0, 0], n: [4, 3, 1], cf: 60, oldM: [-1, -1, 1], newM: [-1, 2, -1] },
  { o: [2, 3, 3], n: [4, 4, 4], cf: 90, oldM: [-1, -1, -1], newM: [-1, -1, -1] },
  { o: [4, 0, 1, 1], n: [3, 3, 3], cf: 0, oldM: [-1, -1, -1, -1], newM: [-1, -1, -1] },
  { o: [3, 2, 1, 3], n: [1, 4, 1], cf: 1, oldM: [-1, -1, 0, -1], newM: [2, -1, -1] },
  { o: [3, 2, 0, 4], n: [2, 2, 0], cf: 30, oldM: [-1, 0, 2, -1], newM: [1, -1, 2] },
  { o: [0, 3, 0, 4], n: [2, 0, 0], cf: 60, oldM: [2, -1, 1, -1], newM: [-1, 2, 0] },
  { o: [4, 2, 3, 1], n: [0, 2, 1], cf: 90, oldM: [-1, 1, 0, 2], newM: [2, 1, 3] },
  { o: [0, 4, 1], n: [4, 0, 3, 0], cf: 0, oldM: [1, 0, -1], newM: [1, 0, -1, -1] },
  { o: [3, 1, 3], n: [0, 1, 2, 3], cf: 1, oldM: [-1, 1, 3], newM: [-1, 1, -1, 2] },
  { o: [2, 0, 3], n: [2, 1, 4, 4], cf: 30, oldM: [0, -1, -1], newM: [0, -1, -1, -1] },
  { o: [4, 4, 3], n: [2, 2, 3, 4], cf: 60, oldM: [-1, 3, 2], newM: [-1, -1, 2, 1] },
  { o: [3, 4, 0], n: [1, 4, 4, 0], cf: 90, oldM: [-1, 1, 3], newM: [-1, 1, -1, 2] },
  { o: [4, 1, 3, 2], n: [2, 2, 0, 1], cf: 0, oldM: [-1, 3, -1, 0], newM: [3, -1, -1, 1] },
  { o: [1, 2, 1, 2], n: [3, 1, 3, 2], cf: 1, oldM: [-1, -1, 1, 3], newM: [-1, 2, -1, 3] },
  { o: [2, 0, 4, 0], n: [0, 4, 4, 3], cf: 30, oldM: [-1, 3, 1, 0], newM: [3, 2, -1, 1] },
  { o: [1, 0, 0, 0], n: [2, 3, 3, 2], cf: 60, oldM: [-1, -1, 2, 1], newM: [-1, 3, 2, -1] },
  { o: [2, 1, 3, 4], n: [3, 0, 4, 2], cf: 90, oldM: [3, -1, 0, 2], newM: [2, -1, 3, 0] },
  { o: [1, 0, 3, 0, 0], n: [3, 2, 0, 0], cf: 0, oldM: [-1, -1, 0, 3, 2], newM: [2, -1, 4, 3] },
  { o: [1, 0, 0, 3, 4], n: [1, 2, 4, 4], cf: 1, oldM: [0, -1, -1, -1, 2], newM: [0, -1, 4, -1] },
  { o: [0, 4, 0, 0, 4], n: [3, 3, 0, 0], cf: 30, oldM: [0, -1, 3, 2, -1], newM: [0, -1, 3, 2] },
  { o: [2, 1, 0, 3, 0], n: [1, 0, 2, 0], cf: 60, oldM: [2, 0, 3, -1, 1], newM: [1, 4, 0, 2] },
  { o: [1, 1, 4, 4, 3], n: [0, 1, 2, 3], cf: 90, oldM: [-1, 1, -1, -1, 3], newM: [-1, 1, -1, 4] },
  { o: [2, 3, 3, 4], n: [4, 2, 0, 1, 4], cf: 0, oldM: [1, -1, -1, 0], newM: [3, 0, -1, -1, -1] },
  { o: [2, 3, 1, 3], n: [1, 2, 2, 1, 0], cf: 1, oldM: [1, -1, 0, -1], newM: [2, 0, -1, -1, -1] },
  { o: [2, 0, 1, 1], n: [4, 1, 2, 3, 3], cf: 30, oldM: [2, 3, -1, 1], newM: [-1, 3, 0, 1, -1] },
  { o: [2, 3, 2, 2], n: [2, 4, 1, 1, 1], cf: 60, oldM: [-1, -1, -1, 0], newM: [3, -1, -1, -1, -1] },
  { o: [3, 0, 2, 2], n: [4, 2, 3, 1, 3], cf: 90, oldM: [2, 4, -1, 1], newM: [-1, 3, 0, -1, 1] },
];

describe('correspond characterization', () => {
  describe.each(
    CASES.map((c, index) => ({ ...c, index })),
  )('Given series case #$index (cf=$cf), When corresponded', ({ o, n, cf, oldM, newM }) => {
    it('Then the matching equals the pinned engine output', () => {
      // Arrange
      const oldPatches = o.map((p, i) => patch(p, i));
      const newPatches = n.map((p, i) => patch(p, i + 100));
      // Act
      const result = correspond(oldPatches, newPatches, cf);
      // Assert
      expect(result.old.map((m) => m.matching)).toEqual(oldM);
      expect(result.new.map((m) => m.matching)).toEqual(newM);
    });
  });
});
