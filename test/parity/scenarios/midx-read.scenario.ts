/**
 * Multi-pack-index read scenario — hand-writes a flat midx over two
 * hand-assembled single-blob packs (there is no domain writer to call: no
 * midx write path exists) and proves node, memory and browser (OPFS) agree
 * on every one of its outcomes: a healthy midx serves both packed blobs, a
 * midx-named pack going missing is a consistent miss on every adapter (the
 * midx's assignment is authoritative, never a hint to fall back from), a
 * structurally unusable (Tier-B) midx is discarded and the read still
 * succeeds via the `.idx` scan, and `fsck()` over the stale shape reports
 * the same finding census everywhere. The browser adapter has no
 * `openWithNoFollow`, but the midx path reaches every pack only through
 * `ctx.fs.read`, so that fallback machinery is never exercised on this path
 * — which is itself the assertion this scenario makes by construction.
 *
 * Surfaces closed:
 *   primitives: readBlob (through the pack registry's midx lookup)
 *   commands: fsck (the multi-pack-index health pass)
 */
import { getPackRegistry } from '../../../src/application/primitives/read-object.ts';
import type { ObjectId } from '../../../src/domain/objects/index.ts';
import { PACK_HEADER_SIZE } from '../../../src/domain/storage/pack-entry.ts';
import { AUTHOR, FILES, MESSAGES } from '../fixtures.ts';
import { writeScenarioPackPair } from './pack-pair.ts';
import type { Scenario } from './types.ts';

interface MidxReadResult {
  readonly healthyContentA: string;
  readonly healthyContentB: string;
  readonly staleReadSucceeded: boolean;
  readonly staleRejectCode: string;
  readonly tierBReadSucceeded: boolean;
  readonly tierBContent: string;
  readonly staleFsckExitCode: number;
  readonly staleFsckFindingTypes: ReadonlyArray<string>;
}

const CONTENT_A = 'midx parity pack a\n';
const CONTENT_B = 'midx parity pack b\n';
const PACK_NAME_A = 'pack-parity-midx-a';
const PACK_NAME_B = 'pack-parity-midx-b';

interface MidxPackEntry {
  readonly id: ObjectId;
  readonly packIndex: number;
  readonly offset: number;
}

const MIDX_HEADER_SIZE = 12;
const MIDX_CHUNK_TABLE_ROW_SIZE = 12;
const MIDX_FANOUT_SIZE = 1024;

/**
 * Hand-writes a flat multi-pack-index over `packNames` + `entries` — the
 * grammar the domain parser reads, trimmed to the flat, no-large-offset
 * shape a parity fixture needs (every offset here is `PACK_HEADER_SIZE`,
 * always small). No domain writer exists to call for this (there is no
 * write path for this format), so the byte layout is reproduced here from
 * the same recipe the domain parser's own round-trip test builder uses. The
 * trailer is left zeroed; the caller re-hashes it with the repository's own
 * `HashService` so the artefact passes `fsck`'s checksum check too.
 */
function buildFlatMidx(
  packNames: ReadonlyArray<string>,
  entries: ReadonlyArray<MidxPackEntry>,
  digestLength: number,
): Uint8Array {
  const encoder = new TextEncoder();
  const sorted = [...entries].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const objectCount = sorted.length;
  const hashVersion = digestLength === 32 ? 2 : 1;

  const nameBytes = packNames.map((name) => encoder.encode(`${name}\0`));
  const pnamRaw = nameBytes.reduce((sum, bytes) => sum + bytes.length, 0);
  const pnamLength = pnamRaw + ((4 - (pnamRaw % 4)) % 4);
  const numChunks = 4;

  const chunkTableSize = (numChunks + 1) * MIDX_CHUNK_TABLE_ROW_SIZE;
  const pnamStart = MIDX_HEADER_SIZE + chunkTableSize;
  const oidfStart = pnamStart + pnamLength;
  const oidlStart = oidfStart + MIDX_FANOUT_SIZE;
  const ooffStart = oidlStart + objectCount * digestLength;
  const trailerStart = ooffStart + objectCount * 8;

  const bytes = new Uint8Array(trailerStart + digestLength);
  const view = new DataView(bytes.buffer);

  bytes.set(encoder.encode('MIDX'), 0);
  view.setUint8(4, 1);
  view.setUint8(5, hashVersion);
  view.setUint8(6, numChunks);
  view.setUint8(7, 0);
  view.setUint32(8, packNames.length);

  const chunkRows: ReadonlyArray<readonly [string, number]> = [
    ['PNAM', pnamStart],
    ['OIDF', oidfStart],
    ['OIDL', oidlStart],
    ['OOFF', ooffStart],
    ['', trailerStart],
  ];
  for (let i = 0; i < chunkRows.length; i += 1) {
    const row = chunkRows[i];
    if (row === undefined) continue;
    const [id, offset] = row;
    const rowStart = MIDX_HEADER_SIZE + i * MIDX_CHUNK_TABLE_ROW_SIZE;
    if (id !== '') bytes.set(encoder.encode(id), rowStart);
    view.setUint32(rowStart + 4, Math.floor(offset / 0x100000000));
    view.setUint32(rowStart + 8, offset >>> 0);
  }

  let nameCursor = pnamStart;
  for (const name of nameBytes) {
    bytes.set(name, nameCursor);
    nameCursor += name.length;
  }

  const fanout = new Uint32Array(256);
  for (const entry of sorted) {
    const firstByte = Number.parseInt(entry.id.slice(0, 2), 16);
    for (let i = firstByte; i < 256; i += 1) {
      const current = fanout[i] ?? 0;
      fanout[i] = current + 1;
    }
  }
  for (let i = 0; i < 256; i += 1) view.setUint32(oidfStart + i * 4, fanout[i] ?? 0);

  for (let i = 0; i < objectCount; i += 1) {
    const entry = sorted[i];
    if (entry === undefined) continue;
    const idBytes = new Uint8Array(entry.id.length / 2);
    for (let b = 0; b < idBytes.length; b += 1) {
      idBytes[b] = Number.parseInt(entry.id.slice(b * 2, b * 2 + 2), 16);
    }
    bytes.set(idBytes, oidlStart + i * digestLength);
  }

  for (let i = 0; i < objectCount; i += 1) {
    const entry = sorted[i];
    if (entry === undefined) continue;
    view.setUint32(ooffStart + i * 8, entry.packIndex);
    view.setUint32(ooffStart + i * 8 + 4, entry.offset);
  }

  return bytes;
}

export const midxReadScenario: Scenario<MidxReadResult> = {
  name: 'midx-read',
  inputs: { files: [FILES.helloA], author: AUTHOR, message: MESSAGES.seed },
  expected: {
    healthyContentA: CONTENT_A,
    healthyContentB: CONTENT_B,
    staleReadSucceeded: false,
    staleRejectCode: 'OBJECT_NOT_FOUND',
    tierBReadSucceeded: true,
    tierBContent: CONTENT_A,
    staleFsckExitCode: 32,
    staleFsckFindingTypes: [
      'dangling',
      'midx-entry-unresolved',
      'midx-pack-unresolved',
      'root',
      'unreachable',
    ],
  },
  run: async (repo, inputs) => {
    // Arrange — seed a healthy root commit, then two hand-built single-blob
    // packs the flat midx below will assign one each.
    await repo.init();
    await repo.add(inputs.files.map((file) => file.path));
    await repo.commit({ message: inputs.message, author: inputs.author });

    const packDir = `${repo.ctx.layout.gitDir}/objects/pack`;
    const { id: idA } = await writeScenarioPackPair(repo, {
      name: PACK_NAME_A,
      content: CONTENT_A,
    });
    const { id: idB } = await writeScenarioPackPair(repo, {
      name: PACK_NAME_B,
      content: CONTENT_B,
    });

    const digestLength = repo.ctx.hash.digestLength;
    const packNames = [`${PACK_NAME_A}.idx`, `${PACK_NAME_B}.idx`];
    const entries: ReadonlyArray<MidxPackEntry> = [
      { id: idA, packIndex: 0, offset: PACK_HEADER_SIZE },
      { id: idB, packIndex: 1, offset: PACK_HEADER_SIZE },
    ];
    const midxBytes = buildFlatMidx(packNames, entries, digestLength);
    const trailerStart = midxBytes.length - digestLength;
    const trailer = await repo.ctx.hash.hash(midxBytes.subarray(0, trailerStart));
    midxBytes.set(trailer, trailerStart);
    const midxPath = `${packDir}/multi-pack-index`;
    await repo.ctx.fs.write(midxPath, midxBytes);

    // Act — leg 1: healthy flat midx, both blobs read via their assigned pack
    getPackRegistry(repo.ctx).refresh();
    const blobA = await repo.primitives.readBlob(idA);
    const blobB = await repo.primitives.readBlob(idB);
    const healthyContentA = new TextDecoder().decode(blobA.content);
    const healthyContentB = new TextDecoder().decode(blobB.content);

    // Act — leg 2: pack B's artefacts removed while the midx still names it
    // — the midx's assignment is authority, so the read misses rather than
    // falling back to any other pack. Drops leg 1's own resolved-bytes cache
    // entry for idB first: a per-Context cache hit would otherwise serve the
    // content leg 1 already read, masking the very miss this leg proves.
    await repo.ctx.fs.rm(`${packDir}/${PACK_NAME_B}.pack`);
    await repo.ctx.fs.rm(`${packDir}/${PACK_NAME_B}.idx`);
    repo.ctx.deltaCache.delete(idB);
    getPackRegistry(repo.ctx).refresh();
    let staleReadSucceeded = true;
    let staleRejectCode = 'unexpected-success';
    try {
      await repo.primitives.readBlob(idB);
    } catch (error) {
      staleReadSucceeded = false;
      staleRejectCode = (error as { data?: { code?: string } }).data?.code ?? 'unexpected-shape';
    }

    // Act — leg 4: fsck() over the same stale shape, before it is repaired
    const staleFsckResult = await repo.fsck();

    // Act — leg 3: the flat midx truncated to a Tier-B fault — discarded, the
    // read for the still-present pack A blob falls back to the `.idx` scan
    await repo.ctx.fs.write(midxPath, midxBytes.subarray(0, 4));
    getPackRegistry(repo.ctx).refresh();
    let tierBReadSucceeded = true;
    let tierBContent = '';
    try {
      const blob = await repo.primitives.readBlob(idA);
      tierBContent = new TextDecoder().decode(blob.content);
    } catch {
      tierBReadSucceeded = false;
    }

    // Assert — project to deterministic fields only, no oid
    return {
      healthyContentA,
      healthyContentB,
      staleReadSucceeded,
      staleRejectCode,
      tierBReadSucceeded,
      tierBContent,
      staleFsckExitCode: staleFsckResult.exitCode,
      staleFsckFindingTypes: [
        ...new Set(staleFsckResult.findings.map((finding) => finding.type)),
      ].sort(),
    };
  },
};
