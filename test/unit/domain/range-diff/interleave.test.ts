import { describe, expect, it } from 'vitest';
import type { ObjectId } from '../../../../src/domain/objects/index.js';
import type { MatchedPatch } from '../../../../src/domain/range-diff/correspond.js';
import { interleave } from '../../../../src/domain/range-diff/interleave.js';

const oid = (char: string): ObjectId => char.repeat(40) as ObjectId;

const mp = (id: string, patchText: string, matching: number): MatchedPatch => ({
  patch: { id: oid(id), subject: `subject ${id}`, patch: patchText, diff: patchText, diffsize: 1 },
  matching,
});

const positions = (entry: { old?: { position: number }; new?: { position: number } }) => ({
  old: entry.old?.position,
  new: entry.new?.position,
});

describe('interleave', () => {
  describe('Given a deletion-only old series, When interleaved', () => {
    it('Then every entry is only-old in old order', () => {
      // Arrange
      const sut = interleave;
      const old = [mp('a', 'pa', -1), mp('b', 'pb', -1)];

      // Act
      const result = sut(old, []);

      // Assert
      expect(result.map((e) => e.status)).toEqual(['only-old', 'only-old']);
      expect(result.map(positions)).toEqual([
        { old: 1, new: undefined },
        { old: 2, new: undefined },
      ]);
    });
  });

  describe('Given a creation-only new series, When interleaved', () => {
    it('Then every entry is only-new in new order with the new subject', () => {
      // Arrange
      const sut = interleave;
      const next = [mp('x', 'px', -1), mp('y', 'py', -1)];

      // Act
      const result = sut([], next);

      // Assert
      expect(result.map((e) => e.status)).toEqual(['only-new', 'only-new']);
      expect(result[0]?.subject).toBe('subject x');
    });
  });

  describe('Given a reordered all-matched series, When interleaved', () => {
    it('Then entries are emitted in new order with crossed positions', () => {
      // Arrange — old [A,B,C] match new positions [0,2,1]
      const sut = interleave;
      const old = [mp('a', 'pa', 0), mp('b', 'pb', 2), mp('c', 'pc', 1)];
      const next = [mp('a', 'pa', 0), mp('c', 'pc', 2), mp('b', 'pb', 1)];

      // Act
      const result = sut(old, next);

      // Assert — new positions ascend 1,2,3; old positions cross
      expect(result.map(positions)).toEqual([
        { old: 1, new: 1 },
        { old: 3, new: 2 },
        { old: 2, new: 3 },
      ]);
      expect(result.every((e) => e.status === 'unchanged')).toBe(true);
    });
  });

  describe('Given matched pairs plus deletions and creations, When interleaved', () => {
    it('Then deletions interleave at old positions before trailing creations', () => {
      // Arrange — old [A,B,C,D], new [A,B2,C2,E]; only A matches A
      const sut = interleave;
      const old = [mp('a', 'pa', 0), mp('b', 'pb', -1), mp('c', 'pc', -1), mp('d', 'pd', -1)];
      const next = [mp('a', 'pa', 0), mp('b2', 'pb2', -1), mp('c2', 'pc2', -1), mp('e', 'pe', -1)];

      // Act
      const result = sut(old, next);

      // Assert
      expect(result.map((e) => e.status)).toEqual([
        'unchanged',
        'only-old',
        'only-old',
        'only-old',
        'only-new',
        'only-new',
        'only-new',
      ]);
    });
  });

  describe('Given a matched pair with identical full patches, When interleaved', () => {
    it('Then the status is unchanged with no diff-of-diffs', () => {
      // Arrange
      const sut = interleave;
      const old = [mp('a', ' ## Commit message ##\n    a\n ## f ##\n@@\n+x\n', 0)];
      const next = [mp('a', ' ## Commit message ##\n    a\n ## f ##\n@@\n+x\n', 0)];

      // Act
      const result = sut(old, next);

      // Assert
      expect(result[0]?.status).toBe('unchanged');
      expect(result[0]?.diffOfDiffs).toBeUndefined();
      expect(result[0]?.subject).toBe('subject a');
    });
  });

  describe('Given a matched pair whose full patches differ, When interleaved', () => {
    it('Then the status is changed and a diff-of-diffs is attached', () => {
      // Arrange — same diff, different message ⇒ paired but changed
      const sut = interleave;
      const old = [mp('a', ' ## Commit message ##\n    old\n ## f ##\n@@\n+x\n', 0)];
      const next = [mp('a', ' ## Commit message ##\n    new\n ## f ##\n@@\n+x\n', 0)];

      // Act
      const result = sut(old, next);

      // Assert
      expect(result[0]?.status).toBe('changed');
      expect(result[0]?.diffOfDiffs).toBeDefined();
      expect(result[0]?.diffOfDiffs?.hunks.length).toBeGreaterThan(0);
    });
  });
});
