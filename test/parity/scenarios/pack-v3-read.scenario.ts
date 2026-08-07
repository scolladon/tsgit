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
import { PACK_HEADER_SIZE } from '../../../src/domain/storage/pack-entry.ts';
import { AUTHOR, FILES, MESSAGES } from '../fixtures.ts';
import { writeScenarioPackPair } from './pack-pair.ts';
import type { Scenario } from './types.ts';

interface PackV3ReadResult {
  readonly probedVersion: number;
  readonly readBackContent: string;
}

const PACKED_BLOB_CONTENT = 'packed via v3\n';

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

    // Version 3 is the fixture's only anomaly — the pack is otherwise
    // exactly what the domain writers emit.
    const { id, packBase } = await writeScenarioPackPair(repo, {
      name: 'pack-parity-v3',
      content: PACKED_BLOB_CONTENT,
      version: 3,
    });

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
