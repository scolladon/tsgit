/**
 * Degraded pack-set scenario — three arms on node, memory, and browser (OPFS)
 * adapters alike:
 *   1. a corrupt `.idx` (fails the v2 magic check) with a sibling `.pack` —
 *      skipped by the scan layer's domain-level refusal;
 *   2. an orphaned `.idx` (no sibling `.pack` by name) — excluded before its
 *      bytes are ever parsed;
 *   3. a registered pack whose `.pack` vanishes after the scan — the header
 *      probe then raises each adapter's OWN port-level FILE_NOT_FOUND (node
 *      via mapErrno, memory via its explicit throw, browser via
 *      resolveFileHandle), which the lookup layer must degrade to
 *      OBJECT_NOT_FOUND identically everywhere.
 * None of the three may fail an unrelated loose-object read.
 *
 * Surfaces closed:
 *   primitives: readObject (scan-layer skip + lookup-layer io-fault skip)
 *   commands: fsck
 */

import { getPackRegistry } from '../../../src/application/primitives/read-object.ts';
import { AUTHOR, FILES, MESSAGES } from '../fixtures.ts';
import { writeScenarioPackPair } from './pack-pair.ts';
import type { Scenario } from './types.ts';

interface PackDegradedIdxResult {
  readonly readBackType: string;
  readonly fsckExitCode: number;
  readonly fsckMissingCount: number;
  readonly fsckRootCount: number;
  readonly packsRegisteredBeforeVanish: number;
  readonly vanishedReadCode: string;
}

const VANISHED_BLOB_CONTENT = 'packed then vanished\n';

// Header (8) + fanout table (1024) is the parser's minimum-size gate; this
// buffer clears it so the failure is specifically the v2 magic check, not a
// truncation short-circuit. All-zero bytes never collide with the real
// 0xff744f63 magic.
const CORRUPT_IDX_BYTES = new Uint8Array(1072);
const ORPHAN_IDX_BYTES = new Uint8Array(1072);
const ARBITRARY_PACK_BYTES = new Uint8Array([1, 2, 3, 4]);

export const packDegradedIdxScenario: Scenario<PackDegradedIdxResult> = {
  name: 'pack-degraded-idx',
  inputs: { files: [FILES.helloA], author: AUTHOR, message: MESSAGES.seed },
  expected: {
    readBackType: 'commit',
    fsckExitCode: 0,
    fsckMissingCount: 0,
    fsckRootCount: 1,
    packsRegisteredBeforeVanish: 1,
    vanishedReadCode: 'OBJECT_NOT_FOUND',
  },
  run: async (repo, inputs) => {
    // Arrange — seed a healthy root commit; its tree/blob and the commit
    // itself are loose objects that must keep reading despite bad packs.
    await repo.init();
    await repo.add(inputs.files.map((file) => file.path));
    const seed = await repo.commit({ message: inputs.message, author: inputs.author });

    const packDir = `${repo.ctx.layout.gitDir}/objects/pack`;

    // Corrupt idx with a sibling pack — parsePackIndex rejects the bad magic
    // (INVALID_PACK_INDEX), so the scan layer skips this pack entirely.
    await repo.ctx.fs.write(`${packDir}/pack-degraded-corrupt.idx`, CORRUPT_IDX_BYTES);
    await repo.ctx.fs.write(`${packDir}/pack-degraded-corrupt.pack`, ARBITRARY_PACK_BYTES);

    // Orphaned idx — no sibling pack by name, excluded before its bytes are
    // ever parsed.
    await repo.ctx.fs.write(`${packDir}/pack-degraded-orphan.idx`, ORPHAN_IDX_BYTES);

    // Act (arms 1+2) — the seed commit still reads, and fsck walks a healthy
    // graph; both run before the vanished-pack arm so their scan generation
    // never contains it.
    const object = await repo.primitives.readObject(seed.id);
    const result = await repo.fsck();

    // Arm 3 — a valid pack pair whose .pack vanishes after the scan. The
    // blob's loose copy is removed so the pack is its only source.
    const vanishedId = await writeScenarioPackPair(repo, {
      name: 'pack-degraded-vanish',
      content: VANISHED_BLOB_CONTENT,
    });
    const vanishBase = `${packDir}/pack-degraded-vanish`;

    // A fresh generation registers the vanish pack (arms 1+2 stay excluded)
    // WITHOUT probing its header — all() touches only the parsed idx.
    const registry = getPackRegistry(repo.ctx);
    registry.refresh();
    const packsRegisteredBeforeVanish = (await registry.all()).length;

    // The .pack disappears between scan and open — the next lookup's header
    // probe must surface the adapter's own FILE_NOT_FOUND and degrade it.
    await repo.ctx.fs.rm(`${vanishBase}.pack`);
    let vanishedReadCode = 'unexpected-success';
    try {
      await repo.primitives.readObject(vanishedId);
    } catch (error) {
      vanishedReadCode = (error as { data?: { code?: string } }).data?.code ?? 'unexpected-shape';
    }

    // Assert — project to deterministic fields only, no oid
    return {
      readBackType: object.type,
      fsckExitCode: result.exitCode,
      fsckMissingCount: result.findings.filter((f) => f.type === 'missing').length,
      fsckRootCount: result.findings.filter((f) => f.type === 'root').length,
      packsRegisteredBeforeVanish,
      vanishedReadCode,
    };
  },
};
