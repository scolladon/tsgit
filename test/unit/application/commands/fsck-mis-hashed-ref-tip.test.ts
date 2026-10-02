/**
 * A ref tip whose served copy hashes to another commit: git's
 * `snapshot_ref` cannot `parse_object` it, so the ref and HEAD are invalid
 * pointers, nothing counts as a default reference, and the reflog entries
 * naming it point at an object fsck never recorded.
 */
import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { type FsckFinding, fsck } from '../../../../src/application/commands/fsck.js';
import { looseObjectPath } from '../../../../src/application/primitives/path-layout.js';
import { refreshPackRegistry } from '../../../../src/application/primitives/read-object.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { serializeCommitContent } from '../../../../src/domain/objects/commit.js';
import type { Commit, ObjectId } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';
import { writeSyntheticPack } from '../primitives/pack-fixture.js';

const AUTHOR = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};
const ZERO = '0'.repeat(40);

type Storage = 'loose' | 'packed';

interface MisHashedTip {
  readonly ctx: Context;
  /** The tip `main` names, served under the first commit's bytes. */
  readonly tip: ObjectId;
  /** The tip's parent, whose bytes the tip's copy holds. */
  readonly parent: ObjectId;
}

const commitOver = (tree: ObjectId, parents: ReadonlyArray<ObjectId>, message: string): Commit => ({
  type: 'commit',
  id: '' as ObjectId,
  data: { tree, parents, author: AUTHOR, committer: AUTHOR, message, extraHeaders: [] },
});

const reflogLine = (from: string, to: ObjectId): string =>
  `${from} ${to} Ada <ada@example.com> 1700000000 +0000\tcommit\n`;

/** `main` at c2 over c1, each reflog recording both; c2's copy holds c1's bytes. */
const repoWithMisHashedTip = async (storage: Storage): Promise<MisHashedTip> => {
  const ctx = createMemoryContext();
  const tree = await writeObject(ctx, { type: 'tree', id: '' as ObjectId, entries: [] });
  const first = commitOver(tree, [], 'c1');
  const c1 = await writeObject(ctx, first);
  const tip = await writeObject(ctx, commitOver(tree, [c1], 'c2'));
  const gitDir = ctx.layout.gitDir;
  await ctx.fs.writeUtf8(`${gitDir}/HEAD`, 'ref: refs/heads/main\n');
  await ctx.fs.writeUtf8(`${gitDir}/refs/heads/main`, `${tip}\n`);
  const log = reflogLine(ZERO, c1) + reflogLine(c1, tip);
  await ctx.fs.writeUtf8(`${gitDir}/logs/HEAD`, log);
  await ctx.fs.writeUtf8(`${gitDir}/logs/refs/heads/main`, log);
  await ctx.fs.rm(looseObjectPath(gitDir, tip));
  if (storage === 'loose') {
    await ctx.fs.write(
      looseObjectPath(gitDir, tip),
      await ctx.fs.read(looseObjectPath(gitDir, c1)),
    );
  } else {
    await writeSyntheticPack(ctx, 'mis', [
      { kind: 'base', type: 'commit', content: serializeCommitContent(first), idOverride: tip },
    ]);
    refreshPackRegistry(ctx);
  }
  return { ctx, tip, parent: c1 };
};

const badRefs = (findings: ReadonlyArray<FsckFinding>) =>
  findings.flatMap((finding) =>
    finding.type === 'bad-ref' ? [{ ref: finding.ref, target: finding.target }] : [],
  );

const MODES = [
  ['full', {}],
  ['no-full', { full: false }],
  ['connectivity-only', { connectivityOnly: true }],
] as const;

describe.each(['loose', 'packed'] as const)(
  'Given a ref tip whose %s copy hashes to another commit',
  (storage) => {
    describe.each(MODES)('When fsck runs %s', (_mode, opts) => {
      it('Then main and HEAD are invalid pointers to it', async () => {
        // Arrange
        const { ctx, tip } = await repoWithMisHashedTip(storage);
        const sut = fsck;

        // Act
        const result = await sut(ctx, opts);

        // Assert
        expect(badRefs(result.findings)).toEqual([
          { ref: 'refs/heads/main', target: tip },
          { ref: 'HEAD', target: tip },
        ]);
      });
    });
  },
);

const invalidReflogEntries = (findings: ReadonlyArray<FsckFinding>) =>
  findings.flatMap((finding) =>
    finding.type === 'invalid-reflog-entry' ? [{ ref: finding.ref, id: finding.id }] : [],
  );

describe.each(['loose', 'packed'] as const)(
  'Given a ref tip whose %s copy hashes to another commit',
  (storage) => {
    describe.each(MODES.slice(0, 2))('When fsck runs %s over its reflogs', (_mode, opts) => {
      it('Then each reflog names it as an object fsck never recorded', async () => {
        // Arrange
        const { ctx, tip } = await repoWithMisHashedTip(storage);
        const sut = fsck;

        // Act
        const result = await sut(ctx, opts);

        // Assert
        expect(invalidReflogEntries(result.findings)).toEqual([
          { ref: 'HEAD', id: tip },
          { ref: 'refs/heads/main', id: tip },
        ]);
      });
    });

    describe('When fsck runs connectivity-only over its reflogs', () => {
      it('Then no reflog entry is invalid, as every enumerated object is recorded', async () => {
        // Arrange
        const { ctx } = await repoWithMisHashedTip(storage);
        const sut = fsck;

        // Act
        const result = await sut(ctx, { connectivityOnly: true });

        // Assert
        expect(invalidReflogEntries(result.findings)).toEqual([]);
      });
    });
  },
);

const noDefaultReferences = (findings: ReadonlyArray<FsckFinding>) =>
  findings.filter((finding) => finding.type === 'no-default-references');

describe.each(['loose', 'packed'] as const)(
  'Given a ref tip whose %s copy hashes to another commit',
  (storage) => {
    describe.each(MODES)('When fsck runs %s', (_mode, opts) => {
      it('Then it notes that no ref counts as a default reference', async () => {
        // Arrange
        const { ctx } = await repoWithMisHashedTip(storage);
        const sut = fsck;

        // Act
        const result = await sut(ctx, opts);

        // Assert
        expect(noDefaultReferences(result.findings)).toEqual([{ type: 'no-default-references' }]);
      });
    });
  },
);

describe('Given a ref tip whose copy hashes to it', () => {
  describe('When fsck runs', () => {
    it('Then no notice about default references is raised', async () => {
      // Arrange
      const { ctx, parent } = await repoWithMisHashedTip('loose');
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${parent}\n`);
      const sut = fsck;

      // Act
      const result = await sut(ctx);

      // Assert
      expect(noDefaultReferences(result.findings)).toEqual([]);
    });
  });
});

const findingsAbout = (findings: ReadonlyArray<FsckFinding>, id: ObjectId) =>
  findings.filter((finding) => 'id' in finding && finding.id === id);

describe.each(['loose', 'packed'] as const)(
  'Given a ref tip whose %s copy hashes to another commit',
  (storage) => {
    describe('When fsck runs connectivity-only and its reflogs reach it', () => {
      it('Then the walk cannot type it, and it is reached but neither a root nor walked', async () => {
        // Arrange
        const { ctx, tip } = await repoWithMisHashedTip(storage);
        const sut = fsck;

        // Act
        const result = await sut(ctx, { connectivityOnly: true });

        // Assert
        expect(findingsAbout(result.findings, tip)).toEqual([
          { type: 'unknown-object-type', id: tip },
        ]);
      });
    });

    describe('When fsck runs connectivity-only without reflog roots', () => {
      it('Then nothing reaches it to type', async () => {
        // Arrange
        const { ctx, tip } = await repoWithMisHashedTip(storage);
        const sut = fsck;

        // Act
        const result = await sut(ctx, { connectivityOnly: true, reflogRoots: false });

        // Assert
        expect(findingsAbout(result.findings, tip).map((finding) => finding.type)).not.toContain(
          'unknown-object-type',
        );
      });
    });
  },
);

describe.each([
  ['loose', 'full', {}, 3],
  ['loose', 'no-full', { full: false }, 3],
  ['loose', 'connectivity-only', { connectivityOnly: true }, 2],
  ['packed', 'full', {}, 6],
  ['packed', 'no-full', { full: false }, 2],
  ['packed', 'connectivity-only', { connectivityOnly: true }, 2],
] as const)(
  'Given a ref tip whose %s copy hashes to another commit',
  (storage, mode, opts, exitCode) => {
    describe(`When fsck runs ${mode}`, () => {
      it(`Then it exits ${exitCode}, as git does`, async () => {
        // Arrange
        const { ctx } = await repoWithMisHashedTip(storage);
        const sut = fsck;

        // Act
        const result = await sut(ctx, opts);

        // Assert
        expect(result.exitCode).toBe(exitCode);
      });
    });
  },
);
