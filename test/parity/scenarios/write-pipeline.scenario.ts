/**
 * Write-tier pipeline scenario — exercises the low-level write primitives
 * by composing them by hand: hash the blob via writeObject (already
 * covered by hash-interop), assemble a tree via writeTree, and synthesize
 * the commit via createCommit. The resulting commit id is the assertion
 * spine; if any writer mutates the byte format, the id diverges across
 * adapters and the parity test fails.
 *
 * Surfaces closed (per 19.5a):
 *   primitives: writeTree, createCommit
 */
import { FILE_MODE, type ObjectId } from '../../../src/domain/objects/index.ts';
import { AUTHOR, FILES, MESSAGES } from '../fixtures.ts';
import type { Scenario } from './types.ts';

interface WritePipelineResult {
  readonly blobId: string;
  readonly treeId: string;
  readonly commitId: string;
}

const BLOB_MODE = FILE_MODE.REGULAR;

export const writePipelineScenario: Scenario<WritePipelineResult> = {
  name: 'write-pipeline',
  inputs: { files: [FILES.helloA], author: AUTHOR, message: MESSAGES.seed },
  expected: {
    blobId: '74614c9224e259adae80b04d6a0e3f483407324d',
    treeId: '3a854a72e3d92d84858c79cdb3030c430e38cd86',
    commitId: '87863a6f57aeedd577100911fadbc21ff1062bec',
  },
  run: async (repo, inputs) => {
    await repo.init();

    const file = inputs.files[0];
    if (file === undefined) throw new Error('write-pipeline: missing seed file');
    const blobBytes = new TextEncoder().encode(file.content);
    // writeObject treats an empty `id` as "no declared id" (see
    // `hasDeclaredId` in tooling/../validators.ts) and computes the SHA from
    // the serialised content; supplying any non-empty branded ObjectId would
    // trigger OBJECT_HASH_MISMATCH unless we pre-hashed the bytes ourselves,
    // which the public API does not expose. The cast is the documented
    // contract, mirrored by test/browser/hash-interop.spec.ts.
    const blobId = await repo.primitives.writeObject({
      type: 'blob',
      id: '' as ObjectId,
      content: blobBytes,
    });

    const treeId = await repo.primitives.writeTree([
      { mode: BLOB_MODE, name: file.path, id: blobId },
    ]);

    const commitId = await repo.primitives.createCommit({
      tree: treeId,
      parents: [],
      author: inputs.author,
      committer: inputs.author,
      message: inputs.message,
    });

    return { blobId, treeId, commitId };
  },
};
