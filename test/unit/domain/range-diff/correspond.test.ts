import { describe, expect, it } from 'vitest';
import type { ObjectId } from '../../../../src/domain/objects/index.js';
import { correspond } from '../../../../src/domain/range-diff/correspond.js';
import type { RenderedPatch } from '../../../../src/domain/range-diff/patch-text.js';

const oid = (char: string): ObjectId => char.repeat(40) as ObjectId;

const patch = (id: string, diff: string, diffsize: number): RenderedPatch => ({
  id: oid(id),
  subject: id,
  patch: ` ## Commit message ##\n    ${id}\n${diff}`,
  diff,
  diffsize,
});

const big = (label: string, changedLine: string): string => {
  const lines = [`## ${label} ##`];
  for (let n = 1; n <= 30; n++) lines.push(n === 15 ? changedLine : `+line ${n}`);
  return `${lines.join('\n')}\n`;
};

describe('correspond', () => {
  describe('Given byte-identical diffs of any size, When corresponded', () => {
    it('Then they exact-match regardless of size', () => {
      // Arrange
      const sut = correspond;
      const old = [patch('a', ' ## f ##\n@@\n+x\n', 1)];
      const next = [patch('b', ' ## f ##\n@@\n+x\n', 1)];

      // Act
      const result = sut(old, next, 60);

      // Assert
      expect(result.old[0]?.matching).toBe(0);
      expect(result.new[0]?.matching).toBe(0);
    });
  });

  describe('Given two large near-identical patches, When corresponded', () => {
    it('Then they are fuzzy-matched (diff-of-diffs cheaper than create+delete)', () => {
      // Arrange
      const sut = correspond;
      const old = [patch('a', big('f', '+line 15'), 31)];
      const next = [patch('b', big('f', '+line 15 changed'), 31)];

      // Act
      const result = sut(old, next, 60);

      // Assert
      expect(result.old[0]?.matching).toBe(0);
      expect(result.new[0]?.matching).toBe(0);
    });
  });

  describe('Given two small near-identical patches, When corresponded', () => {
    it('Then the integer creation cost wins and they are not matched', () => {
      // Arrange — diffsize 1 ⇒ creation cost trunc(1*60/100) = 0 < the diff-of-diffs cost
      const sut = correspond;
      const old = [patch('a', ' ## f ##\n@@\n+aaa\n', 1)];
      const next = [patch('b', ' ## f ##\n@@\n+bbb\n', 1)];

      // Act
      const result = sut(old, next, 60);

      // Assert
      expect(result.old[0]?.matching).toBe(-1);
      expect(result.new[0]?.matching).toBe(-1);
    });
  });

  describe('Given a reordered series of exact patches, When corresponded', () => {
    it('Then each patch matches its partner across the reorder', () => {
      // Arrange — old [A,B,C], new [A,C,B]
      const sut = correspond;
      const a = ' ## a ##\n@@\n+aaa\n';
      const b = ' ## b ##\n@@\n+bbb\n';
      const c = ' ## c ##\n@@\n+ccc\n';
      const old = [patch('a', a, 1), patch('b', b, 1), patch('c', c, 1)];
      const next = [patch('a', a, 1), patch('c', c, 1), patch('b', b, 1)];

      // Act
      const result = sut(old, next, 60);

      // Assert — old positions 0,1,2 map to new positions 0,2,1
      expect(result.old.map((entry) => entry.matching)).toEqual([0, 2, 1]);
      expect(result.new.map((entry) => entry.matching)).toEqual([0, 2, 1]);
    });
  });

  describe('Given duplicate identical diffs on the old side, When corresponded', () => {
    it('Then the highest-indexed duplicate is matched first (git hashmap LIFO)', () => {
      // Arrange
      const sut = correspond;
      const dup = ' ## f ##\n@@\n+dup\n';
      const old = [patch('a', dup, 1), patch('b', dup, 1)];
      const next = [patch('c', dup, 1)];

      // Act
      const result = sut(old, next, 60);

      // Assert — old[1] (the later add) matches new[0]; old[0] is a deletion
      expect(result.old[0]?.matching).toBe(-1);
      expect(result.old[1]?.matching).toBe(0);
      expect(result.new[0]?.matching).toBe(1);
    });
  });

  describe('Given a zero creation factor, When corresponded', () => {
    it('Then non-identical patches never match', () => {
      // Arrange
      const sut = correspond;
      const old = [patch('a', big('f', '+line 15'), 31)];
      const next = [patch('b', big('f', '+line 15 changed'), 31)];

      // Act
      const result = sut(old, next, 0);

      // Assert
      expect(result.old[0]?.matching).toBe(-1);
      expect(result.new[0]?.matching).toBe(-1);
    });
  });
});
