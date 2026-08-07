/**
 * Degraded-store scenario across node, memory, and browser (OPFS) adapters:
 * a pack set mixing three distinct refusal shapes — a corrupt `.idx` with a
 * sibling `.pack`, a header-version-99 pack, and a structurally healthy pack
 * whose sole entry will not inflate — plus one undecodable dangling loose
 * object, run through both `fsck()` and `fsck({ connectivityOnly: true })`.
 *
 * The reject leg is the largest exposure in the whole pack-accessibility
 * change: the verdict is reached through `ctx.compressor.inflate`, and every
 * adapter owns its own decoder (node's `zlib`, the memory adapter's
 * `DecompressionStream`, the browser tier's `inflateZlibMember`). A decoder
 * that returned empty bytes instead of throwing would silently move an
 * object from the reject class into `dangling unknown` on that adapter
 * alone — a discrepancy a reporting surface turns into a *missing finding*
 * rather than a thrown error, so it needs cross-adapter proof, not just a
 * cross-tool one.
 *
 * Surfaces closed:
 *   commands: fsck
 */
import { hexToBytes } from '../../../src/domain/objects/encoding.ts';
import type { ObjectId } from '../../../src/domain/objects/index.ts';
import {
  PACK_ENTRY_TYPE,
  serializePackfile,
  serializePackIndex,
} from '../../../src/domain/storage/index.ts';
import { computeLooseObjectPath } from '../../../src/domain/storage/loose-path.ts';
import type { Repository } from '../../../src/repository.ts';
import { AUTHOR, FILES, MESSAGES } from '../fixtures.ts';
import { writeScenarioPackPair } from './pack-pair.ts';
import type { Scenario } from './types.ts';

interface FsckDegradedStoreResult {
  readonly defaultExitCode: number;
  readonly packInaccessibleCount: number;
  readonly packIndexUnusableCount: number;
  readonly connectivityExitCode: number;
  readonly connectivityObjectTypeCensus: ReadonlyArray<string>;
  readonly connectivityRejectCode: string;
  readonly v99IdType: string;
  readonly corruptEntryIdType: string;
  readonly defaultAfterBadObjectCount: number;
}

// Header (8) + fanout table (1024) is the parser's minimum-size gate; this
// buffer clears it so the failure is specifically the v2 magic check, not a
// truncation short-circuit — same recipe as pack-degraded-idx.scenario.ts.
const CORRUPT_IDX_BYTES = new Uint8Array(1072);
const ARBITRARY_PACK_BYTES = new Uint8Array([1, 2, 3, 4]);
const V99_CONTENT = 'fsck degraded-store v99 content\n';
// Never a valid zlib stream: 0xff is not a legal deflate CMF byte, so every
// adapter's inflate must reject it on the first byte — the scenario's whole
// point is that all three decoders throw rather than one silently producing
// garbage.
const CORRUPT_ENTRY_BYTES = new Uint8Array(48).fill(0xff);
const UNDECODABLE_LOOSE_BYTES = new Uint8Array(48).fill(0xff);

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/**
 * A structurally healthy, openable pack (valid header, valid idx) whose sole
 * entry's compressed body is not valid deflate data. Distinct from the
 * refused packs above: the pack registry accepts it, so the object's
 * unreadable body is only discovered when the object cache tries to inflate
 * it — the one path that exercises the stored-type recovery's non-loose arm
 * (`pack.readSlice` on a packed-only object with no loose twin).
 */
async function writeCorruptEntryPack(repo: Repository, name: string): Promise<ObjectId> {
  const id = (await repo.ctx.hash.hashHex(
    new TextEncoder().encode(`${name}-object-id-seed`),
  )) as ObjectId;

  const { data, entries } = serializePackfile([
    { type: PACK_ENTRY_TYPE.BLOB, uncompressedSize: 32, compressedData: CORRUPT_ENTRY_BYTES },
  ]);
  const entry = entries[0];
  if (entry === undefined) throw new Error(`${name}: missing pack entry`);

  const trailer = await repo.ctx.hash.hash(data);
  const packBytes = concatBytes(data, trailer);
  const idxBody = serializePackIndex([{ id, crc32: entry.crc32, offset: entry.offset }], trailer);
  const idxBytes = concatBytes(idxBody, hexToBytes(await repo.ctx.hash.hashHex(idxBody)));

  const packBase = `${repo.ctx.layout.gitDir}/objects/pack/${name}`;
  await repo.ctx.fs.write(`${packBase}.pack`, packBytes);
  await repo.ctx.fs.write(`${packBase}.idx`, idxBytes);
  return id;
}

export const fsckDegradedStoreScenario: Scenario<FsckDegradedStoreResult> = {
  name: 'fsck-degraded-store',
  // The reject leg feeds DecompressionStream deliberately undecodable zlib.
  // workerd's decompressor reports that as unhandled promise rejections with
  // no JS frames — internal to the runtime, unreachable by any handler on the
  // consumer side (every read is awaited and the writable side carries a
  // no-op catch; the rejections still surface). All 37 assertions pass; only
  // the stray rejections fail the suite. Same workerd limitation and same
  // remedy as the bundle scenario above. Node/Deno/Bun/browsers stay proven.
  unsupportedRuntimes: ['workers'],
  inputs: { files: [FILES.helloA], author: AUTHOR, message: MESSAGES.seed },
  expected: {
    defaultExitCode: 69,
    packInaccessibleCount: 1,
    packIndexUnusableCount: 1,
    // The corrupt-idx pack's rev-index-unusable finding is ungated — bit 64
    // reports in every mode, including connectivityOnly (unlike bit 4).
    connectivityExitCode: 64,
    // Each faulty oid carries both an 'unreachable' and a 'dangling' finding
    // (dangling is unreachable's in-edge-free subset) — the census is a
    // multiset over both finding types, not a deduplicated set.
    connectivityObjectTypeCensus: ['blob', 'blob', 'unknown', 'unknown'],
    connectivityRejectCode: 'DECOMPRESS_FAILED',
    // Per-arm attribution — a cross-arm swap of types would leave the census
    // above identical, so the two boundary oids are typed by name: the v99
    // pack's id can never be probed (its pack cannot be opened), the corrupt
    // entry's id types from its pack entry header despite its dead body.
    v99IdType: 'unknown',
    corruptEntryIdType: 'blob',
    // Default mode after the undecodable loose object lands: the content
    // pass reports it as one more bad-object (arm 3's corrupt entry is the
    // other) — the loose reject class stays a content error outside
    // connectivityOnly.
    defaultAfterBadObjectCount: 2,
  },
  run: async (repo, inputs) => {
    // Arrange — seed a healthy root commit so the reachable graph is
    // unaffected by any of the three pack-set faults below.
    await repo.init();
    await repo.add(inputs.files.map((file) => file.path));
    await repo.commit({ message: inputs.message, author: inputs.author });

    const packDir = `${repo.ctx.layout.gitDir}/objects/pack`;

    // Arm 1 — corrupt idx with a sibling pack: fails the v2 magic check,
    // excluded before its bytes are ever parsed — contributes no oid either
    // mode, only the ungated rev-index-unusable finding.
    await repo.ctx.fs.write(`${packDir}/fsck-degraded-corrupt.idx`, CORRUPT_IDX_BYTES);
    await repo.ctx.fs.write(`${packDir}/fsck-degraded-corrupt.pack`, ARBITRARY_PACK_BYTES);

    // Arm 2 — header-version-99 pack: the idx parses fine (its oid still
    // enumerates under connectivityOnly, so a refused pack's ids are still
    // reported) but the pack itself cannot be opened, so the type-recovery
    // probe never runs — the type comes back 'unknown'.
    const { id: v99Id } = await writeScenarioPackPair(repo, {
      name: 'fsck-degraded-v99',
      content: V99_CONTENT,
      version: 99,
    });

    // Arm 3 — a healthy, openable pack whose one entry will not inflate.
    const corruptEntryId = await writeCorruptEntryPack(repo, 'fsck-degraded-corrupt-entry');

    // Act — both modes over the 3-arm base fixture, before the reject fault
    // (arm 4) exists, since an abort withholds the whole report.
    const defaultResult = await repo.fsck();
    const connectivityResult = await repo.fsck({ connectivityOnly: true });

    // Arm 4 — one undecodable dangling loose object, added only now: the
    // reject scopes to the unreached set, so introducing it before the
    // census above would have withheld the census entirely.
    const undecodableId = (await repo.ctx.hash.hashHex(
      new TextEncoder().encode('fsck-degraded-store-undecodable-loose'),
    )) as ObjectId;
    await repo.ctx.fs.write(
      `${repo.ctx.layout.gitDir}/objects/${computeLooseObjectPath(undecodableId)}`,
      UNDECODABLE_LOOSE_BYTES,
    );

    let connectivityRejectCode = 'unexpected-success';
    try {
      await repo.fsck({ connectivityOnly: true });
    } catch (error) {
      connectivityRejectCode =
        (error as { data?: { code?: string } }).data?.code ?? 'unexpected-shape';
    }

    // Default mode over the SAME four-arm store: the reject class stays a
    // content error here — the run resolves and reports, never aborts.
    const defaultAfter = await repo.fsck();

    // Assert — project to deterministic fields only, no oids: a sorted
    // census of dangling/unreachable object types rather than a count keyed
    // to a specific oid.
    const connectivityObjectTypeCensus = connectivityResult.findings
      .filter((finding) => finding.type === 'dangling' || finding.type === 'unreachable')
      .map((finding) => finding.objectType)
      .sort();

    const connectivityTypeOf = (id: ObjectId): string => {
      for (const finding of connectivityResult.findings) {
        if ((finding.type === 'dangling' || finding.type === 'unreachable') && finding.id === id) {
          return finding.objectType;
        }
      }
      return 'absent';
    };

    return {
      defaultExitCode: defaultResult.exitCode,
      packInaccessibleCount: defaultResult.findings.filter(
        (finding) => finding.type === 'pack-inaccessible',
      ).length,
      packIndexUnusableCount: defaultResult.findings.filter(
        (finding) => finding.type === 'pack-index-unusable',
      ).length,
      connectivityExitCode: connectivityResult.exitCode,
      connectivityObjectTypeCensus,
      connectivityRejectCode,
      v99IdType: connectivityTypeOf(v99Id),
      corruptEntryIdType: connectivityTypeOf(corruptEntryId),
      defaultAfterBadObjectCount: defaultAfter.findings.filter(
        (finding) => finding.type === 'bad-object',
      ).length,
    };
  },
};
