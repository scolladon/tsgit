// Command → workload registry: the single source of truth for what the
// profiler can capture (10 reads + 3 writes) and how to drive each one.
// Replaces the hardcoded HOT_PATHS triple. `resolveWorkloads` stays a pure
// lookup — the stderr-write + `process.exit(1)` on an unknown command lives
// in the entry point (`profile.ts`), not here, so this module is unit-testable
// without spawning a process.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ObjectId } from '../src/domain/objects/index.ts';
import type { Repository } from '../src/repository.ts';
import type { FixtureSpec, ScaledFixture } from '../test/bench/support/fixture-generator.ts';
import { MEDIUM_FIXTURE } from '../test/bench/support/fixture-generator.ts';
import { withPinnedDate } from './profile-env.ts';
import {
  buildAddScratch,
  buildCommitScratch,
  buildMergeScratch,
  PROFILE_AUTHOR,
  type ScratchRepo,
} from './profile-scratch-repo.ts';

export const READ_ITERATIONS = 100;
// A single blame over a moderately deep file already samples for tens of seconds
// (blame's cost is linear in the blamed file's history depth — see BLAME_TARGET),
// so a couple of iterations give a stable profile; more only add wall-clock.
export const HEAVY_READ_ITERATIONS = 2;
// Write commands run against a TINY scratch repo, so a single iteration is
// sub-millisecond — far below the one-time bundle-load cost that shares the
// profile. Loop enough that the write path (index/tree/object writes) clears
// the noise floor and surfaces real frames rather than an under-sampled blank.
export const WRITE_ITERATIONS = 100;

// Blame walks the full commit history back to where the file was introduced.
// Bench-fixture blobs are add-once / never-modified, so a blob introduced ~200
// commits before HEAD exercises a real history walk (which dominates the profile)
// while terminating in tens of seconds — the root blob (`d0/f0.dat`, ~5000 deep)
// takes minutes to blame.
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
  log: {
    kind: 'read',
    fixture: MEDIUM_FIXTURE,
    run: async (repo) => {
      await repo.log();
    },
  },
  status: {
    kind: 'read',
    fixture: MEDIUM_FIXTURE,
    run: async (repo) => {
      await repo.status();
    },
  },
  'pack-read': {
    kind: 'read',
    fixture: MEDIUM_FIXTURE,
    perIterationRepo: true,
    run: async (repo, fixture) => {
      await repo.primitives.readBlob(fixture.firstBlobId as ObjectId);
    },
  },
  describe: {
    kind: 'read',
    fixture: MEDIUM_FIXTURE,
    setup: (fixtureCwd, env) => ensureNearTag(fixtureCwd, env),
    run: async (repo) => {
      await repo.describe();
    },
  },
  'name-rev': {
    kind: 'read',
    fixture: MEDIUM_FIXTURE,
    setup: (fixtureCwd, env) => ensurePrunableTaggedTip(fixtureCwd, env),
    run: async (repo, _fixture, target) => {
      await repo.nameRev(target as string);
    },
  },
  'rev-parse': {
    kind: 'read',
    fixture: MEDIUM_FIXTURE,
    run: async (repo) => {
      await repo.revParse('HEAD');
    },
  },
  'cat-file': {
    kind: 'read',
    fixture: MEDIUM_FIXTURE,
    run: async (repo, fixture) => {
      await repo.catFile({ ids: [fixture.headCommitId] });
    },
  },
  show: {
    kind: 'read',
    fixture: MEDIUM_FIXTURE,
    run: async (repo) => {
      await repo.show('HEAD');
    },
  },
  diff: {
    kind: 'read',
    fixture: MEDIUM_FIXTURE,
    run: async (repo) => {
      await repo.diff({ from: 'HEAD~1', to: 'HEAD' });
    },
  },
  blame: {
    kind: 'read',
    fixture: MEDIUM_FIXTURE,
    iterations: HEAVY_READ_ITERATIONS,
    run: async (repo) => {
      await repo.blame(BLAME_TARGET);
    },
  },
};

const WRITE_WORKLOADS: Record<string, WriteWorkload> = {
  commit: {
    kind: 'write',
    build: buildCommitScratch,
    run: async (repo) => {
      await repo.commit({ message: 'profile', author: PROFILE_AUTHOR, committer: PROFILE_AUTHOR });
    },
  },
  add: {
    kind: 'write',
    build: buildAddScratch,
    run: async (repo) => {
      await repo.add([], { all: true });
    },
  },
  merge: {
    kind: 'write',
    build: buildMergeScratch,
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
