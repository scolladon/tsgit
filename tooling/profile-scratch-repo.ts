// Write-command scratch-repo factory. Builds a tiny deterministic repo per
// profiler iteration via the library's own structured API — never by
// spawning `git` — so the captured `commit`/`add`/`merge` frames are tsgit's
// own write path, not a child git process. Mirrors the dynamic dist-import
// idiom from `bench-memory.ts` (a strip-only runtime cannot resolve the
// source tree's `.js`-extension imports, so the scratch build runs against
// compiled `dist/`).
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { AuthorIdentity } from '../src/domain/objects/index.ts';
import type { Repository } from '../src/repository.ts';

/** The compiled entry — the source tree is unreachable from a strip-only runtime. */
type OpenRepository = typeof import('../src/index.node.ts').openRepository;

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..');
const DIST_ENTRY = path.join(ROOT, 'dist', 'esm', 'index.node.js');

/** Pinned identity, reused across the module so every scratch commit is byte-stable. */
export const PROFILE_AUTHOR: AuthorIdentity = {
  name: 'profile',
  email: 'profile@tsgit.invalid',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

export type ScratchRepo = {
  readonly cwd: string;
  readonly repo: Repository;
  dispose(): Promise<void>;
};

const loadOpenRepository = async (): Promise<OpenRepository> => {
  const mod = (await import(pathToFileURL(DIST_ENTRY).href)) as {
    openRepository: OpenRepository;
  };
  return mod.openRepository;
};

const disposeScratch = (cwd: string, repo: Repository) => async (): Promise<void> => {
  await repo.dispose();
  await rm(cwd, { recursive: true, force: true });
};

/** `mkdtemp → openRepository → repo.init()` — the shared preamble every factory needs. */
const newScratch = async (_env: NodeJS.ProcessEnv): Promise<ScratchRepo> => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'tsgit-prof-scratch-'));
  const openRepository = await loadOpenRepository();
  const repo = await openRepository({ cwd });
  await repo.init();
  return { cwd, repo, dispose: disposeScratch(cwd, repo) };
};

/** Stages one small file, ready for the measured `commit` call. */
export const buildCommitScratch = async (env: NodeJS.ProcessEnv): Promise<ScratchRepo> => {
  const scratch = await newScratch(env);
  await writeFile(path.join(scratch.cwd, 'a.txt'), 'a\n');
  await scratch.repo.add(['a.txt']);
  return scratch;
};

/** Writes unstaged working-tree files, ready for the measured `add --all` call. */
export const buildAddScratch = async (env: NodeJS.ProcessEnv): Promise<ScratchRepo> => {
  const scratch = await newScratch(env);
  await writeFile(path.join(scratch.cwd, 'a.txt'), 'a\n');
  await writeFile(path.join(scratch.cwd, 'b.txt'), 'b\n');
  return scratch;
};

/**
 * Two branches diverging by one disjoint-file commit each (root → side edits
 * `b.txt`, main edits `a.txt`), HEAD left on `main` — ready for the measured
 * `merge.run({ rev: 'side' })` call to produce a true (non-fast-forward) merge.
 */
export const buildMergeScratch = async (env: NodeJS.ProcessEnv): Promise<ScratchRepo> => {
  const scratch = await newScratch(env);
  const { cwd, repo } = scratch;

  await writeFile(path.join(cwd, 'a.txt'), 'a\n');
  await writeFile(path.join(cwd, 'b.txt'), 'b\n');
  await repo.add(['a.txt', 'b.txt']);
  await repo.commit({ message: 'root', author: PROFILE_AUTHOR, committer: PROFILE_AUTHOR });

  await repo.branch.create({ name: 'side' });
  await repo.checkout({ rev: 'side' });
  await writeFile(path.join(cwd, 'b.txt'), 'b-side\n');
  await repo.add(['b.txt']);
  await repo.commit({ message: 'side', author: PROFILE_AUTHOR, committer: PROFILE_AUTHOR });

  await repo.checkout({ rev: 'main' });
  await writeFile(path.join(cwd, 'a.txt'), 'a-main\n');
  await repo.add(['a.txt']);
  await repo.commit({ message: 'main', author: PROFILE_AUTHOR, committer: PROFILE_AUTHOR });

  return scratch;
};
