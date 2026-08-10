/**
 * Bitmap closure scenario — hand-writes a pack bitmap over a small,
 * hand-assembled 2-commit pack (there is no domain writer to call: tsgit
 * cannot write a bitmap) and proves node, memory and browser agree that
 * `revList({ useBitmapIndex: true })` answers from the bitmap tier: the
 * full 4-object closure (blob, tree, both commits) resolved through an
 * XOR-chained entry pair, with no `path` on any entry.
 *
 * `buildBitmap` is the hand-built-bytes writer from the domain parser's
 * own round-trip test suite (`test/unit/domain/storage/arbitraries.ts`)
 * — importing it here is the sanctioned exception to this tree's
 * own-package rule, made explicit because there is no production writer
 * for this artefact to call instead.
 *
 * Surfaces closed:
 *   commands: revList (the bitmap tier)
 */
import { hexToBytes } from '../../../src/domain/objects/encoding.ts';
import type { ObjectId } from '../../../src/domain/objects/index.ts';
import { serializeObject } from '../../../src/domain/objects/index.ts';
import {
  type BasePackEntryType,
  PACK_ENTRY_TYPE,
  serializePackfile,
  serializePackIndex,
} from '../../../src/domain/storage/index.ts';
import { computeLooseObjectPath } from '../../../src/domain/storage/loose-path.ts';
import type { Repository } from '../../../src/repository.ts';
import { type BitmapEntrySpec, buildBitmap } from '../../unit/domain/storage/arbitraries.ts';
import { AUTHOR, MESSAGES } from '../fixtures.ts';
import type { Scenario } from './types.ts';

/** Object content (header stripped) as the pack expects it — serializes the
 *  SAME object literal `writeObject` just wrote (now carrying its real
 *  id), so the packed bytes are exactly what the domain serializer
 *  produces, with no second read of the store. */
function packedContentOf(
  repo: Repository,
  object: Parameters<typeof serializeObject>[0],
): Uint8Array {
  const full = serializeObject(object, repo.ctx.hashConfig);
  const nul = full.indexOf(0);
  return full.subarray(nul + 1);
}

interface BitmapClosureResult {
  readonly count: number;
  readonly named: number;
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
 * Writes one blob, one tree and a 2-commit chain over it as loose objects
 * first (so `writeObject` computes each real id, including tree/commit
 * ids that depend on earlier ones), packs the whole set via the domain
 * writers, and removes the loose copies so the pack is the sole source.
 */
async function buildAndPackChain(repo: Repository): Promise<PackedChain> {
  const enc = new TextEncoder();
  const objects: PackedObject[] = [];

  const blobContent = enc.encode('bitmap parity blob\n');
  const blobId = await repo.primitives.writeObject({
    type: 'blob',
    id: '' as ObjectId,
    content: blobContent,
  });
  objects.push({ id: blobId, type: PACK_ENTRY_TYPE.BLOB, content: blobContent });

  const treeEntries = [{ name: 'bitmap.txt', mode: '100644' as const, id: blobId }];
  const treeId = await repo.primitives.writeObject({
    type: 'tree',
    id: '' as ObjectId,
    entries: treeEntries,
  });
  // Re-serialises the SAME literal just written, now carrying the real id
  // `writeObject` computed — the packed bytes are exactly what the domain
  // tree serializer produced, with no second read of the store.
  objects.push({
    id: treeId,
    type: PACK_ENTRY_TYPE.TREE,
    content: packedContentOf(repo, { type: 'tree', id: treeId, entries: treeEntries }),
  });

  const commitIds: ObjectId[] = [];
  let parent: ObjectId | undefined;
  for (let i = 0; i < 2; i += 1) {
    const commitData = {
      tree: treeId,
      parents: parent === undefined ? [] : [parent],
      author: AUTHOR,
      committer: AUTHOR,
      message: i === 0 ? MESSAGES.seed : MESSAGES.second,
      extraHeaders: [],
    };
    const commitId = await repo.primitives.writeObject({
      type: 'commit',
      id: '' as ObjectId,
      data: commitData,
    });
    objects.push({
      id: commitId,
      type: PACK_ENTRY_TYPE.COMMIT,
      content: packedContentOf(repo, { type: 'commit', id: commitId, data: commitData }),
    });
    commitIds.push(commitId);
    parent = commitId;
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
  const idxBody = serializePackIndex(idxEntries, trailer);
  const idxBytes = concatBytes(idxBody, hexToBytes(await repo.ctx.hash.hashHex(idxBody)));

  const packBase = `${repo.ctx.layout.gitDir}/objects/pack/${PACK_NAME}`;
  await repo.ctx.fs.write(`${packBase}.pack`, packBytes);
  await repo.ctx.fs.write(`${packBase}.idx`, idxBytes);

  for (const object of objects) {
    await repo.ctx.fs.rm(`${repo.ctx.layout.gitDir}/objects/${computeLooseObjectPath(object.id)}`);
  }

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
  expected: { count: 4, named: 0 },
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
    return { count: result.count, named };
  },
};
