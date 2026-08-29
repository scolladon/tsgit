// Command → workload registry: the single source of truth for what the
// profiler can capture (11 reads + 3 writes) and how to drive each one.
// Replaces the hardcoded HOT_PATHS triple. `resolveWorkloads` stays a pure
// lookup — the stderr-write + `process.exit(1)` on an unknown command lives
// in the entry point (`profile.ts`), not here, so this module is unit-testable
// without spawning a process.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ObjectId } from '../src/domain/objects/index.ts';
import type { Repository } from '../src/repository.ts';
import type { FixtureSpec, ScaledFixture } from '../test/bench/support/fixture-generator.ts';
import {
  MEDIUM_FIXTURE,
  MEDIUM_FIXTURE_WITH_COMMIT_GRAPH,
} from '../test/bench/support/fixture-generator.ts';
import { withPinnedDate } from './profile-env.ts';
import {
  buildAddScratch,
  buildCommitScratch,
  buildMergeScratch,
  PROFILE_AUTHOR,
  type ScratchRepo,
} from './profile-scratch-repo.ts';

export const READ_ITERATIONS = 100;
// Write commands run against a TINY scratch repo, so a single iteration is
// sub-millisecond — far below the one-time bundle-load cost that shares the
// profile. Loop enough that the write path (index/tree/object writes) clears
// the noise floor and surfaces real frames rather than an under-sampled blank.
export const WRITE_ITERATIONS = 100;

// Blame walks the full commit history back to where the file was introduced.
// Bench-fixture blobs are add-once / never-modified, so a blob introduced ~200
// commits before HEAD exercises a real history walk (which dominates the
// profile) while staying fast enough (~0.1s/iteration measured) to loop —
// the root blob (`d0/f0.dat`, ~5000 deep) is far too slow to loop for this.
const BLAME_TARGET = 'd37/f19200.dat';

const NEAR_TAG_DISTANCE = 10;
const DESCRIBE_NEAR_TAG = 'profile-describe-near';
const NAME_REV_NEAR_TAG = 'profile-name-rev-near';
const DAY_AND_A_BIT = 90_000;

export type ReadWorkload = {
  readonly kind: 'read';
  readonly fixture: FixtureSpec;
  readonly setup?: (fixtureCwd: string, env: NodeJS.ProcessEnv) => Promise<unknown>;
  readonly run: (repo: Repository, fixture: ScaledFixture, target: unknown) => Promise<void>;
  readonly perIterationRepo?: boolean;
  readonly iterations?: number;
};

export type WriteWorkload = {
  readonly kind: 'write';
  readonly build: (env: NodeJS.ProcessEnv) => Promise<ScratchRepo>;
  readonly run: (repo: Repository, scratch: ScratchRepo) => Promise<void>;
  readonly iterations?: number;
  /**
   * False keeps this workload's build interleaved with its `run` — one
   * iteration at a time, as the profiler's write driver did before hoisting
   * existed — relying on `SETUP_FRAMES` to classify the per-iteration build
   * cost instead. Defaults to true: every scratch is built before any is
   * run, so the sampled run loop is command work only.
   */
  readonly hoistBuild?: boolean;
};

export type ProfileWorkload = ReadWorkload | WriteWorkload;

const execFileAsync = promisify(execFile);

/** Spawn `git` with the given args under an env-isolated cwd; returns trimmed stdout. */
const gitOut = async (
  cwd: string,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
): Promise<string> => {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], { env });
  return stdout.trim();
};

/** `git tag -f -a <name> HEAD~10` — idempotent, never moves a fixture branch. */
const ensureNearTag = async (fixtureCwd: string, env: NodeJS.ProcessEnv): Promise<void> => {
  await execFileAsync(
    'git',
    [
      '-C',
      fixtureCwd,
      'tag',
      '-f',
      '-a',
      DESCRIBE_NEAR_TAG,
      '-m',
      DESCRIBE_NEAR_TAG,
      `HEAD~${NEAR_TAG_DISTANCE}`,
    ],
    { env },
  );
};

/**
 * Anchors an annotated tag on a deterministic dangling commit dated a
 * day-and-a-bit past the fixture tip, without moving any fixture branch —
 * mirrors `name-rev.bench.ts`'s `ensurePrunableTaggedTip`. Returns the
 * target oid (`name-rev`'s run target).
 */
const ensurePrunableTaggedTip = async (
  fixtureCwd: string,
  env: NodeJS.ProcessEnv,
): Promise<string> => {
  const tipDate = Number(await gitOut(fixtureCwd, ['log', '-1', '--format=%ct'], env));
  const tree = await gitOut(fixtureCwd, ['log', '-1', '--format=%T'], env);
  const parent = await gitOut(fixtureCwd, ['rev-parse', 'HEAD'], env);
  const datedEnv = withPinnedDate(env, tipDate + DAY_AND_A_BIT);
  const target = await gitOut(
    fixtureCwd,
    ['commit-tree', tree, '-p', parent, '-m', NAME_REV_NEAR_TAG],
    datedEnv,
  );
  await execFileAsync(
    'git',
    ['-C', fixtureCwd, 'tag', '-f', '-a', NAME_REV_NEAR_TAG, '-m', NAME_REV_NEAR_TAG, target],
    { env: datedEnv },
  );
  return target;
};

const READ_WORKLOADS: Record<string, ReadWorkload> = {
  // 350 ticks measured @ READ_ITERATIONS (100) — below the floor.
  log: {
    kind: 'read',
    fixture: MEDIUM_FIXTURE,
    iterations: 200, // 685 ticks measured
    run: async (repo) => {
      await repo.log();
    },
  },
  // Samples the commit-graph read path, which no other workload reaches:
  // MEDIUM_FIXTURE has no commit-graph, so `log`'s walk above always takes
  // the plain object-read path. `gen-bench-fixture.ts` cannot pre-warm this
  // fixture (it only knows the medium/large/delta-chain/many-pack labels),
  // so the first run here pays fixture generation. 322 ticks measured @
  // READ_ITERATIONS (100) — below the floor.
  'log-commit-graph': {
    kind: 'read',
    fixture: MEDIUM_FIXTURE_WITH_COMMIT_GRAPH,
    iterations: 200, // 659 ticks measured
    run: async (repo) => {
      await repo.log();
    },
  },
  status: {
    kind: 'read',
    fixture: MEDIUM_FIXTURE,
    // 1316 ticks measured @ READ_ITERATIONS (100) — already clears the floor.
    run: async (repo) => {
      await repo.status();
    },
  },
  // 8 ticks measured @ READ_ITERATIONS (100) — each iteration pays a full
  // `openRepository`, so ticks/iteration is far lower than a reused-handle
  // read; needs a much larger multiple to clear the floor.
  'pack-read': {
    kind: 'read',
    fixture: MEDIUM_FIXTURE,
    perIterationRepo: true,
    iterations: 8000, // 590 ticks measured
    run: async (repo, fixture) => {
      await repo.primitives.readBlob(fixture.firstBlobId as ObjectId);
    },
  },
  // 62 ticks measured @ 2000 iterations — below the floor.
  describe: {
    kind: 'read',
    fixture: MEDIUM_FIXTURE,
    iterations: 20_000, // 581 ticks measured
    setup: (fixtureCwd, env) => ensureNearTag(fixtureCwd, env),
    run: async (repo) => {
      await repo.describe();
    },
  },
  // 45 ticks measured @ 2000 iterations — below the floor.
  'name-rev': {
    kind: 'read',
    fixture: MEDIUM_FIXTURE,
    iterations: 30_000, // 913 ticks measured
    setup: (fixtureCwd, env) => ensurePrunableTaggedTip(fixtureCwd, env),
    run: async (repo, _fixture, target) => {
      await repo.nameRev(target as string);
    },
  },
  // 12 ticks measured @ 2000 iterations, 268 ticks measured @ 100 000
  // iterations — `revParse('HEAD')` is a single ref read, so ticks/iteration
  // is tiny and the total sits close enough to the floor that sampling
  // noise alone can push a run under it (448–604 ticks measured @ 220 000
  // iterations across repeat runs); a wider margin absorbs that noise.
  'rev-parse': {
    kind: 'read',
    fixture: MEDIUM_FIXTURE,
    iterations: 350_000, // 900 ticks measured
    run: async (repo) => {
      await repo.revParse('HEAD');
    },
  },
  // 6 ticks measured @ 2000 iterations — below the floor.
  'cat-file': {
    kind: 'read',
    fixture: MEDIUM_FIXTURE,
    iterations: 200_000, // 1042 ticks measured
    run: async (repo, fixture) => {
      await repo.catFile({ ids: [fixture.headCommitId] });
    },
  },
  // 1 tick measured @ READ_ITERATIONS (100) — below the floor.
  show: {
    kind: 'read',
    fixture: MEDIUM_FIXTURE,
    iterations: 60_000, // 532 ticks measured
    run: async (repo) => {
      await repo.show('HEAD');
    },
  },
  // 31 ticks measured @ 2000 iterations — below the floor.
  diff: {
    kind: 'read',
    fixture: MEDIUM_FIXTURE,
    iterations: 40_000, // 544 ticks measured
    run: async (repo) => {
      await repo.diff({ from: 'HEAD~1', to: 'HEAD' });
    },
  },
  // 15 ticks measured @ 2 iterations, 465 ticks measured @ 80 iterations
  // (~0.1s/iteration on this fixture) — a moderate raise (not a smaller
  // fixture) clears the floor within a few seconds.
  blame: {
    kind: 'read',
    fixture: MEDIUM_FIXTURE,
    iterations: 100, // 609 ticks measured
    run: async (repo) => {
      await repo.blame(BLAME_TARGET);
    },
  },
};

const WRITE_WORKLOADS: Record<string, WriteWorkload> = {
  // 10 ticks measured @ WRITE_ITERATIONS (100) — below the floor.
  commit: {
    kind: 'write',
    build: buildCommitScratch,
    iterations: 5000, // 844 ticks measured
    run: async (repo) => {
      await repo.commit({ message: 'profile', author: PROFILE_AUTHOR, committer: PROFILE_AUTHOR });
    },
  },
  // 11 ticks measured @ WRITE_ITERATIONS (100), 475 ticks measured @ 5000
  // iterations — below the floor.
  add: {
    kind: 'write',
    build: buildAddScratch,
    hoistBuild: false,
    iterations: 6000, // 607 ticks measured
    run: async (repo) => {
      await repo.add([], { all: true });
    },
  },
  // 80 ticks measured @ WRITE_ITERATIONS (100) — below the floor.
  merge: {
    kind: 'write',
    build: buildMergeScratch,
    iterations: 800, // 697 ticks measured
    run: async (repo) => {
      await repo.merge.run({
        rev: 'side',
        fastForward: 'never',
        author: PROFILE_AUTHOR,
        committer: PROFILE_AUTHOR,
      });
    },
  },
};

export const WORKLOADS: Record<string, ProfileWorkload> = {
  ...READ_WORKLOADS,
  ...WRITE_WORKLOADS,
};

export class UnknownCommandError extends Error {
  constructor(cmd: string) {
    const known = Object.keys(WORKLOADS).sort().join(', ');
    super(`usage: profile <cmd> (one of: ${known}) — got '${cmd}'`);
    this.name = 'UnknownCommandError';
  }
}

export const resolveWorkloads = (
  cmd: string | undefined,
): ReadonlyArray<[string, ProfileWorkload]> => {
  if (cmd === undefined) {
    return Object.entries(WORKLOADS);
  }
  const entry = WORKLOADS[cmd];
  if (entry === undefined) {
    throw new UnknownCommandError(cmd);
  }
  return [[cmd, entry]];
};
