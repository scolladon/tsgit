/**
 * Bench-native scratch-repo factory for the write benches (`commit`, `add`,
 * `merge`). Builds a tiny deterministic repo per bench iteration via the
 * library's own structured API — never by spawning `git` — through the
 * bench-resolvable `../../src/index.node.ts` entry (unlike the profiling
 * factory, no dynamic dist-import is needed here: `test:bench` runs against
 * the source tree directly). Mirrors `tooling/profile-scratch-repo.ts`'s
 * three topologies.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { AuthorIdentity } from '../../../src/domain/objects/index.js';
import { openRepository } from '../../../src/index.node.js';
import type { Repository } from '../../../src/repository.js';

/** Pinned identity, reused across the module so every scratch commit is byte-stable. */
export const SCRATCH_AUTHOR: AuthorIdentity = {
  name: 'bench',
  email: 'bench@tsgit.invalid',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

export type ScratchRepo = {
  readonly cwd: string;
  readonly repo: Repository;
  dispose(): Promise<void>;
};

const disposeScratch = (cwd: string, repo: Repository) => async (): Promise<void> => {
  await repo.dispose();
  await rm(cwd, { recursive: true, force: true });
};

/** `mkdtemp → openRepository → repo.init()` — the shared preamble every builder needs. */
const newScratch = async (): Promise<ScratchRepo> => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'tsgit-bench-scratch-'));
  const repo = await openRepository({ cwd });
  await repo.init();
  return { cwd, repo, dispose: disposeScratch(cwd, repo) };
};

/** Stages one small file, ready for the measured `commit` call. */
export const buildCommitScratch = async (): Promise<ScratchRepo> => {
  const scratch = await newScratch();
  await writeFile(path.join(scratch.cwd, 'a.txt'), 'a\n');
  await scratch.repo.add(['a.txt']);
  return scratch;
};

/** Writes unstaged working-tree files, ready for the measured `add --all` call. */
export const buildAddScratch = async (): Promise<ScratchRepo> => {
  const scratch = await newScratch();
  await writeFile(path.join(scratch.cwd, 'a.txt'), 'a\n');
  await writeFile(path.join(scratch.cwd, 'b.txt'), 'b\n');
  return scratch;
};

/**
 * Two branches diverging by one disjoint-file commit each (root → side edits
 * `b.txt`, main edits `a.txt`), HEAD left on `main` — ready for the measured
 * `merge.run({ rev: 'side' })` call to produce a true (non-fast-forward) merge.
 */
export const buildMergeScratch = async (): Promise<ScratchRepo> => {
  const scratch = await newScratch();
  const { cwd, repo } = scratch;

  await writeFile(path.join(cwd, 'a.txt'), 'a\n');
  await writeFile(path.join(cwd, 'b.txt'), 'b\n');
  await repo.add(['a.txt', 'b.txt']);
  await repo.commit({ message: 'root', author: SCRATCH_AUTHOR, committer: SCRATCH_AUTHOR });

  await repo.branch.create({ name: 'side' });
  await repo.checkout({ rev: 'side' });
  await writeFile(path.join(cwd, 'b.txt'), 'b-side\n');
  await repo.add(['b.txt']);
  await repo.commit({ message: 'side', author: SCRATCH_AUTHOR, committer: SCRATCH_AUTHOR });

  await repo.checkout({ rev: 'main' });
  await writeFile(path.join(cwd, 'a.txt'), 'a-main\n');
  await repo.add(['a.txt']);
  await repo.commit({ message: 'main', author: SCRATCH_AUTHOR, committer: SCRATCH_AUTHOR });

  return scratch;
};
