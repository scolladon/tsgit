/**
 * Shared pack-pair builder for scenarios that need a hand-assembled,
 * single-blob pack + matching idx sitting directly in objects/pack —
 * optionally stamped with a non-default header version, always the sole
 * source of its blob (the loose copy is removed).
 */
import { hexToBytes } from '../../../src/domain/objects/encoding.ts';
import type { ObjectId } from '../../../src/domain/objects/index.ts';
import {
  PACK_ENTRY_TYPE,
  serializePackfile,
  serializePackIndex,
} from '../../../src/domain/storage/index.ts';
import { computeLooseObjectPath } from '../../../src/domain/storage/loose-path.ts';
import { GENERATED_PACK_VERSION } from '../../../src/domain/storage/pack-entry.ts';
import type { Repository } from '../../../src/repository.ts';

interface WriteScenarioPackPairOptions {
  readonly name: string;
  readonly content: string;
  readonly version?: number;
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** Hand-assembles a one-blob pack + matching idx pair from the domain writers,
 *  writes both under objects/pack/<name>.{pack,idx}, removes the blob's loose
 *  copy so the pack is its only source, and returns the blob's id plus the
 *  written pack base path. A non-default `version` is stamped into the pack
 *  header BEFORE the trailer is computed, so the trailer covers it. */
export async function writeScenarioPackPair(
  repo: Repository,
  opts: WriteScenarioPackPairOptions,
): Promise<{ readonly id: ObjectId; readonly packBase: string }> {
  const content = new TextEncoder().encode(opts.content);
  // `id: '' as ObjectId` signals writeObject to compute the SHA itself —
  // documented contract, mirrored by fsck.scenario.ts / write-pipeline.scenario.ts.
  const id = await repo.primitives.writeObject({
    type: 'blob',
    id: '' as ObjectId,
    content,
  });

  const { data, entries } = serializePackfile([
    {
      type: PACK_ENTRY_TYPE.BLOB,
      uncompressedSize: content.length,
      compressedData: await repo.ctx.compressor.deflate(content),
    },
  ]);
  const entry = entries[0];
  if (entry === undefined) throw new Error(`${opts.name}: missing pack entry`);

  // Stamp the version BEFORE computing the trailer, so the trailer covers
  // the version byte too. Restamping only on divergence keeps the default
  // path's bytes exactly what serializePackfile emitted.
  const version = opts.version ?? GENERATED_PACK_VERSION;
  if (version !== GENERATED_PACK_VERSION) {
    new DataView(data.buffer, data.byteOffset, data.byteLength).setUint32(4, version);
  }
  const trailer = await repo.ctx.hash.hash(data);
  const packBytes = concatBytes(data, trailer);

  // serializePackIndex emits only the pack-checksum half of the 40-byte
  // idx trailer — append the idx-checksum half ourselves.
  const idxBody = serializePackIndex([{ id, crc32: entry.crc32, offset: entry.offset }], trailer);
  const idxBytes = concatBytes(idxBody, hexToBytes(await repo.ctx.hash.hashHex(idxBody)));

  const packBase = `${repo.ctx.layout.gitDir}/objects/pack/${opts.name}`;
  await repo.ctx.fs.write(`${packBase}.pack`, packBytes);
  await repo.ctx.fs.write(`${packBase}.idx`, idxBytes);

  // The loose copy must go — resolveObject consults the loose store before
  // the pack registry, so with it present the pack would never be consulted;
  // removing it makes the pack the object's only source.
  await repo.ctx.fs.rm(`${repo.ctx.layout.gitDir}/objects/${computeLooseObjectPath(id)}`);

  return { id, packBase };
}
