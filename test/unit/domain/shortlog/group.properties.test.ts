import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { compareBytes } from '../../../../src/domain/objects/index.js';
import { groupShortlog, type ShortlogEntry } from '../../../../src/domain/shortlog/group.js';
import { arbShortlogEntries } from './arbitraries.js';

const RUNS = 100;
const enc = new TextEncoder();
const key = (c: { id: string; email: string; subject: string }): string =>
  `${c.id} ${c.email} ${c.subject}`;

describe('groupShortlog properties', () => {
  describe('Given no entries, When grouped', () => {
    it('Then it returns no groups', () => {
      // Arrange / Act / Assert
      expect(groupShortlog([])).toEqual([]);
    });
  });

  describe('Given arbitrary entries, When grouped', () => {
    it('Then total commit count is preserved', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(arbShortlogEntries(), (entries) => {
          const total = groupShortlog(entries).reduce((n, g) => n + g.commits.length, 0);
          expect(total).toBe(entries.length);
        }),
        { numRuns: RUNS },
      );
    });

    it('Then group count equals the number of distinct names and no group is empty', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(arbShortlogEntries(), (entries) => {
          const distinct = new Set(entries.map((e) => e.name)).size;
          const result = groupShortlog(entries);
          expect(result).toHaveLength(distinct);
          for (const group of result) expect(group.commits.length).toBeGreaterThan(0);
        }),
        { numRuns: RUNS },
      );
    });

    it('Then groups are byte-sorted ascending by name', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(arbShortlogEntries(), (entries) => {
          const names = groupShortlog(entries).map((g) => g.name);
          for (let i = 1; i < names.length; i += 1) {
            expect(compareBytes(enc.encode(names[i - 1]!), enc.encode(names[i]!))).toBeLessThan(0);
          }
        }),
        { numRuns: RUNS },
      );
    });

    it("Then each group's commits are the reverse of that name's input order (oldest first)", () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(arbShortlogEntries(), (entries) => {
          const result = groupShortlog(entries);
          for (const group of result) {
            const inputForName = entries.filter((e: ShortlogEntry) => e.name === group.name);
            const expected = [...inputForName].reverse().map(key);
            expect(group.commits.map(key)).toEqual(expected);
          }
        }),
        { numRuns: RUNS },
      );
    });
  });
});
