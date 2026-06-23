/**
 * Fsck scenario — seeds a single root commit then writes one orphan blob
 * (not referenced by any tree or commit) so `repo.fsck()` returns a
 * non-empty, deterministic FsckResult: one `root` finding for the root
 * commit and one `dangling` finding for the orphan blob. Runs identically
 * on Node, memory, and browser (OPFS) adapters; the projection maps to
 * finding-type counts so oids never appear in the assertion.
 *
 * Surfaces closed:
 *   commands: fsck
 */
import type { ObjectId } from '../../../src/domain/objects/index.ts';
import { AUTHOR, FILES, MESSAGES } from '../fixtures.ts';
import type { Scenario } from './types.ts';

interface FsckScenarioResult {
  readonly danglingCount: number;
  readonly missingCount: number;
  readonly rootCount: number;
  readonly exitCode: number;
}

export const fsckScenario: Scenario<FsckScenarioResult> = {
  name: 'fsck',
  inputs: { files: [FILES.helloA], author: AUTHOR, message: MESSAGES.seed },
  expected: {
    // One orphan blob written via writeObject — not pointed to by any tree.
    danglingCount: 1,
    // The null OID (0000…) recorded in the reflog's initial entry is a root
    // that does not exist in the object store → one `missing` finding.
    missingCount: 1,
    // The root commit produces one `root` finding.
    rootCount: 1,
    // EXIT_MISSING (bit 2) fires because of the reflog null-OID `missing`.
    exitCode: 2,
  },
  run: async (repo, inputs) => {
    // Arrange — seed a healthy root commit so refs are established
    await repo.init();
    await repo.add(inputs.files.map((file) => file.path));
    await repo.commit({ message: inputs.message, author: inputs.author });

    // Write an orphan blob that has no in-edges from any tree/commit.
    // `id: '' as ObjectId` signals writeObject to compute the SHA itself
    // (documented contract, mirrored by write-pipeline.scenario.ts).
    await repo.primitives.writeObject({
      type: 'blob',
      id: '' as ObjectId,
      content: new TextEncoder().encode('orphan blob\n'),
    });

    // Act
    const result = await repo.fsck();

    // Assert — project to counts so oids remain out of the assertion spine
    return {
      danglingCount: result.findings.filter((f) => f.type === 'dangling').length,
      missingCount: result.findings.filter((f) => f.type === 'missing').length,
      rootCount: result.findings.filter((f) => f.type === 'root').length,
      exitCode: result.exitCode,
    };
  },
};
