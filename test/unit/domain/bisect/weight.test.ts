import { describe, expect, it } from 'vitest';
import type { BisectCandidate } from '../../../../src/domain/bisect/types.js';
import { countDistance } from '../../../../src/domain/bisect/weight.js';
import type { ObjectId } from '../../../../src/domain/objects/index.js';

const oid = (s: string): ObjectId => s.padStart(40, '0') as ObjectId;

const makeCandidate = (id: string, parents: ReadonlyArray<string>): BisectCandidate => ({
  id: oid(id),
  parents: parents.map(oid),
  date: 0,
});

describe('countDistance', () => {
  describe('Given a single commit with no in-set parents, When counting distance', () => {
    it('Then the weight is 1 (only itself)', () => {
      // Arrange
      const sut = countDistance;
      const root = makeCandidate('r', []);
      const byId = new Map([[root.id, root]]);

      // Act
      const result = sut(root.id, byId);

      // Assert
      expect(result).toBe(1);
    });
  });

  describe('Given a linear chain of 5 commits, When counting distance from each', () => {
    it('Then weights are 1, 2, 3, 4, 5 from oldest to newest', () => {
      // Arrange
      const sut = countDistance;
      const c0 = makeCandidate('c0', []);
      const c1 = makeCandidate('c1', ['c0']);
      const c2 = makeCandidate('c2', ['c1']);
      const c3 = makeCandidate('c3', ['c2']);
      const c4 = makeCandidate('c4', ['c3']);
      const candidates = [c0, c1, c2, c3, c4];
      const byId = new Map(candidates.map((c) => [c.id, c]));

      // Act + Assert
      expect(sut(oid('c0'), byId)).toBe(1);
      expect(sut(oid('c1'), byId)).toBe(2);
      expect(sut(oid('c2'), byId)).toBe(3);
      expect(sut(oid('c3'), byId)).toBe(4);
      expect(sut(oid('c4'), byId)).toBe(5);
    });
  });

  describe('Given a diamond merge where M has parents A2 and B2 each with depth 2, When counting distance from M', () => {
    it('Then weight is 5 (M + A2 + A1 + B2 + B1, union — not a sum)', () => {
      // Arrange
      const sut = countDistance;
      const a1 = makeCandidate('a1', []);
      const b1 = makeCandidate('b1', []);
      const a2 = makeCandidate('a2', ['a1']);
      const b2 = makeCandidate('b2', ['b1']);
      // M has two in-set parents: A2 and B2
      const m = makeCandidate('m', ['a2', 'b2']);
      const candidates = [a1, b1, a2, b2, m];
      const byId = new Map(candidates.map((c) => [c.id, c]));

      // Act
      const result = sut(m.id, byId);

      // Assert — union of {M,A2,A1} and {M,B2,B1} = {M,A2,A1,B2,B1} = 5
      expect(result).toBe(5);
    });
  });

  describe('Given a merge commit that shares an ancestor (diamond base) with both parents, When counting distance from merge', () => {
    it('Then shared ancestor is counted once (union, not sum)', () => {
      // Arrange — topology: base → a → merge, base → b → merge
      // base is an in-set ancestor of both a and b; shared by all paths from merge.
      const sut = countDistance;
      const base = makeCandidate('base', []);
      const a = makeCandidate('a', ['base']);
      const b = makeCandidate('b', ['base']);
      const merge = makeCandidate('merge', ['a', 'b']);
      const candidates = [base, a, b, merge];
      const byId = new Map(candidates.map((c) => [c.id, c]));

      // Act
      const result = sut(merge.id, byId);

      // Assert — union of {merge,a,base} and {merge,b,base} = {merge,a,b,base} = 4
      expect(result).toBe(4);
    });
  });

  describe('Given an octopus merge with 3 in-set parents each with 1 ancestor, When counting distance from the octopus', () => {
    it('Then weight is 7 (octopus + 3 parents + 3 grandparents, union)', () => {
      // Arrange
      const sut = countDistance;
      const g1 = makeCandidate('g1', []);
      const g2 = makeCandidate('g2', []);
      const g3 = makeCandidate('g3', []);
      const p1 = makeCandidate('p1', ['g1']);
      const p2 = makeCandidate('p2', ['g2']);
      const p3 = makeCandidate('p3', ['g3']);
      // octopus merge with 3 parents
      const oct = makeCandidate('oct', ['p1', 'p2', 'p3']);
      const candidates = [g1, g2, g3, p1, p2, p3, oct];
      const byId = new Map(candidates.map((c) => [c.id, c]));

      // Act
      const result = sut(oct.id, byId);

      // Assert — oct + p1+g1 + p2+g2 + p3+g3 = 7
      expect(result).toBe(7);
    });
  });
});
