/**
 * Benchmark fixtures. Builds synthetic repos under the OS tmpdir on first
 * import, then re-uses them for every `*.bench.ts` file in the same vitest run.
 *
 * We deliberately seed with the Node shim (not isomorphic-git) so the fixture
 * exercises our own loose-object storage, then both libraries read the same
 * resulting on-disk layout. That isolates the benchmark to read-path
 * performance rather than write-path differences.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { packPositionMap } from '../../src/application/primitives/internal/pack-positions.js';
import { parsePackIndex } from '../../src/domain/storage/index.js';
import { openRepository } from '../../src/index.node.js';
import type { Context } from '../../src/ports/context.js';
import {
  type EntrySpec,
  writeSyntheticPack,
  writeSyntheticRevIndex,
} from '../unit/application/primitives/pack-fixture.js';

export interface BenchRepo {
  readonly cwd: string;
  readonly headCommitId: string;
  readonly firstBlobId: string;
  readonly cleanup: () => Promise<void>;
}

const AUTHOR = {
  name: 'Bench',
  email: 'bench@tsgit.dev',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
} as const;

export const setupSmallRepo = async (opts: { commits?: number } = {}): Promise<BenchRepo> => {
  const commits = opts.commits ?? 50;
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'tsgit-bench-small-'));
  const repo = await openRepository({ cwd });

  let firstBlobId = '';
  let headCommitId = '';
  try {
    await repo.init();
    for (let i = 0; i < commits; i += 1) {
      const name = `f${i.toString().padStart(4, '0')}.txt`;
      await writeFile(path.join(cwd, name), `payload ${i}\n`);
      await repo.add([name]);
      const result = await repo.commit({
        message: `commit ${i}`,
        author: { ...AUTHOR, timestamp: AUTHOR.timestamp + i },
      });
      headCommitId = result.id;
      if (i === 0) {
        const tree = await repo.primitives.readTree(result.tree);
        const blobEntry = tree.entries.find((entry) => entry.name === name);
        if (blobEntry !== undefined) firstBlobId = blobEntry.id;
      }
    }
  } finally {
    await repo.dispose();
  }

  if (firstBlobId === '' || headCommitId === '') {
    throw new Error('benchmark fixture failed to capture seed ids');
  }

  return {
    cwd,
    headCommitId,
    firstBlobId,
    cleanup: () => rm(cwd, { recursive: true, force: true }),
  };
};

export const setupDirtyWorkingTree = async (
  base: BenchRepo,
  modifiedFiles: number,
): Promise<void> => {
  for (let i = 0; i < modifiedFiles; i += 1) {
    const name = `f${i.toString().padStart(4, '0')}.txt`;
    await writeFile(path.join(base.cwd, name), `payload ${i} dirty\n`);
  }
};

/**
 * Fixtures for the `.rev` accelerator bench (`buildOffsetTable`). Built
 * entirely with the domain's own pack writer (`writeSyntheticPack`) and
 * reverse-index writer (`writeSyntheticRevIndex`) against a disk-backed
 * `Context` — never `git` — so the fixture directory holds exactly the
 * bytes the accelerator reads, nothing a `git repack` heuristic chose.
 */

const OFFSET_TABLE_BLOB_BYTES = 24;

/** xorshift32 fill, keyed by index — deterministic, distinct-per-object content. */
const offsetTableBlobContent = (index: number): Uint8Array => {
  const buf = new Uint8Array(OFFSET_TABLE_BLOB_BYTES);
  let state = (index + 1) >>> 0;
  for (let i = 0; i < OFFSET_TABLE_BLOB_BYTES; i += 1) {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    buf[i] = state & 0xff;
  }
  return buf;
};

const offsetTableBlobEntry = (contentIndex: number): EntrySpec => ({
  kind: 'base',
  type: 'blob',
  content: offsetTableBlobContent(contentIndex),
});

/** Writes a correct `.rev` sibling for `packName`, derived from its own just-written `.idx`. */
async function writeCorrectRevIndex(ctx: Context, packName: string): Promise<void> {
  const idxPath = `${ctx.layout.gitDir}/objects/pack/pack-${packName}.idx`;
  const idxBytes = await ctx.fs.read(idxPath);
  const body = packPositionMap(parsePackIndex(idxBytes));
  await writeSyntheticRevIndex(ctx, packName, body);
}

export interface OffsetTablePackFixture {
  readonly cwd: string;
  readonly cleanup: () => Promise<void>;
}

/** Large enough that gathering the offset table in O(n) from a `.rev` is
 *  expected to beat sorting `entryOffsets` in O(n log n). */
export const MANY_OBJECT_COUNT = 3_000;

/**
 * A single pack holding `MANY_OBJECT_COUNT` blobs — the shape `buildOffsetTable`'s
 * O(n) `.rev` gather is expected to win on. `withRevIndex` toggles whether the
 * pack's `.rev` sibling is written at all, giving the gather/sort pair distinct
 * fixture directories rather than one mutated in place.
 */
export const setupManyObjectPackFixture = async (
  withRevIndex: boolean,
): Promise<OffsetTablePackFixture> => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'tsgit-bench-offset-table-many-object-'));
  const ctx = createNodeContext({ workDir: cwd, hooks: false, command: false, ssh: false });
  const packName = 'offset-table-many-object';
  const entries = Array.from({ length: MANY_OBJECT_COUNT }, (_unused, i) =>
    offsetTableBlobEntry(i),
  );
  const ids = await writeSyntheticPack(ctx, packName, entries);
  if (ids.length !== MANY_OBJECT_COUNT) {
    throw new Error(
      `offset-table fixture: built ${ids.length} objects, expected ${MANY_OBJECT_COUNT}`,
    );
  }
  if (withRevIndex) await writeCorrectRevIndex(ctx, packName);

  return { cwd, cleanup: () => rm(cwd, { recursive: true, force: true }) };
};

/** Pack count large enough that one extra `.rev` open+read per pack can
 *  outweigh sorting each pack's own (small) offset array. */
export const MANY_SMALL_PACK_COUNT = 64;
/** Objects per pack — small enough that sorting them is nearly free, so the
 *  fixed per-pack `.rev` I/O cost is what the comparison actually measures. */
export const MANY_SMALL_PACK_OBJECTS_PER_PACK = 4;

/**
 * Asserts, from the on-disk directory listing (never the build loop's own
 * counters), that exactly `MANY_SMALL_PACK_COUNT` distinct `.pack` files
 * landed under the pack directory — the "many" half of "many small packs".
 * The "small" half is asserted per-pack at build time, against each pack's
 * own `writeSyntheticPack` result.
 */
async function assertManyPackFiles(ctx: Context): Promise<void> {
  const packDir = `${ctx.layout.gitDir}/objects/pack`;
  const entries = await ctx.fs.readdir(packDir);
  const packFiles = entries.filter((entry) => entry.isFile && entry.name.endsWith('.pack'));
  if (packFiles.length !== MANY_SMALL_PACK_COUNT) {
    throw new Error(
      `offset-table fixture: found ${packFiles.length} .pack files, expected ${MANY_SMALL_PACK_COUNT}`,
    );
  }
}

/**
 * `MANY_SMALL_PACK_COUNT` independent packs, each holding
 * `MANY_SMALL_PACK_OBJECTS_PER_PACK` blobs — the shape where one extra
 * `open` + `read` per pack can turn the accelerator into a regression.
 * `withRevIndex` toggles whether EVERY pack gets a `.rev` sibling.
 */
export const setupManySmallPacksFixture = async (
  withRevIndex: boolean,
): Promise<OffsetTablePackFixture> => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'tsgit-bench-offset-table-small-packs-'));
  const ctx = createNodeContext({ workDir: cwd, hooks: false, command: false, ssh: false });

  for (let p = 0; p < MANY_SMALL_PACK_COUNT; p += 1) {
    const packName = `offset-table-small-${p}`;
    const entries = Array.from({ length: MANY_SMALL_PACK_OBJECTS_PER_PACK }, (_unused, k) =>
      offsetTableBlobEntry(p * MANY_SMALL_PACK_OBJECTS_PER_PACK + k),
    );
    const ids = await writeSyntheticPack(ctx, packName, entries);
    if (ids.length !== MANY_SMALL_PACK_OBJECTS_PER_PACK) {
      throw new Error(
        `offset-table fixture: pack ${packName} built ${ids.length} objects, expected ${MANY_SMALL_PACK_OBJECTS_PER_PACK}`,
      );
    }
    if (withRevIndex) await writeCorrectRevIndex(ctx, packName);
  }
  await assertManyPackFiles(ctx);

  return { cwd, cleanup: () => rm(cwd, { recursive: true, force: true }) };
};
