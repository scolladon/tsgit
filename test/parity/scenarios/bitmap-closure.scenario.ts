/**
 * Bitmap closure scenario — hand-writes a pack bitmap over a small,
 * hand-assembled 2-commit pack (there is no domain writer to call: tsgit
 * cannot write a bitmap) and proves node, memory and browser agree that
 * `revList({ useBitmapIndex: true })` answers from the bitmap tier: the
 * full 4-object closure (blob, tree, both commits) resolved through an
 * XOR-chained entry pair, with no `path` on any entry.
 *
 * `buildBitmap` is the hand-built-bytes writer every bitmap suite shares
 * (`test/fixtures/storage/bitmap-writers.ts`) — importing a fixture writer
 * here is the sanctioned exception to this tree's own-package rule, made
 * explicit because there is no production writer for this artefact to call
 * instead. That module is deliberately free of `fast-check`: the Deno, Bun
 * and `workerd` drivers resolve this scenario's whole graph strictly, so a
 * dev dependency reached from here fails the run outright.
 *
 * Surfaces closed:
 *   commands: revList (the bitmap tier)
 */
import type { ObjectId } from '../../../src/domain/objects/index.ts';
import { serializeObject } from '../../../src/domain/objects/index.ts';
import { treeEntry } from '../../../src/domain/objects/tree.js';
import {
  type BasePackEntryType,
  PACK_ENTRY_TYPE,
  serializePackfile,
  serializePackIndex,
  sortPackIndexEntries,
} from '../../../src/domain/storage/index.ts';
import type { Repository } from '../../../src/repository.ts';
import { type BitmapEntrySpec, buildBitmap } from '../../fixtures/storage/bitmap-writers.ts';
import { packIndexEntriesOf, sealPackIndex } from '../../fixtures/storage/pack-index-entries.ts';
import { AUTHOR, MESSAGES } from '../fixtures.ts';
import type { Scenario } from './types.ts';

/** An object's id and its content (header stripped) as the pack expects it,
 *  hashed from the domain serializer's bytes without touching the store: the
 *  session's pack listing must first be read after the pack below exists, as
 *  a fresh git process would read it. */
async function hashedContentOf(
  repo: Repository,
  object: Parameters<typeof serializeObject>[0],
): Promise<{ readonly id: ObjectId; readonly content: Uint8Array }> {
  const full = serializeObject(object, repo.ctx.hashConfig);
  const nul = full.indexOf(0);
  return { id: (await repo.ctx.hash.hashHex(full)) as ObjectId, content: full.subarray(nul + 1) };
}

interface BitmapClosureResult {
  readonly count: number;
  readonly named: number;
  /** Sorted type multiset — the closure's SHAPE, not just its size: a tier
   *  that returned four objects of the wrong kinds would otherwise pass. */
  readonly types: ReadonlyArray<string>;
}

const PACK_NAME = 'pack-parity-bitmap-closure';

interface PackedObject {
  readonly id: ObjectId;
  readonly type: BasePackEntryType;
  readonly content: Uint8Array;
}

function concatBytes(...arrays: ReadonlyArray<Uint8Array>): Uint8Array {
  const total = arrays.reduce((sum, a) => sum + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

interface PackedChain {
  /** Every object's id, in PACK (insertion) position order: blob, tree,
   *  seed commit, second commit — positions 0..3. */
  readonly ids: ReadonlyArray<ObjectId>;
  readonly commitIds: ReadonlyArray<ObjectId>;
}

/**
 * Hashes one blob, one tree and a 2-commit chain over it (each tree/commit
 * id depends on earlier ones) and packs the whole set via the domain
 * writers, so the pack is the sole source of every object.
 */
async function buildAndPackChain(repo: Repository): Promise<PackedChain> {
  const blob = await hashedContentOf(repo, {
    type: 'blob',
    id: '' as ObjectId,
    content: new TextEncoder().encode('bitmap parity blob\n'),
  });
  const tree = await hashedContentOf(repo, {
    type: 'tree',
    id: '' as ObjectId,
    entries: [treeEntry('100644' as const, 'bitmap.txt', blob.id)],
  });
  const objects: PackedObject[] = [
    { id: blob.id, type: PACK_ENTRY_TYPE.BLOB, content: blob.content },
    { id: tree.id, type: PACK_ENTRY_TYPE.TREE, content: tree.content },
  ];

  const commitIds: ObjectId[] = [];
  let parent: ObjectId | undefined;
  for (let i = 0; i < 2; i += 1) {
    const commit = await hashedContentOf(repo, {
      type: 'commit',
      id: '' as ObjectId,
      data: {
        tree: tree.id,
        parents: parent === undefined ? [] : [parent],
        author: AUTHOR,
        committer: AUTHOR,
        message: i === 0 ? MESSAGES.seed : MESSAGES.second,
        extraHeaders: [],
      },
    });
    objects.push({ id: commit.id, type: PACK_ENTRY_TYPE.COMMIT, content: commit.content });
    commitIds.push(commit.id);
    parent = commit.id;
  }

  const { data, entries } = serializePackfile(
    await Promise.all(
      objects.map(async (object) => ({
        type: object.type,
        uncompressedSize: object.content.length,
        compressedData: await repo.ctx.compressor.deflate(object.content),
      })),
    ),
  );
  const trailer = await repo.ctx.hash.hash(data);
  const packBytes = concatBytes(data, trailer);

  const idxEntries = objects.map((object, i) => ({
    id: object.id,
    crc32: entries[i]?.crc32 ?? 0,
    offset: entries[i]?.offset ?? 0,
  }));
  const idxBody = serializePackIndex(
    sortPackIndexEntries(packIndexEntriesOf(idxEntries, trailer.length)),
    trailer,
  );
  const idxBytes = await sealPackIndex(
    idxBody,
    (bytes) => repo.ctx.hash.hash(bytes),
    repo.ctx.hash.digestLength,
  );

  const packBase = `${repo.ctx.layout.gitDir}/objects/pack/${PACK_NAME}`;
  await repo.ctx.fs.write(`${packBase}.pack`, packBytes);
  await repo.ctx.fs.write(`${packBase}.idx`, idxBytes);

  return { ids: objects.map((object) => object.id), commitIds };
}

/** Index position — the SHA-sorted rank among every id the pack carries —
 *  of `id`. An entry header names a commit by index position, never by
 *  its pack (insertion-order) position. */
function indexPositionOf(ids: ReadonlyArray<ObjectId>, id: ObjectId): number {
  return [...ids].sort().indexOf(id);
}

/**
 * Writes a healthy, XOR-chained bitmap over the pack `buildAndPackChain`
 * wrote: entry 0 (the seed commit, a terminator) carries positions
 * `[blob, tree, commit0]`; entry 1 (the second commit, `xorOffset: 1`)
 * carries only its own new position, `[commit1]`, so the fold accumulates
 * the seed generation's objects too. Every position here is a PACK
 * (insertion-order) position — `blob=0`, `tree=1`, `commit0=2`, `commit1=3`.
 */
async function writeHealthyBitmap(repo: Repository, chain: PackedChain): Promise<void> {
  const digestLength = repo.ctx.hashConfig.digestLength;
  const entries: BitmapEntrySpec[] = [
    {
      position: indexPositionOf(chain.ids, chain.commitIds[0] as ObjectId),
      xorOffset: 0,
      flags: 0,
      bitSize: 4,
      bits: [0, 1, 2],
    },
    {
      position: indexPositionOf(chain.ids, chain.commitIds[1] as ObjectId),
      xorOffset: 1,
      flags: 0,
      bitSize: 4,
      bits: [3],
    },
  ];
  const typeStream = (bits: ReadonlyArray<number>) => ({ bitSize: 4, bits });
  const body = buildBitmap({
    optionFlags: 1,
    digestLength,
    checksum: new Uint8Array(digestLength).fill(0xbb),
    typeStreams: [typeStream([2, 3]), typeStream([1]), typeStream([0]), typeStream([])],
    entries,
    trailingBytes: 0,
  });
  const trailer = await repo.ctx.hash.hash(body);
  const stamped = concatBytes(body, trailer);
  await repo.ctx.fs.write(`${repo.ctx.layout.gitDir}/objects/pack/${PACK_NAME}.bitmap`, stamped);
}

export const bitmapClosureScenario: Scenario<BitmapClosureResult> = {
  name: 'bitmap-closure',
  inputs: { files: [], author: AUTHOR, message: MESSAGES.seed },
  expected: { count: 4, named: 0, types: ['blob', 'commit', 'commit', 'tree'] },
  run: async (repo) => {
    // Arrange
    await repo.init();
    const chain = await buildAndPackChain(repo);
    await writeHealthyBitmap(repo, chain);

    // Act
    const result = await repo.revList({
      wants: [chain.commitIds[1] as string],
      objects: true,
      useBitmapIndex: true,
    });

    // Assert — project to deterministic fields only, no oid
    const named = result.entries.filter((entry) => entry.path !== undefined).length;
    const types = result.entries.map((entry) => entry.type).sort();
    return { count: result.count, named, types };
  },
};
