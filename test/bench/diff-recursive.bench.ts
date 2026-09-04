/**
 * Tiered bench: `repo.diff({ recursive: true })` — the recursive/megarepo
 * tree-diff hot loop, tsgit-only (no isomorphic-git recursive-diff analog in
 * the suite). Three shapes at each fixture tier (small, medium — plus large
 * under `TSGIT_BENCH_LARGE`):
 *  - narrow: `HEAD~1..HEAD`, one commit's worth of added blobs.
 *  - wide add-expansion: the empty tree against `HEAD` — every entry differs,
 *    so the merge-join must walk (and fully expand) the whole fixture tree
 *    rather than pruning most of it via TREESAME.
 *  - wide merge-join-descent: `HEAD` against a synthetic sibling tree that
 *    keeps every shard directory's shape but rewrites exactly one blob per
 *    directory — the merge-join descends and compares every directory pair
 *    instead of expanding an added subtree.
 */
import type { ObjectId } from '../../src/domain/objects/index.js';
import { EMPTY_TREE_OID, isDirectory } from '../../src/domain/objects/index.js';
import type { Repository } from '../../src/index.node.js';
import { openRepository } from '../../src/index.node.js';
import type { ScaledFixture } from './support/fixture-generator.js';
import { MULTI_TIERS, tieredScenario } from './support/tiered-bench.js';

/** Flips the first byte — guarantees a different, same-length blob. */
const mutateBlobContent = (content: Uint8Array): Uint8Array => {
  const mutated = Uint8Array.from(content);
  mutated[0] = (mutated[0] ?? 0) ^ 0xff;
  return mutated;
};

/**
 * Derives a synthetic tree from `fixture`'s HEAD: every shard directory keeps
 * its entries, except its first blob is rewritten to different content —
 * shape-stable, content-different, one leaf per directory. Deterministic per
 * fixture, so the write is an object-store no-op (existing oid) on every
 * later run — this never grows the shared, cached fixture.
 */
const buildWideModifyTreeId = async (
  repo: Repository,
  fixture: ScaledFixture,
): Promise<ObjectId> => {
  const rootTree = await repo.primitives.readTree(fixture.headCommitId as ObjectId);
  const newEntries = await Promise.all(
    rootTree.entries.map(async (entry) => {
      if (!isDirectory(entry.mode)) return entry;
      const subtree = await repo.primitives.readTree(entry.id);
      const [firstBlob, ...restBlobs] = subtree.entries;
      if (firstBlob === undefined) return entry;
      const original = await repo.primitives.readBlob(firstBlob.id);
      const mutatedId = await repo.primitives.hashBlob(mutateBlobContent(original.content), {
        write: true,
      });
      const newSubtreeId = await repo.primitives.writeTree([
        { ...firstBlob, id: mutatedId },
        ...restBlobs,
      ]);
      return { ...entry, id: newSubtreeId };
    }),
  );
  return repo.primitives.writeTree(newEntries);
};

await tieredScenario(
  MULTI_TIERS,
  'When diff() compares HEAD~1 against HEAD recursively, Then measure tsgit',
  async (fixture) => {
    const repo = await openRepository({ cwd: fixture.cwd });

    const sut = async (): Promise<void> => {
      await repo.diff({ from: 'HEAD~1', to: 'HEAD', recursive: true });
    };
    return { teardown: () => repo.dispose(), sut };
  },
);

await tieredScenario(
  MULTI_TIERS,
  'When diff() compares the empty tree against HEAD recursively (the merge-join walks the whole tree), Then measure tsgit',
  async (fixture) => {
    const repo = await openRepository({ cwd: fixture.cwd });

    const sut = async (): Promise<void> => {
      await repo.diff({ from: EMPTY_TREE_OID, to: 'HEAD', recursive: true });
    };
    return { teardown: () => repo.dispose(), sut };
  },
);

await tieredScenario(
  MULTI_TIERS,
  'When diff() compares HEAD against a sibling tree with one blob modified per shard directory, Then the cursor merge-join descends every directory pair instead of expanding an added subtree',
  async (fixture) => {
    const repo = await openRepository({ cwd: fixture.cwd });
    const wideModifyTreeId = await buildWideModifyTreeId(repo, fixture);

    const sut = async (): Promise<void> => {
      await repo.diff({ from: 'HEAD', to: wideModifyTreeId, recursive: true });
    };
    return { teardown: () => repo.dispose(), sut };
  },
);
