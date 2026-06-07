import { describe, expect, it } from 'vitest';
import type { ObjectId } from '../../../../src/domain/objects/index.js';
import { groupShortlog, type ShortlogEntry } from '../../../../src/domain/shortlog/group.js';

const oid = (char: string): ObjectId => char.repeat(40) as ObjectId;

const entry = (name: string, email: string, id: string, subject: string): ShortlogEntry => ({
  name,
  email,
  id: oid(id),
  subject,
});

describe('groupShortlog', () => {
  describe('Given no entries, When grouped', () => {
    it('Then it returns no groups', () => {
      // Arrange
      const sut = groupShortlog;

      // Act
      const result = sut([]);

      // Assert
      expect(result).toEqual([]);
    });
  });

  describe('Given one author with commits in walk order (newest first), When grouped', () => {
    it('Then the commits are reversed to oldest first', () => {
      // Arrange
      const sut = groupShortlog;
      const entries = [
        entry('Ann', 'ann@x', 'c', 'newest'),
        entry('Ann', 'ann@x', 'b', 'middle'),
        entry('Ann', 'ann@x', 'a', 'oldest'),
      ];

      // Act
      const result = sut(entries);

      // Assert
      expect(result).toEqual([
        {
          name: 'Ann',
          commits: [
            { id: oid('a'), email: 'ann@x', subject: 'oldest' },
            { id: oid('b'), email: 'ann@x', subject: 'middle' },
            { id: oid('c'), email: 'ann@x', subject: 'newest' },
          ],
        },
      ]);
    });
  });

  describe('Given two authors interleaved, When grouped', () => {
    it('Then groups are byte-sorted ascending by name', () => {
      // Arrange
      const sut = groupShortlog;
      const entries = [
        entry('Bob', 'bob@x', 'd', 'b2'),
        entry('Ann', 'ann@x', 'c', 'a2'),
        entry('Bob', 'bob@x', 'b', 'b1'),
        entry('Ann', 'ann@x', 'a', 'a1'),
      ];

      // Act
      const result = sut(entries);

      // Assert
      expect(result.map((g) => g.name)).toEqual(['Ann', 'Bob']);
    });
  });

  describe('Given one name with two different emails, When grouped', () => {
    it('Then they form one group, each commit keeping its own email', () => {
      // Arrange
      const sut = groupShortlog;
      const entries = [entry('Ann', 'ann@second', 'b', 's2'), entry('Ann', 'ann@first', 'a', 's1')];

      // Act
      const result = sut(entries);

      // Assert
      expect(result).toHaveLength(1);
      expect(result[0]?.commits).toEqual([
        { id: oid('a'), email: 'ann@first', subject: 's1' },
        { id: oid('b'), email: 'ann@second', subject: 's2' },
      ]);
    });
  });

  describe('Given two names differing only in case, When grouped', () => {
    it('Then they are distinct groups ordered byte-wise (upper before lower)', () => {
      // Arrange
      const sut = groupShortlog;
      const entries = [entry('ann', 'l@x', 'b', 'lower'), entry('Ann', 'u@x', 'a', 'upper')];

      // Act
      const result = sut(entries);

      // Assert
      expect(result.map((g) => g.name)).toEqual(['Ann', 'ann']);
    });
  });

  describe('Given names that sort differently by UTF-8 bytes than by UTF-16 units, When grouped', () => {
    it('Then they are ordered by UTF-8 bytes (git strcmp), not JS default sort', () => {
      // Arrange — '＀' encodes as EF BC 80; '\u{10000}' as F0 90 80 80, so
      // the former sorts first by bytes; JS default (UTF-16 code units) reverses
      // them because the surrogate lead 0xD800 < 0xFF00.
      const sut = groupShortlog;
      const entries = [entry('\u{10000}z', 'a@x', 'b', 's2'), entry('＀z', 'b@x', 'a', 's1')];

      // Act
      const result = sut(entries);

      // Assert
      expect(result.map((g) => g.name)).toEqual(['＀z', '\u{10000}z']);
    });
  });
});
