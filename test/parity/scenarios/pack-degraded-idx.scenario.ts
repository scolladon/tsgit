/**
 * Degraded pack-set scenario — plants two bad packs next to a healthy loose
 * repo: a corrupt `.idx` (fails the v2 magic check) with a sibling `.pack`,
 * and an orphaned `.idx` (no sibling `.pack` at all — a pack is registered
 * only when its `.pack` file exists by name). Both must be *degraded out* at
 * scan time — never surfaced as findings and never allowed to fail an
 * unrelated loose-object read — on node, memory, and browser (OPFS) adapters
 * alike.
 *
 * Surfaces closed:
 *   primitives: readObject (through the pack registry's scan-layer skip)
 *   commands: fsck
 */
import { AUTHOR, FILES, MESSAGES } from '../fixtures.ts';
import type { Scenario } from './types.ts';

interface PackDegradedIdxResult {
  readonly readBackType: string;
  readonly fsckExitCode: number;
  readonly fsckMissingCount: number;
  readonly fsckRootCount: number;
}

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

    // Act — the seed commit still reads, and fsck walks a healthy graph.
    const object = await repo.primitives.readObject(seed.id);
    const result = await repo.fsck();

    // Assert — project to deterministic fields only, no oid
    return {
      readBackType: object.type,
      fsckExitCode: result.exitCode,
      fsckMissingCount: result.findings.filter((f) => f.type === 'missing').length,
      fsckRootCount: result.findings.filter((f) => f.type === 'root').length,
    };
  },
};
