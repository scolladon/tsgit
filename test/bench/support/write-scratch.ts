/**
 * Bench-native scratch-repo factory for the write benches (`commit`, `add`,
 * `merge`) and the whitespace drop-pass fixture. Builds a deterministic repo
 * via the library's own structured API through the bench-resolvable
 * `../../src/index.node.ts` entry (unlike the profiling factory, no dynamic
 * dist-import is needed here: `test:bench` runs against the source tree
 * directly). Mirrors `tooling/profile-scratch-repo.ts`'s three topologies.
 * `git` is spawned only for the optional packed whitespace-pairs variant
 * (`git repack -ad`), always with an isolated, scrubbed environment.
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

import type { AuthorIdentity } from '../../../src/domain/objects/index.js';
import { openRepository } from '../../../src/index.node.js';
import type { Repository } from '../../../src/repository.js';

const execFileAsync = promisify(execFile);

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

/**
 * `fileCount` freshly committed small files, all loose (never packed) — the
 * reachable-loose-object shape `maintenance`'s `gc` task repacks on a plain
 * (non-partial-clone) repository. One flat commit, not `fileCount` separate
 * ones: gc's cost is driven by object count, not commit-graph depth.
 */
export const buildManyLooseObjectsScratch = async (fileCount: number): Promise<ScratchRepo> => {
  const scratch = await newScratch();
  const { cwd, repo } = scratch;
  for (let i = 0; i < fileCount; i += 1) {
    await writeFile(path.join(cwd, `f${i.toString().padStart(6, '0')}.txt`), `payload ${i}\n`);
  }
  await repo.add([], { all: true });
  await repo.commit({ message: 'seed', author: SCRATCH_AUTHOR, committer: SCRATCH_AUTHOR });
  return scratch;
};

/** Writes unstaged working-tree files, ready for the measured `add --all` call. */
export const buildAddScratch = async (): Promise<ScratchRepo> => {
  const scratch = await newScratch();
  await writeFile(path.join(scratch.cwd, 'a.txt'), 'a\n');
  await writeFile(path.join(scratch.cwd, 'b.txt'), 'b\n');
  return scratch;
};

const NESTED_DIR_COUNT = 8;
const PAYLOAD_REPEAT = 8;

/**
 * Many unstaged files spread across nested directories — enough independent
 * hash-and-write units for `add --all`'s bounded staging pool to overlap
 * work. The fixture writes land in parallel so the build costs wall-clock
 * proportional to the pool, not one round trip per file.
 */
export const buildAddManyScratch = async (fileCount: number): Promise<ScratchRepo> => {
  const scratch = await newScratch();
  const { cwd } = scratch;
  await Promise.all(
    Array.from({ length: NESTED_DIR_COUNT }, (_, dir) =>
      mkdir(path.join(cwd, `dir${dir}`, 'nested'), { recursive: true }),
    ),
  );
  await Promise.all(
    Array.from({ length: fileCount }, (_, i) => {
      const dir = `dir${i % NESTED_DIR_COUNT}`;
      const leaf = i % 2 === 0 ? dir : path.join(dir, 'nested');
      return writeFile(
        path.join(cwd, leaf, `f${i.toString().padStart(4, '0')}.txt`),
        `payload ${i}\n`.repeat(PAYLOAD_REPEAT),
      );
    }),
  );
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

const WHITESPACE_PAIRS_DIRECTORY_DIVISOR = 50;

/** ~50-byte Java class source, deterministic per index. */
const javaClassSource = (i: number): string =>
  `package a;\npublic class C${i} {\n  int f${i} = ${i};\n}\n`;

/**
 * Whitespace-only rewrite: doubles every single space. Never moves a
 * non-space byte, so it is a pure `-w` / `ignoreWhitespace` change under
 * every mode.
 */
const doubleSpaces = (source: string): string => source.replace(/ /g, '  ');

// Isolated, deliberately non-existent HOME so a spawned `git repack` never
// reads (or is steered by) the developer's global/system config — same
// isolation class as the interop suite's `runGitEnv()`, reimplemented here
// because bench code does not import test/integration helpers.
const ISOLATED_GIT_HOME = path.join(os.tmpdir(), 'tsgit-bench-scratch-nonexistent-home');

/**
 * Env for spawning `git repack`: every `GIT_*` var stripped (a husky hook or
 * a parent `git` process can export `GIT_DIR`, which overrides `-C`), plus
 * an isolated `HOME` and `GIT_CONFIG_NOSYSTEM=1` so ambient config can never
 * change the repack's observable behaviour.
 */
const scratchGitEnv = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('GIT_')) continue;
    if (value !== undefined) env[key] = value;
  }
  env.HOME = ISOLATED_GIT_HOME;
  env.GIT_CONFIG_NOSYSTEM = '1';
  return env;
};

const repackScratch = async (cwd: string): Promise<void> => {
  await execFileAsync('git', ['-C', cwd, 'repack', '-ad', '--quiet'], { env: scratchGitEnv() });
};

export interface WhitespacePairsScratchOptions {
  /** File count, spread over `fileCount / 50` directories. Default 2,500. */
  readonly fileCount?: number;
  /** Repack (`git repack -ad`) after the second commit — the realistic
   *  megarepo shape; spawns `git`. Default `false` (loose, as committed). */
  readonly packed?: boolean;
}

/**
 * A scratch repo of `fileCount` small Java-class files spread over
 * `fileCount / 50` directories, committed once, then rewritten
 * whitespace-only (every space doubled) and committed again — the
 * many-small-modified-pairs shape the whitespace drop-pass predicate is
 * built for. Built through the library's own API into a fresh `mkdtemp`
 * directory; never touches the shared `~/.cache/tsgit-bench` fixture other
 * benches share.
 */
export const buildWhitespacePairsScratch = async (
  options: WhitespacePairsScratchOptions = {},
): Promise<ScratchRepo> => {
  const fileCount = options.fileCount ?? 2_500;
  const dirCount = Math.max(1, Math.floor(fileCount / WHITESPACE_PAIRS_DIRECTORY_DIVISOR));
  const scratch = await newScratch();
  const { cwd, repo } = scratch;
  const relPath = (i: number): string => path.join(`d${i % dirCount}`, `C${i}.java`);

  for (let dir = 0; dir < dirCount; dir++) {
    await mkdir(path.join(cwd, `d${dir}`), { recursive: true });
  }
  for (let i = 0; i < fileCount; i++) {
    await writeFile(path.join(cwd, relPath(i)), javaClassSource(i));
  }
  await repo.add([], { all: true });
  await repo.commit({ message: 'initial', author: SCRATCH_AUTHOR, committer: SCRATCH_AUTHOR });

  for (let i = 0; i < fileCount; i++) {
    await writeFile(path.join(cwd, relPath(i)), doubleSpaces(javaClassSource(i)));
  }
  await repo.add([], { all: true });
  await repo.commit({
    message: 'whitespace-only',
    author: SCRATCH_AUTHOR,
    committer: SCRATCH_AUTHOR,
  });

  if (options.packed === true) await repackScratch(cwd);
  return scratch;
};
