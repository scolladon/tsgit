import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import { readObject } from '../../../../src/application/primitives/read-object.js';
import { walkTree } from '../../../../src/application/primitives/walk-tree.js';
import type { GitIndex, IndexEntry } from '../../../../src/domain/git-index/index.js';
import { STAGE0_FLAGS } from '../../../../src/domain/git-index/index.js';
import { indexPathKey } from '../../../../src/domain/git-index/index-path-key.js';
import { bytesToHex } from '../../../../src/domain/objects/encoding.js';
import { FILE_MODE } from '../../../../src/domain/objects/file-mode.js';
import type { AuthorIdentity } from '../../../../src/domain/objects/index.js';
import { arbIndexEntryWithPathBytes } from '../../domain/git-index/arbitraries.js';
import { serializeIndexFixtureAsync } from '../primitives/fixtures.js';

const PROPERTY_RUNS = 50;
const MAX_ENTRIES = 8;

const author: AuthorIdentity = {
  name: 'Prop Tester',
  email: 'prop@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

// A path that is both a file and a directory prefix of another cannot be committed.
const withoutFileDirectoryClashes = (entries: ReadonlyArray<IndexEntry>): IndexEntry[] => {
  const keys = new Set(entries.map(indexPathKey));
  const isDirectoryOfAnother = (key: string): boolean =>
    [...keys].some((other) => other.startsWith(`${key}/`));
  const seen = new Set<string>();
  return entries
    .filter((entry) => {
      const key = indexPathKey(entry);
      if (seen.has(key) || isDirectoryOfAnother(key)) return false;
      seen.add(key);
      return true;
    })
    .map((entry) => ({ ...entry, mode: FILE_MODE.REGULAR, flags: { ...STAGE0_FLAGS } }));
};

const indexEntryBytesHex = (entry: IndexEntry): string =>
  bytesToHex(entry.pathBytes ?? new TextEncoder().encode(entry.path));

describe('commit tree building', () => {
  describe('Given index entries sharing directories, whatever their path bytes', () => {
    describe('When commit', () => {
      it('Then the committed tree holds each index entry once, under its own bytes', async () => {
        // Arrange
        const arbEntries = fc
          .array(arbIndexEntryWithPathBytes(), { minLength: 1, maxLength: MAX_ENTRIES })
          .map(withoutFileDirectoryClashes);

        // Act + Assert
        await fc.assert(
          fc.asyncProperty(arbEntries, async (entries) => {
            const ctx = createMemoryContext();
            await init(ctx);
            const index: GitIndex = {
              version: 2,
              entries,
              extensions: [],
              trailerSha: new Uint8Array(0),
            };
            await ctx.fs.write(
              `${ctx.layout.gitDir}/index`,
              await serializeIndexFixtureAsync(index, ctx),
            );
            const sut = commit;

            const result = await sut(ctx, { message: 'prop', author });

            const head = await readObject(ctx, result.id);
            if (head.type !== 'commit') throw new Error('expected a commit');
            const paths: string[] = [];
            for await (const entry of walkTree(ctx, head.data.tree, {
              recursive: true,
              pathBytes: true,
            })) {
              if (entry.mode !== FILE_MODE.DIRECTORY) {
                paths.push(bytesToHex(entry.pathBytes as Uint8Array));
              }
            }
            expect(new Set(paths).size).toBe(paths.length);
            expect(new Set(paths)).toEqual(new Set(entries.map(indexEntryBytesHex)));
          }),
          { numRuns: PROPERTY_RUNS },
        );
      });
    });
  });
});
