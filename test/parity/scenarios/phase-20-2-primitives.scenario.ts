/**
 * Phase 20.2 standalone primitives — single bundled parity scenario that
 * exercises every new primitive in one flow so Node + Memory + Browser
 * drivers all close the surface gaps in one go.
 *
 * Surfaces closed (per 19.5a):
 *   primitives: hashBlob, isIgnored, stageEntry, unstageEntry, setEntryFlags
 */
import type { FilePath } from '../../../src/domain/objects/object-id.ts';
import { AUTHOR } from '../fixtures.ts';
import type { Scenario } from './types.ts';

interface Phase202Result {
  readonly hashedOid: string;
  readonly writtenOidMatchesHashed: boolean;
  readonly ignoredCount: number;
  readonly ignoredSourceKind: string;
  readonly notIgnoredCount: number;
  readonly stagedPathPresentInIndex: boolean;
  readonly stagedEntryStage: number;
  readonly afterUnstageEntryCount: number;
  readonly skipWorktreeAfterFlagFlip: boolean;
}

const sampleContent = new Uint8Array([0x68, 0x69]); // 'hi'

export const phase202PrimitivesScenario: Scenario<Phase202Result> = {
  name: 'phase-20-2-primitives',
  // Pre-seed `.gitignore` so `isIgnored` finds rules on the working tree
  // without first staging+committing them. The parity driver writes these
  // files to the workdir before `run` executes.
  inputs: {
    files: [
      { path: '.gitignore', content: '*.log\n' },
      { path: 'a.txt', content: 'hello\n' },
    ],
    author: AUTHOR,
    message: 'unused (no commit in this scenario)',
  },
  expected: {
    // SHA-1 of the canonical blob serialisation `blob 2\0hi`.
    hashedOid: '32f95c0d1244a78b2be1bab8de17906fabb2c4a8',
    writtenOidMatchesHashed: true,
    ignoredCount: 1,
    ignoredSourceKind: 'gitignore',
    notIgnoredCount: 1,
    stagedPathPresentInIndex: true,
    stagedEntryStage: 0,
    afterUnstageEntryCount: 0,
    skipWorktreeAfterFlagFlip: true,
  },
  run: async (repo, _inputs) => {
    await repo.init();

    // hashBlob in both modes; OID must be identical and write: true must
    // file the loose object (the OID itself proves that path on readback,
    // but the OID equality also gates `serializeAndHash` sharing).
    const hashedOid = await repo.primitives.hashBlob(sampleContent);
    const writtenOid = await repo.primitives.hashBlob(sampleContent, { write: true });

    // The driver wrote `.gitignore` to the working tree pre-run.
    const ignoreResults = await repo.primitives.isIgnored([
      { path: 'app.log' as FilePath },
      { path: 'README.md' as FilePath },
    ]);
    const ignoredCount = ignoreResults.filter((r) => r.ignored).length;
    const ignoredSourceKind = ignoreResults.find((r) => r.ignored)?.source?.kind ?? '';
    const notIgnoredCount = ignoreResults.filter((r) => !r.ignored).length;

    // Stage a fresh entry, flip a flag, unstage.
    const staged = await repo.primitives.stageEntry('staged.txt' as FilePath, {
      content: new Uint8Array([1, 2, 3]),
    });
    let index = await repo.primitives.readIndex();
    const stagedPathPresentInIndex = index.entries.some((e) => e.path === 'staged.txt');

    const flagged = await repo.primitives.setEntryFlags('staged.txt' as FilePath, {
      skipWorktree: true,
    });

    await repo.primitives.unstageEntry('staged.txt' as FilePath);
    index = await repo.primitives.readIndex();
    const afterUnstageEntryCount = index.entries.filter((e) => e.path === 'staged.txt').length;

    return {
      hashedOid,
      writtenOidMatchesHashed: hashedOid === writtenOid,
      ignoredCount,
      ignoredSourceKind,
      notIgnoredCount,
      stagedPathPresentInIndex,
      stagedEntryStage: staged.flags.stage,
      afterUnstageEntryCount,
      skipWorktreeAfterFlagFlip: flagged.flags.skipWorktree,
    };
  },
};
