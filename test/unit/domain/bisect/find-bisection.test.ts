import { describe, expect, it } from 'vitest';
import { findBisection } from '../../../../src/domain/bisect/find-bisection.js';
import type { BisectCandidate } from '../../../../src/domain/bisect/types.js';
import type { ObjectId } from '../../../../src/domain/objects/index.js';

const oid = (s: string): ObjectId => s.padStart(40, '0') as ObjectId;

const c = (id: string, parents: ReadonlyArray<string>): BisectCandidate => ({
  id: oid(id),
  parents: parents.map(oid),
  date: 0,
});

/**
 * Build a linear candidate list oldest-first from slice [lo..hi] of a chain
 * c0→c1→…→c9 (in-set parents already filtered — the good tip is excluded).
 *
 * The list mirrors git's limit_list order (oldest first).
 */
const linearChain = (lo: number, hi: number): ReadonlyArray<BisectCandidate> => {
  const candidates: BisectCandidate[] = [];
  for (let i = lo; i <= hi; i++) {
    const parents = i > lo ? [`c${i - 1}`] : [];
    candidates.push(c(`c${i}`, parents));
  }
  return candidates;
};

describe('findBisection', () => {
  // ─── Empty + single-candidate ────────────────────────────────────────────────

  describe('Given an empty candidate list, When finding bisection', () => {
    it('Then it returns undefined (no midpoint exists)', () => {
      // Arrange
      const sut = findBisection;

      // Act
      const result = sut([]);

      // Assert
      expect(result).toBeUndefined();
    });
  });

  describe('Given a single-candidate set (all=1), When finding bisection', () => {
    it('Then the single commit is the midpoint with reaches=1 and candidateCount=1', () => {
      // Arrange
      const sut = findBisection;
      const candidates = [c('c9', [])];

      // Act
      const result = sut(candidates);

      // Assert
      expect(result).toEqual({
        nextCommit: oid('c9'),
        candidateCount: 1,
        reaches: 1,
      });
    });
  });

  // ─── Linear-chain pinned matrix ──────────────────────────────────────────────
  // approx_halfway boundary: diff = 2*weight - all; halfway ⟺ diff ∈ {-1, 0, 1}.
  // all=9 (diff=-1), all=6 (diff=0) and all=3 (diff=1) each pin a distinct
  // approx_halfway boundary value alongside every other candidate count.

  describe('Given a linear chain c0…c9 bad=c9 with a given good tip, When finding bisection', () => {
    it.each([
      { all: 9, lo: 1, nextCommit: 'c4', reaches: 4 },
      { all: 8, lo: 2, nextCommit: 'c5', reaches: 4 },
      { all: 7, lo: 3, nextCommit: 'c5', reaches: 3 },
      { all: 6, lo: 4, nextCommit: 'c6', reaches: 3 },
      { all: 5, lo: 5, nextCommit: 'c6', reaches: 2 },
      { all: 4, lo: 6, nextCommit: 'c7', reaches: 2 },
      { all: 3, lo: 7, nextCommit: 'c8', reaches: 2 },
      { all: 2, lo: 8, nextCommit: 'c8', reaches: 1 },
      { all: 1, lo: 9, nextCommit: 'c9', reaches: 1 },
    ])(
      'Then midpoint is $nextCommit with reaches=$reaches for all=$all',
      ({ all, lo, nextCommit, reaches }) => {
        // Arrange
        const sut = findBisection;
        const candidates = linearChain(lo, 9);

        // Act
        const result = sut(candidates);

        // Assert
        expect(result?.nextCommit).toBe(oid(nextCommit));
        expect(result?.reaches).toBe(reaches);
        expect(result?.candidateCount).toBe(all);
      },
    );
  });

  describe('Given all=4 with a merge of weight=3 (diff=2), When finding bisection', () => {
    it('Then approx_halfway does NOT fire (diff=2 outside {-1,0,1}) and falls to best_bisection', () => {
      // Arrange — topology: root1, root2, merge(root1,root2), top(merge); all=4.
      // root1: seed weight=1, diff=2*1-4=-2 → not halfway
      // root2: seed weight=1, diff=-2 → not halfway
      // merge: 2 in-set parents → mergeWeights path, countDistance=3, diff=2*3-4=2 → not halfway
      // top:   fill from merge(w=3) → weight=4, diff=2*4-4=4 → not halfway
      // best_bisection: root1 dist=min(1,3)=1, root2 dist=1, merge dist=min(3,1)=1, top dist=0
      // root1 is first in list → wins the three-way tie
      const sut = findBisection;
      const root1 = c('r1', []);
      const root2 = c('r2', []);
      const merge = c('mg', ['r1', 'r2']);
      const top = c('tp', ['mg']);
      const candidates = [root1, root2, merge, top];

      // Act
      const result = sut(candidates);

      // Assert — approx_halfway never fired; result comes from best_bisection
      expect(result?.nextCommit).toBe(root1.id);
      expect(result?.reaches).toBe(1);
      expect(result?.candidateCount).toBe(4);
    });
  });

  // ─── Diamond: best_bisection tie-break (list-order, strict >) ────────────────

  describe('Given diamond all=6 (base→A1→A2 ∥ base→B1→B2 →M→top, good=base), When finding bisection', () => {
    it('Then midpoint is B2 (list-order tie-break over A2, both distance=2)', () => {
      // Arrange — oldest-first list: B1, A1, B2, A2, M, top
      // B2 appears before A2 so strict-`>` keeps B2 as winner.
      const sut = findBisection;
      const b1 = c('B1', []);
      const a1 = c('A1', []);
      const b2 = c('B2', ['B1']);
      const a2 = c('A2', ['A1']);
      const m = c('M', ['A2', 'B2']);
      const top = c('top', ['M']);
      const candidates = [b1, a1, b2, a2, m, top];

      // Act
      const result = sut(candidates);

      // Assert
      expect(result?.nextCommit).toBe(b2.id);
      expect(result?.reaches).toBe(2);
      expect(result?.candidateCount).toBe(6);
    });
  });

  describe('Given diamond all=4 (good=A1,B1: candidates=B2,A2,M,top), When finding bisection', () => {
    it('Then midpoint is B2 with reaches=1 (list-order tie-break)', () => {
      // Arrange — B2 and A2 are seeds (parents excluded); B2 before A2 in list
      const sut = findBisection;
      const b2 = c('B2', []);
      const a2 = c('A2', []);
      const m = c('M', ['A2', 'B2']);
      const top = c('top', ['M']);
      const candidates = [b2, a2, m, top];

      // Act
      const result = sut(candidates);

      // Assert
      expect(result?.nextCommit).toBe(b2.id);
      expect(result?.reaches).toBe(1);
      expect(result?.candidateCount).toBe(4);
    });
  });

  // ─── mergeWeights early-return (approx_halfway fires during merge phase) ─────

  describe('Given all=5 with a merge whose countDistance lands in the halfway band, When finding bisection', () => {
    it('Then mergeWeights fires approx_halfway and returns the merge (reaches=3, diff=1)', () => {
      // Arrange — candidates [s1, s2, merge(s1,s2), u1, u2] oldest-first; all=5.
      // s1: seed weight=1; s2: seed weight=1.
      // merge: ≥2 in-set parents → mergeWeights path;
      //   countDistance(merge) = {merge,s1,s2} = 3;
      //   approxHalfway(3,5) = 2*3-5=1 ∈ {-1,0,1} → EARLY RETURN.
      const sut = findBisection;
      const s1 = c('s1', []);
      const s2 = c('s2', []);
      const merge = c('mg', ['s1', 's2']);
      const u1 = c('u1', ['mg']);
      const u2 = c('u2', ['u1']);
      const candidates = [s1, s2, merge, u1, u2];

      // Act
      const result = sut(candidates);

      // Assert — merge short-circuits in mergeWeights phase before fill/best
      expect(result?.nextCommit).toBe(merge.id);
      expect(result?.reaches).toBe(3);
      expect(result?.candidateCount).toBe(5);
    });
  });

  describe('Given all=7 with a merge at approxHalfway followed by a single-strand sc also at approxHalfway, When finding bisection', () => {
    it('Then mergeWeights early-return fires at the merge (reaches=3), not at the downstream sc (reaches=4)', () => {
      // Arrange — [s1, s2, merge(→s1,s2), sc(→merge), u1(→sc), u2(→u1), u3(→u2)]; all=7.
      // seedWeights:  s1=1, s2=1.
      // mergeWeights: countDistance(merge)={merge,s1,s2}=3; approxHalfway(3,7)=|6-7|=1 → FIRES.
      // Without early-return: fillWeights would assign sc.weight=4;
      //   approxHalfway(4,7)=|8-7|=1 would fire for sc instead → wrong nextCommit.
      const sut = findBisection;
      const s1 = c('s1', []);
      const s2 = c('s2', []);
      const merge = c('mg', ['s1', 's2']);
      const sc = c('sc', ['mg']);
      const u1 = c('u1', ['sc']);
      const u2 = c('u2', ['u1']);
      const u3 = c('u3', ['u2']);
      const candidates = [s1, s2, merge, sc, u1, u2, u3];

      // Act
      const result = sut(candidates);

      // Assert — merge is chosen by mergeWeights before fillWeights can fire at sc
      expect(result?.nextCommit).toBe(merge.id);
      expect(result?.reaches).toBe(3);
      expect(result?.candidateCount).toBe(7);
    });
  });

  // ─── strict-`>` tie-break isolation ─────────────────────────────────────────

  describe('Given two candidates with equal distance, first in list vs second, When finding bisection', () => {
    it('Then the FIRST candidate (earlier in list) wins — strict > keeps earlier', () => {
      // Arrange — a=seed, b=seed, all=2; both have dist=min(1,1)=1
      // strict `>` means the first one found wins; a comes before b in the list.
      const sut = findBisection;
      const a = c('aa', []);
      const b = c('bb', []);
      const candidates = [a, b]; // a is earlier

      // Act
      const result = sut(candidates);

      // Assert — a wins (first in list when tied)
      expect(result?.nextCommit).toBe(a.id);
      expect(result?.reaches).toBe(1);
    });
  });

  // ─── Fill convergence: deferred-parent path ───────────────────────────────

  describe('Given a reversed-order linear chain (children before parents), When finding bisection', () => {
    it(
      'Then fill defers the grandchild on the first pass and completes on the second, ' +
        'returning the middle commit via approx_halfway',
      () => {
        // Arrange — [child3, child2, child1] reversed: grandchild first, root last.
        // child1: no in-set parents → seeded (weight=1).
        // fill pass 1: child3 deferred (child2 not yet weighted, parent-weight undefined);
        //              child2 filled from seeded child1 → weight=2;
        //              approx_halfway(2,3)=|4-3|=1 fires → returned immediately.
        const sut = findBisection;
        const child1 = c('ch1', []);
        const child2 = c('ch2', ['ch1']);
        const child3 = c('ch3', ['ch2']);
        const candidates = [child3, child2, child1]; // reverse order

        // Act
        const result = sut(candidates);

        // Assert — child2 is the midpoint: weight=2, candidateCount=3
        expect(result?.nextCommit).toBe(child2.id);
        expect(result?.reaches).toBe(2);
        expect(result?.candidateCount).toBe(3);
      },
    );
  });

  // ─── best_bisection seed: skew-ordered head is a high-weight commit ───────────

  describe('Given a skew-ordered list whose head reaches most of the set (weight 5 of 6), When finding bisection', () => {
    it('Then best_bisection selects the true halving commit, seeding the head distance as min(w, all-w)', () => {
      // Arrange — committer-date skew places `head` (weight 5, NOT a root) first; its
      // in-set parents appear later in the oldest-first list. all=6.
      //   roots r1,r0 (w1); w2 (parent r1, w2); w4 (parents r0,w2 → w4);
      //   head (parents r1,w2,w4 → w5); bad (parents r1,w2,w4,head → w6).
      // No commit hits approx_halfway, so the result comes from best_bisection.
      //   distance min(w,6-w): head=1, r1=1, r0=1, w4=2, w2=2, bad=0 → w4 (first max) wins.
      // Seeding the head distance as min(5, 6+5)=5 would suppress w4 and wrongly keep head.
      const sut = findBisection;
      const r1 = c('r1', []);
      const r0 = c('r0', []);
      const w2 = c('w2', ['r1']);
      const w4 = c('w4', ['r0', 'w2']);
      const head = c('head', ['r1', 'w2', 'w4']);
      const bad = c('bad', ['r1', 'w2', 'w4', 'head']);
      const candidates = [head, r1, r0, w4, w2, bad];

      // Act
      const result = sut(candidates);

      // Assert — w4 is the true midpoint (weight 4, distance 2), not the high-weight head
      expect(result?.nextCommit).toBe(w4.id);
      expect(result?.reaches).toBe(4);
      expect(result?.candidateCount).toBe(6);
    });
  });

  // ─── Fill fixpoint: deferred midpoint completes on a LATER pass ───────────────

  describe('Given a skew-ordered list where a single-strand midpoint is deferred past its parent, When finding bisection', () => {
    it('Then the fixpoint fill assigns the deferred weight on a later pass and returns the exact midpoint', () => {
      // Arrange — committer-date skew places `mid` (single-strand, parent `lo`) at the head,
      // before `lo`. all=6. root (seed, w1); lo (parent root, w2); mid (parent lo, w3);
      // m1,m2 (merges, w4); bad (w6). No merge lands on approx_halfway.
      //   fill pass 1: `mid` deferred (lo still unweighted); `lo` filled from root → w2
      //                (diff=2*2-6=-2, not halfway).
      //   fill pass 2: `mid` filled → w3; diff=2*3-6=0 → approx_halfway fires → mid returned.
      // Collapsing the loop to a single pass leaves `mid` unweighted and loses its weight.
      const sut = findBisection;
      const root = c('root', []);
      const lo = c('lo', ['root']);
      const mid = c('mid', ['lo']);
      const m1 = c('m1', ['lo', 'mid']);
      const m2 = c('m2', ['root', 'lo', 'mid']);
      const bad = c('bad', ['root', 'mid', 'm2', 'm1']);
      const candidates = [mid, lo, root, m1, m2, bad];

      // Act
      const result = sut(candidates);

      // Assert — mid resolves on the second pass with its real weight of 3
      expect(result?.nextCommit).toBe(mid.id);
      expect(result?.reaches).toBe(3);
      expect(result?.candidateCount).toBe(6);
    });
  });
});
