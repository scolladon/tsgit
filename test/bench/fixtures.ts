/**
 * Benchmark fixtures. Builds synthetic repos under the OS tmpdir on first
 * import, then re-uses them for every `*.bench.ts` file in the same vitest run.
 *
 * We deliberately seed with the Node shim (not isomorphic-git) so the fixture
 * exercises our own loose-object storage, then both libraries read the same
 * resulting on-disk layout. That isolates the benchmark to read-path
 * performance rather than write-path differences.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { openRepository } from '../../src/index.node.js';

export interface BenchRepo {
  readonly cwd: string;
  readonly headCommitId: string;
  readonly firstBlobId: string;
  readonly cleanup: () => Promise<void>;
}

const AUTHOR = {
  name: 'Bench',
  email: 'bench@tsgit.dev',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
} as const;

export const setupSmallRepo = async (opts: { commits?: number } = {}): Promise<BenchRepo> => {
  const commits = opts.commits ?? 50;
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'tsgit-bench-small-'));
  const repo = await openRepository({ cwd });

  let firstBlobId = '';
  let headCommitId = '';
  try {
    await repo.init();
    for (let i = 0; i < commits; i += 1) {
      const name = `f${i.toString().padStart(4, '0')}.txt`;
      await writeFile(path.join(cwd, name), `payload ${i}\n`);
      await repo.add([name]);
      const result = await repo.commit({
        message: `commit ${i}`,
        author: { ...AUTHOR, timestamp: AUTHOR.timestamp + i },
      });
      headCommitId = result.id;
      if (i === 0) {
        const tree = await repo.primitives.readTree(result.tree);
        const blobEntry = tree.entries.find((entry) => entry.name === name);
        if (blobEntry !== undefined) firstBlobId = blobEntry.id;
      }
    }
  } finally {
    await repo.dispose();
  }

  if (firstBlobId === '' || headCommitId === '') {
    throw new Error('benchmark fixture failed to capture seed ids');
  }

  return {
    cwd,
    headCommitId,
    firstBlobId,
    cleanup: () => rm(cwd, { recursive: true, force: true }),
  };
};

export const setupDirtyWorkingTree = async (
  base: BenchRepo,
  modifiedFiles: number,
): Promise<void> => {
  for (let i = 0; i < modifiedFiles; i += 1) {
    const name = `f${i.toString().padStart(4, '0')}.txt`;
    await writeFile(path.join(base.cwd, name), `payload ${i} dirty\n`);
  }
};

// Helper for benches that want a freshly-mkdir'd .git/info path etc.
export const ensureCacheDir = async (root: string): Promise<string> => {
  const dir = path.join(root, '.cache', 'tsgit-bench');
  await mkdir(dir, { recursive: true });
  return dir;
};
