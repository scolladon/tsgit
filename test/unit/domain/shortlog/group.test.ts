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

  describe('Given entries whose author names need byte-wise sorting, When grouped', () => {
    it.each([
      {
        entries: [
          entry('Bob', 'bob@x', 'd', 'b2'),
          entry('Ann', 'ann@x', 'c', 'a2'),
          entry('Bob', 'bob@x', 'b', 'b1'),
          entry('Ann', 'ann@x', 'a', 'a1'),
        ],
        expectedNames: ['Ann', 'Bob'],
        label: 'two authors interleaved are byte-sorted ascending by name',
      },
      {
        entries: [entry('ann', 'l@x', 'b', 'lower'), entry('Ann', 'u@x', 'a', 'upper')],
        expectedNames: ['Ann', 'ann'],
        label:
          'two names differing only in case are distinct groups ordered byte-wise (upper before lower)',
      },
      {
        // '＀' encodes as EF BC 80; '\u{10000}' as F0 90 80 80, so the former
        // sorts first by bytes; JS default (UTF-16 code units) reverses them
        // because the surrogate lead 0xD800 < 0xFF00.
        entries: [entry('\u{10000}z', 'a@x', 'b', 's2'), entry('＀z', 'b@x', 'a', 's1')],
        expectedNames: ['＀z', '\u{10000}z'],
        label:
          'names sorting differently by UTF-8 bytes than UTF-16 units are ordered by UTF-8 bytes (git strcmp), not JS default sort',
      },
    ])('Then $label', ({ entries, expectedNames }) => {
      // Arrange
      const sut = groupShortlog;

      // Act
      const result = sut(entries);

      // Assert
      expect(result.map((g) => g.name)).toEqual(expectedNames);
    });
  });
});
