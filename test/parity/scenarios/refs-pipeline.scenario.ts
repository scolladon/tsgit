/**
 * Refs primitive scenario — exercises low-level ref CRUD primitives plus
 * `revParse`. Drives a chained dance: resolveRef(HEAD) → updateRef
 * (creates a new ref and its reflog) → resolveRef(new ref) → revParse(HEAD).
 *
 * Surfaces closed (per 19.5a):
 *   commands:   revParse
 *   primitives: resolveRef, updateRef
 */
import type { RefName } from '../../../src/domain/objects/index.ts';
import { AUTHOR, FILES, MESSAGES } from '../fixtures.ts';
import type { Scenario } from './types.ts';

interface RefsPipelineResult {
  readonly seedCommitId: string;
  readonly headResolvesToSeed: boolean;
  readonly newRefResolvesToSeed: boolean;
  readonly updateRefCreatedReflog: boolean;
  readonly revParseHeadResolvesToSeed: boolean;
}

const NEW_BRANCH = 'refs/heads/refs-pipeline' as RefName;
const NEW_BRANCH_FOR_REFLOG = 'refs/heads/refs-pipeline-reflog' as RefName;

export const refsPipelineScenario: Scenario<RefsPipelineResult> = {
  name: 'refs-pipeline',
  inputs: { files: [FILES.helloA], author: AUTHOR, message: MESSAGES.seed },
  expected: {
    seedCommitId: 'fa8b886eee0d470d870e786878657cac05d686e6',
    headResolvesToSeed: true,
    newRefResolvesToSeed: true,
    updateRefCreatedReflog: true,
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

    // updateRef writes the ref and records its reflog atomically — the
    // coherent public ref-write surface (a decoupled reflog write is not
    // exposed). Creating a fresh branch here must file its reflog.
    await repo.primitives.updateRef(NEW_BRANCH_FOR_REFLOG, seed.id, {
      expected: 'absent',
      reflogMessage: 'refs-pipeline: create',
    });
    // Read the reflog back so the assertion proves updateRef actually
    // created a `.git/logs/refs/heads/refs-pipeline-reflog` file with at
    // least one entry — a hardcoded `true` would let a stubbed-out
    // reflog writer slip through.
    const reflogProof = await repo.reflog({
      action: 'exists',
      ref: NEW_BRANCH_FOR_REFLOG,
    });
    const updateRefCreatedReflog = reflogProof.kind === 'exists' && reflogProof.exists;

    // rev-parse only accepts full 40-hex or ref names — short SHA prefix
    // lookup is not implemented; HEAD goes through the ref-resolution path.
    const fromHead = await repo.revParse('HEAD');

    return {
      seedCommitId: seed.id,
      headResolvesToSeed: head === seed.id,
      newRefResolvesToSeed: newRefTarget === seed.id,
      updateRefCreatedReflog,
      revParseHeadResolvesToSeed: fromHead === seed.id,
    };
  },
};
