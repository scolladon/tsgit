/**
 * Pack-objects scenario — seeds a single commit and exercises
 * `repo.packObjects({ wants: ['HEAD'] })` at its default (bitmap) tier.
 * `packId` is stable per tier only (object order inside the pack differs by
 * tier and is never git's own order), so the golden value never compares
 * it — only `objectCount` and facts read back from the written `.idx`.
 *
 * Surfaces closed:
 *   commands: packObjects
 */
import { allObjectIds, parsePackIndex } from '../../../src/domain/storage/pack-index.ts';
import { AUTHOR, FILES, MESSAGES } from '../fixtures.ts';
import type { Scenario } from './types.ts';

interface PackObjectsScenarioResult {
  readonly objectCount: number;
  readonly idxObjectCount: number;
  /** The pack directory holds exactly the `.pack` + `.idx` this call wrote —
   *  no `.rev`, no bitmap. */
  readonly packDirEntryCount: number;
}

export const packObjectsScenario: Scenario<PackObjectsScenarioResult> = {
  name: 'pack-objects',
  inputs: { files: [FILES.helloA], author: AUTHOR, message: MESSAGES.seed },
  expected: { objectCount: 3, idxObjectCount: 3, packDirEntryCount: 2 },
  run: async (repo, inputs) => {
    await repo.init();
    await repo.add(['a.txt']);
    await repo.commit({ message: inputs.message, author: inputs.author });

    const result = await repo.packObjects({ wants: ['HEAD'] });

    const packDir = `${repo.ctx.layout.gitDir}/objects/pack`;
    const dirEntries = await repo.ctx.fs.readdir(packDir);
    const idxBytes = await repo.ctx.fs.read(`${packDir}/pack-${result.packId}.idx`);
    const parsedIdx = parsePackIndex(idxBytes);

    return {
      objectCount: result.objectCount,
      idxObjectCount: allObjectIds(parsedIdx).length,
      packDirEntryCount: dirEntries.length,
    };
  },
};
