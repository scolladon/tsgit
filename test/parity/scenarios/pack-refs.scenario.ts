/**
 * Pack-refs scenario — seeds a commit, a branch and an annotated tag, then
 * exercises `repo.packRefs()` on the files backend. `packedRefCount` and
 * `prunedLooseRefCount` are deterministic counts; the loose `refs/heads`
 * directory entry count after the call is the readback proof that packing
 * actually pruned the files it packed.
 *
 * Surfaces closed:
 *   commands: packRefs
 */
import { AUTHOR, FILES, MESSAGES } from '../fixtures.ts';
import type { Scenario } from './types.ts';

interface PackRefsScenarioResult {
  readonly packedRefCount: number;
  readonly prunedLooseRefCount: number;
  readonly removedOrphanCount: number;
  readonly looseHeadsEntryCount: number;
}

export const packRefsScenario: Scenario<PackRefsScenarioResult> = {
  name: 'pack-refs',
  inputs: { files: [FILES.helloA], author: AUTHOR, message: MESSAGES.seed },
  expected: {
    packedRefCount: 2,
    prunedLooseRefCount: 2,
    removedOrphanCount: 0,
    looseHeadsEntryCount: 0,
  },
  run: async (repo, inputs) => {
    await repo.init();
    await repo.add(['a.txt']);
    await repo.commit({ message: inputs.message, author: inputs.author });
    await repo.branch.create({ name: 'feature' });

    const result = await repo.packRefs();

    const headsDir = `${repo.ctx.layout.gitDir}/refs/heads`;
    const headsEntries = (await repo.ctx.fs.exists(headsDir))
      ? await repo.ctx.fs.readdir(headsDir)
      : [];

    return {
      packedRefCount: result.packedRefCount,
      prunedLooseRefCount: result.prunedLooseRefCount,
      removedOrphanCount: result.removedOrphanCount,
      looseHeadsEntryCount: headsEntries.length,
    };
  },
};
