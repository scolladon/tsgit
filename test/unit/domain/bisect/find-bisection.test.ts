import { describe, expect, it } from 'vitest';
import type { BisectCandidate } from '../../../../src/domain/bisect/bisect.js';
import { findBisection } from '../../../../src/domain/bisect/bisect.js';
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

  describe('Given linear chain c0…c9 bad=c9 good=c0 (all=9), When finding bisection', () => {
    it('Then midpoint is c4 with reaches=4', () => {
      // Arrange
      const sut = findBisection;
      const candidates = linearChain(1, 9);

      // Act
      const result = sut(candidates);

      // Assert
      expect(result?.nextCommit).toBe(oid('c4'));
      expect(result?.reaches).toBe(4);
      expect(result?.candidateCount).toBe(9);
    });
  });

  describe('Given linear chain c0…c9 bad=c9 good=c1 (all=8), When finding bisection', () => {
    it('Then midpoint is c5 with reaches=4', () => {
      // Arrange
      const sut = findBisection;
      const candidates = linearChain(2, 9);

      // Act
      const result = sut(candidates);

      // Assert
      expect(result?.nextCommit).toBe(oid('c5'));
      expect(result?.reaches).toBe(4);
      expect(result?.candidateCount).toBe(8);
    });
  });

  describe('Given linear chain c0…c9 bad=c9 good=c2 (all=7), When finding bisection', () => {
    it('Then midpoint is c5 with reaches=3', () => {
      // Arrange
      const sut = findBisection;
      const candidates = linearChain(3, 9);

      // Act
      const result = sut(candidates);

      // Assert
      expect(result?.nextCommit).toBe(oid('c5'));
      expect(result?.reaches).toBe(3);
      expect(result?.candidateCount).toBe(7);
    });
  });

  describe('Given linear chain c0…c9 bad=c9 good=c3 (all=6), When finding bisection', () => {
    it('Then midpoint is c6 with reaches=3', () => {
      // Arrange
      const sut = findBisection;
      const candidates = linearChain(4, 9);

      // Act
      const result = sut(candidates);

      // Assert
      expect(result?.nextCommit).toBe(oid('c6'));
      expect(result?.reaches).toBe(3);
      expect(result?.candidateCount).toBe(6);
    });
  });

  describe('Given linear chain c0…c9 bad=c9 good=c4 (all=5), When finding bisection', () => {
    it('Then midpoint is c6 with reaches=2', () => {
      // Arrange
      const sut = findBisection;
      const candidates = linearChain(5, 9);

      // Act
      const result = sut(candidates);

      // Assert
      expect(result?.nextCommit).toBe(oid('c6'));
      expect(result?.reaches).toBe(2);
      expect(result?.candidateCount).toBe(5);
    });
  });

  describe('Given linear chain c0…c9 bad=c9 good=c5 (all=4), When finding bisection', () => {
    it('Then midpoint is c7 with reaches=2', () => {
      // Arrange
      const sut = findBisection;
      const candidates = linearChain(6, 9);

      // Act
      const result = sut(candidates);

      // Assert
      expect(result?.nextCommit).toBe(oid('c7'));
      expect(result?.reaches).toBe(2);
      expect(result?.candidateCount).toBe(4);
    });
  });

  describe('Given linear chain c0…c9 bad=c9 good=c6 (all=3), When finding bisection', () => {
    it('Then midpoint is c8 with reaches=2', () => {
      // Arrange
      const sut = findBisection;
      const candidates = linearChain(7, 9);

      // Act
      const result = sut(candidates);

      // Assert
      expect(result?.nextCommit).toBe(oid('c8'));
      expect(result?.reaches).toBe(2);
      expect(result?.candidateCount).toBe(3);
    });
  });

  describe('Given linear chain c0…c9 bad=c9 good=c7 (all=2), When finding bisection', () => {
    it('Then midpoint is c8 with reaches=1', () => {
      // Arrange
      const sut = findBisection;
      const candidates = linearChain(8, 9);

      // Act
      const result = sut(candidates);

      // Assert
      expect(result?.nextCommit).toBe(oid('c8'));
      expect(result?.reaches).toBe(1);
      expect(result?.candidateCount).toBe(2);
    });
  });

  describe('Given linear chain c0…c9 bad=c9 good=c8 (all=1), When finding bisection', () => {
    it('Then midpoint is c9 with reaches=1', () => {
      // Arrange
      const sut = findBisection;
      const candidates = linearChain(9, 9);

      // Act
      const result = sut(candidates);

      // Assert
      expect(result?.nextCommit).toBe(oid('c9'));
      expect(result?.reaches).toBe(1);
      expect(result?.candidateCount).toBe(1);
    });
  });

  // ─── approx_halfway boundary isolation ───────────────────────────────────────
  // diff = 2*weight - all; halfway ⟺ diff ∈ {-1, 0, 1}

  describe('Given all=9, a commit with weight=4 (diff=-1), When finding bisection', () => {
    it('Then it fires approx_halfway and returns that commit (diff=-1 boundary)', () => {
      // Arrange — linear chain [c1..c9], c4 has weight=4 (diff=2*4-9=-1)
      const sut = findBisection;
      const candidates = linearChain(1, 9);

      // Act
      const result = sut(candidates);

      // Assert
      expect(result?.nextCommit).toBe(oid('c4'));
      expect(result?.reaches).toBe(4);
    });
  });

  describe('Given all=6, a commit with weight=3 (diff=0), When finding bisection', () => {
    it('Then it fires approx_halfway and returns that commit (diff=0 boundary)', () => {
      // Arrange — linear chain [c4..c9] (all=6), c6 has weight=3 (diff=2*3-6=0)
      const sut = findBisection;
      const candidates = linearChain(4, 9);

      // Act
      const result = sut(candidates);

      // Assert
      expect(result?.nextCommit).toBe(oid('c6'));
      expect(result?.reaches).toBe(3);
    });
  });

  describe('Given all=3, a commit with weight=2 (diff=1), When finding bisection', () => {
    it('Then it fires approx_halfway and returns that commit (diff=1 boundary)', () => {
      // Arrange — linear chain [c7..c9] (all=3), c8 has weight=2 (diff=2*2-3=1)
      const sut = findBisection;
      const candidates = linearChain(7, 9);

      // Act
      const result = sut(candidates);

      // Assert
      expect(result?.nextCommit).toBe(oid('c8'));
      expect(result?.reaches).toBe(2);
    });
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
});
