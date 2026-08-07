/**
 * Pack v3 read scenario — hand-assembles a v3-stamped packfile + matching
 * idx (git's numeric pack version, distinct from the idx format version),
 * deletes the loose copy of the packed blob so the pack is the only source,
 * then reads the header through the raw `ctx.fs.readSlice` port and through
 * `readBlob` (which reaches the pack registry via `blob-source.ts`'s
 * `registry.lookup`). Both must return the same bytes/content on node,
 * memory, and browser (OPFS) — the first parity coverage of a 12-byte
 * `readSlice` probe at offset 0 on this path.
 *
 * Surfaces closed:
 *   primitives: readBlob (through the pack registry's header-probe gate)
 */
import { hexToBytes } from '../../../src/domain/objects/encoding.ts';
import type { ObjectId } from '../../../src/domain/objects/index.ts';
import {
  PACK_ENTRY_TYPE,
  serializePackfile,
  serializePackIndex,
} from '../../../src/domain/storage/index.ts';
import { computeLooseObjectPath } from '../../../src/domain/storage/loose-path.ts';
import { PACK_HEADER_SIZE } from '../../../src/domain/storage/pack-entry.ts';
import { AUTHOR, FILES, MESSAGES } from '../fixtures.ts';
import type { Scenario } from './types.ts';

interface PackV3ReadResult {
  readonly probedVersion: number;
  readonly readBackContent: string;
}

const PACKED_BLOB_CONTENT = 'packed via v3\n';

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

export const packV3ReadScenario: Scenario<PackV3ReadResult> = {
  name: 'pack-v3-read',
  inputs: { files: [FILES.helloA], author: AUTHOR, message: MESSAGES.seed },
  expected: {
    probedVersion: 3,
    readBackContent: PACKED_BLOB_CONTENT,
  },
  run: async (repo, inputs) => {
    // Arrange — seed a real repo on every adapter
    await repo.init();
    await repo.add(inputs.files.map((file) => file.path));
    await repo.commit({ message: inputs.message, author: inputs.author });

    const content = new TextEncoder().encode(PACKED_BLOB_CONTENT);
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
    if (entry === undefined) throw new Error('pack-v3-read: missing pack entry');

    // Stamp version 3 BEFORE computing the trailer, so the trailer covers
    // the version byte too — the fixture's only anomaly is the version.
    new DataView(data.buffer, data.byteOffset, data.byteLength).setUint32(4, 3);
    const trailer = await repo.ctx.hash.hash(data);
    const packBytes = concatBytes(data, trailer);

    // The writer emits only the pack-checksum half of the 40-byte idx
    // trailer (test/unit/application/primitives/pack-fixture.ts:140-145) —
    // append the idx-checksum half ourselves.
    const idxBody = serializePackIndex([{ id, crc32: entry.crc32, offset: entry.offset }], trailer);
    const idxBytes = concatBytes(idxBody, hexToBytes(await repo.ctx.hash.hashHex(idxBody)));

    const packBase = `${repo.ctx.layout.gitDir}/objects/pack/pack-parity-v3`;
    await repo.ctx.fs.write(`${packBase}.pack`, packBytes);
    await repo.ctx.fs.write(`${packBase}.idx`, idxBytes);

    // The loose copy must go, or the loose probe answers first
    // (object-resolver.ts:60-75) and the pack is never consulted — this
    // deletion is the scenario's whole point.
    await repo.ctx.fs.rm(`${repo.ctx.layout.gitDir}/objects/${computeLooseObjectPath(id)}`);

    // Act — probe the raw header through the port under test, then read
    // the blob back through the primitive that reaches the same registry.
    const head = await repo.ctx.fs.readSlice(`${packBase}.pack`, 0, PACK_HEADER_SIZE);
    const probedVersion = new DataView(head.buffer, head.byteOffset, head.byteLength).getUint32(4);
    const blob = await repo.primitives.readBlob(id);

    // Assert — project to deterministic fields only, no oid
    return {
      probedVersion,
      readBackContent: new TextDecoder().decode(blob.content),
    };
  },
};
