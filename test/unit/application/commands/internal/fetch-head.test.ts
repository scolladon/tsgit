import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import {
  type FetchHeadEntry,
  fetchHeadEntries,
  fetchHeadUrl,
  formatFetchHead,
  readFetchHead,
} from '../../../../../src/application/commands/internal/fetch-head.js';
import type { MappedRef } from '../../../../../src/application/commands/internal/fetch-ref-map.js';
import { looseObjectPath } from '../../../../../src/application/primitives/path-layout.js';
import type { TsgitError } from '../../../../../src/domain/index.js';
import type { ObjectId } from '../../../../../src/domain/objects/index.js';
import { seedRepo } from '../fixtures.js';

const OID_A = 'a'.repeat(40) as ObjectId;
const OID_B = 'b'.repeat(40) as ObjectId;
const entry = (name: string, status: FetchHeadEntry['status'], id = OID_A): FetchHeadEntry => ({
  name,
  id,
  status,
});

describe('fetchHeadUrl', () => {
  describe.each([
    { url: '../peer.git/', expected: '../peer' },
    { url: '../peer.git', expected: '../peer' },
    { url: 'https://u:p@example.com/r.git//', expected: 'https://example.com/r' },
    { url: 'x.git', expected: 'x.git' },
    { url: 'ab.git', expected: 'ab' },
    { url: '/srv/repo', expected: '/srv/repo' },
  ])('Given the remote url $url', ({ url, expected }) => {
    describe('When it is shortened for FETCH_HEAD', () => {
      it(`Then it reads ${expected}`, () => {
        // Arrange
        const sut = fetchHeadUrl;

        // Act
        const result = sut(url);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });
});

describe('formatFetchHead', () => {
  describe('Given entries of every kind and status', () => {
    describe('When FETCH_HEAD is formatted', () => {
      it('Then merge lines lead, ignored entries vanish, and each line names its ref', () => {
        // Arrange
        const sut = formatFetchHead;
        const entries = [
          entry('refs/heads/b2', 'not-for-merge'),
          entry('refs/tags/v1', 'not-for-merge', OID_B),
          entry('refs/remotes/o/x', 'not-for-merge'),
          entry('refs/notes/n', 'not-for-merge'),
          entry('HEAD', 'merge', OID_B),
          entry('refs/heads/main', 'merge'),
          entry('refs/heads/main', 'ignore'),
        ];

        // Act
        const result = sut(entries, '../peer');

        // Assert
        expect(result).toBe(
          `${OID_B}\t\t../peer\n` +
            `${OID_A}\t\tbranch 'main' of ../peer\n` +
            `${OID_A}\tnot-for-merge\tbranch 'b2' of ../peer\n` +
            `${OID_B}\tnot-for-merge\ttag 'v1' of ../peer\n` +
            `${OID_A}\tnot-for-merge\tremote-tracking branch 'o/x' of ../peer\n` +
            `${OID_A}\tnot-for-merge\t'refs/notes/n' of ../peer\n`,
        );
      });
    });
  });

  describe('Given a url carrying a newline', () => {
    describe('When FETCH_HEAD is formatted', () => {
      it('Then the newline is escaped', () => {
        // Arrange
        const sut = formatFetchHead;

        // Act
        const result = sut([entry('HEAD', 'merge')], 'a\nb');

        // Assert
        expect(result).toBe(`${OID_A}\t\ta\\nb\n`);
      });
    });
  });
});

describe('readFetchHead', () => {
  describe('Given a FETCH_HEAD with merge and not-for-merge lines', () => {
    describe('When it is read', () => {
      it('Then each line yields its id, merge flag and description', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/FETCH_HEAD`,
          `${OID_A}\t\tbranch 'main' of ../peer\n${OID_B}\tnot-for-merge\ttag 'v1' of ../peer\n`,
        );
        const sut = readFetchHead;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result).toEqual([
          { id: OID_A, forMerge: true, description: "branch 'main' of ../peer" },
          { id: OID_B, forMerge: false, description: "tag 'v1' of ../peer" },
        ]);
      });
    });
  });

  describe('Given no FETCH_HEAD', () => {
    describe('When it is read', () => {
      it('Then it yields no line', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const sut = readFetchHead;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result).toEqual([]);
      });
    });
  });
});

describe('fetchHeadEntries', () => {
  const mapped = (id: ObjectId, status: MappedRef['status']): MappedRef => ({
    source: { name: 'refs/heads/main', id },
    target: undefined,
    status,
    force: false,
  });

  describe.each([
    { label: 'a commit for merging', status: 'merge', commit: true, expected: 'merge' },
    {
      label: 'an absent object for merging',
      status: 'merge',
      commit: false,
      expected: 'not-for-merge',
    },
    {
      label: 'an absent object not for merging',
      status: 'not-for-merge',
      commit: false,
      expected: 'not-for-merge',
    },
    { label: 'an ignored entry', status: 'ignore', commit: false, expected: 'ignore' },
  ] as const)('Given $label', ({ status, commit, expected }) => {
    describe('When its FETCH_HEAD entry is resolved', () => {
      it(`Then its status is ${expected}`, async () => {
        // Arrange
        const ctx = createMemoryContext();
        const { commitIds } = await seedRepo(ctx, { commits: [{ tree: 'e'.repeat(40) }] });
        const id = commit ? (commitIds[0] as ObjectId) : OID_B;
        const sut = fetchHeadEntries;

        // Act
        const result = await sut(ctx, [mapped(id, status)]);

        // Assert
        expect(result).toEqual([{ name: 'refs/heads/main', id, status: expected }]);
      });
    });
  });

  describe('Given a corrupt object for merging', () => {
    describe('When its FETCH_HEAD entry is resolved', () => {
      it('Then the read failure propagates', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedRepo(ctx, {});
        await ctx.fs.write(looseObjectPath(ctx.layout.gitDir, OID_A), new Uint8Array([1, 2, 3]));
        const sut = fetchHeadEntries;
        let caught: unknown;

        // Act
        try {
          await sut(ctx, [mapped(OID_A, 'merge')]);
        } catch (error) {
          caught = error;
        }

        // Assert
        expect((caught as TsgitError).data.code).toBe('DECOMPRESS_FAILED');
      });
    });
  });
});
