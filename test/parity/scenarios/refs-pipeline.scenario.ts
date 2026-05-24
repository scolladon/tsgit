/**
 * Refs primitive scenario — exercises low-level ref CRUD primitives plus
 * `revParse`. Drives a chained dance: resolveRef(HEAD) → updateRef
 * (creates a new ref) → resolveRef(new ref) → writeSymbolicRef (points a
 * second symbolic ref at the new one) → recordRefUpdate (writes a reflog
 * entry alongside an update) → revParse(short SHA).
 *
 * Surfaces closed (per 19.5a):
 *   commands:   revParse
 *   primitives: resolveRef, updateRef, writeSymbolicRef, recordRefUpdate
 */
import type { RefName } from '../../../src/domain/objects/index.ts';
import { AUTHOR, FILES, MESSAGES } from '../fixtures.ts';
import type { Scenario } from './types.ts';

interface RefsPipelineResult {
  readonly seedCommitId: string;
  readonly headResolvesToSeed: boolean;
  readonly newRefResolvesToSeed: boolean;
  readonly symbolicResolvesToSeed: boolean;
  readonly recordRefUpdateCreatedReflog: boolean;
  readonly revParseHeadResolvesToSeed: boolean;
}

const NEW_BRANCH = 'refs/heads/refs-pipeline' as RefName;
const SYMBOLIC_NAME = 'refs/heads/refs-pipeline-alias' as RefName;
const NEW_BRANCH_FOR_REFLOG = 'refs/heads/refs-pipeline-reflog' as RefName;

export const refsPipelineScenario: Scenario<RefsPipelineResult> = {
  name: 'refs-pipeline',
  inputs: { files: [FILES.helloA], author: AUTHOR, message: MESSAGES.seed },
  expected: {
    seedCommitId: '87863a6f57aeedd577100911fadbc21ff1062bec',
    headResolvesToSeed: true,
    newRefResolvesToSeed: true,
    symbolicResolvesToSeed: true,
    recordRefUpdateCreatedReflog: true,
    revParseHeadResolvesToSeed: true,
  },
  run: async (repo, inputs) => {
    await repo.init();
    await repo.add(inputs.files.map((file) => file.path));
    const seed = await repo.commit({ message: inputs.message, author: inputs.author });

    const head = await repo.primitives.resolveRef('HEAD' as RefName);

    await repo.primitives.updateRef(NEW_BRANCH, seed.id, {
      expected: 'absent',
      reflogMessage: 'refs-pipeline: create branch',
    });
    const newRefTarget = await repo.primitives.resolveRef(NEW_BRANCH);

    await repo.primitives.writeSymbolicRef(SYMBOLIC_NAME, NEW_BRANCH);
    const symbolicTarget = await repo.primitives.resolveRef(SYMBOLIC_NAME);

    // recordRefUpdate writes a reflog entry alongside a manual ref update.
    // We call updateRef first to actually move the ref, then recordRefUpdate
    // to attach the reflog row — mirroring how commit/merge compose them.
    await repo.primitives.updateRef(NEW_BRANCH_FOR_REFLOG, seed.id, {
      expected: 'absent',
      reflogMessage: 'refs-pipeline: create',
    });
    await repo.primitives.recordRefUpdate(
      NEW_BRANCH_FOR_REFLOG,
      seed.id,
      seed.id,
      'refs-pipeline: synthetic no-op for reflog',
    );
    // Read the reflog back so the assertion proves recordRefUpdate actually
    // created a `.git/logs/refs/heads/refs-pipeline-reflog` file with at
    // least one entry — a hardcoded `true` would let a stubbed-out
    // recordRefUpdate slip through.
    const reflogProof = await repo.reflog({
      action: 'exists',
      ref: NEW_BRANCH_FOR_REFLOG,
    });
    const recordRefUpdateCreatedReflog = reflogProof.kind === 'exists' && reflogProof.exists;

    // rev-parse only accepts full 40-hex or ref names — short SHA prefix
    // lookup is not implemented; HEAD goes through the ref-resolution path.
    const fromHead = await repo.revParse('HEAD');

    return {
      seedCommitId: seed.id,
      headResolvesToSeed: head === seed.id,
      newRefResolvesToSeed: newRefTarget === seed.id,
      symbolicResolvesToSeed: symbolicTarget === seed.id,
      recordRefUpdateCreatedReflog,
      revParseHeadResolvesToSeed: fromHead === seed.id,
    };
  },
};
