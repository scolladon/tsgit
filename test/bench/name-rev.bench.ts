/**
 * Tiered bench: `repo.nameRev()` naming a tagged commit dated more than one
 * day after the deep fixture history — pins the date-cutoff pruning win
 * (O(distance) reads instead of walking the full history per ref; the
 * fixture's commits are seconds apart, so only a >1-day-newer target makes
 * the cutoff fire) at each fixture tier. tsgit-only: isomorphic-git has no
 * name-rev. Date-cutoff pruning keeps cost O(distance) at every tier.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, realpath } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { createCommit } from '../../src/application/primitives/create-commit.js';
import { updateRef } from '../../src/application/primitives/update-ref.js';
import { writeObject } from '../../src/application/primitives/write-object.js';
import { writeTree } from '../../src/application/primitives/write-tree.js';
import type { Blob, ObjectId, RefName } from '../../src/domain/objects/index.js';
import { FILE_MODE } from '../../src/domain/objects/index.js';
import { treeEntry } from '../../src/domain/objects/tree.js';
import { openRepository } from '../../src/index.node.js';
import type { Context } from '../../src/ports/context.js';
import { benchScenario } from './support/bench-dsl.js';
import { removeSync } from './support/fixture-scratch.js';
import { MULTI_TIERS, tieredScenario } from './support/tiered-bench.js';

const execFileAsync = promisify(execFile);

const NEAR_TAG = 'bench-name-rev-near';
const DAY_AND_A_BIT = 90_000;

const benchEnv = (): NodeJS.ProcessEnv => {
  const scrubbed = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
  );
  return {
    ...scrubbed,
    GIT_AUTHOR_NAME: 'bench',
    GIT_AUTHOR_EMAIL: 'bench@tsgit.invalid',
    GIT_COMMITTER_NAME: 'bench',
    GIT_COMMITTER_EMAIL: 'bench@tsgit.invalid',
    GIT_CONFIG_NOSYSTEM: '1',
  };
};

const gitOut = async (
  cwd: string,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
): Promise<string> => {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], { env });
  return stdout.trim();
};

/**
 * Anchors an annotated tag on a deterministic dangling commit dated a
 * day-and-a-bit past the fixture tip, WITHOUT moving any fixture branch (the
 * fixture is cache-keyed and shared across bench files). Naming this commit
 * puts every fixture commit below the cutoff, so the walk prunes instead of
 * flooding. `commit-tree` with pinned dates yields the same oid every run —
 * idempotent, no fixture growth.
 */
const ensurePrunableTaggedTip = async (cwd: string): Promise<string> => {
  const env = benchEnv();
  const tipDate = Number(await gitOut(cwd, ['log', '-1', '--format=%ct'], env));
  const tree = await gitOut(cwd, ['log', '-1', '--format=%T'], env);
  const parent = await gitOut(cwd, ['rev-parse', 'HEAD'], env);
  const date = `${tipDate + DAY_AND_A_BIT} +0000`;
  const datedEnv = { ...env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
  const target = await gitOut(cwd, ['commit-tree', tree, '-p', parent, '-m', NEAR_TAG], datedEnv);
  await execFileAsync('git', ['-C', cwd, 'tag', '-f', '-a', NEAR_TAG, '-m', NEAR_TAG, target], {
    env: datedEnv,
  });
  return target;
};

await tieredScenario(
  MULTI_TIERS,
  'When name-rev() names a commit a day newer than the deep history, Then the walk stops at the date cutoff',
  async (fixture) => {
    const target = await ensurePrunableTaggedTip(fixture.cwd);
    const repo = await openRepository({ cwd: fixture.cwd });
    return {
      teardown: () => repo.dispose(),
      sut: async (): Promise<void> => {
        await repo.nameRev(target);
      },
    };
  },
);

// ---------------------------------------------------------------------------
// Many-tag arm: an in-process scratch repository, never the shared tiered
// cache (which is read-only for benches) and never `git`.
// ---------------------------------------------------------------------------

const MANY_TAGS_COMMITS = 200;

const MANY_TAGS_AUTHOR = {
  name: 'Bench',
  email: 'bench@tsgit.dev',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
} as const;

const manyTagsEnc = new TextEncoder();

interface ManyTagsFixture {
  readonly cwd: string;
  readonly headCommitId: ObjectId;
}

/**
 * A `MANY_TAGS_COMMITS`-generation linear history, one lightweight tag per
 * commit (`refs/tags/bench-tag-<n>`, written directly through the `Context`
 * — never `git`) spread over the whole history. Every object is written
 * loose. Returns the tip commit id.
 */
async function buildManyTagsHistory(ctx: Context): Promise<ObjectId> {
  let parent: ObjectId | undefined;
  let headCommitId: ObjectId | undefined;
  for (let index = 0; index < MANY_TAGS_COMMITS; index += 1) {
    const blob: Blob = {
      type: 'blob',
      id: '' as ObjectId,
      content: manyTagsEnc.encode(`many-tags-blob-${index}`),
    };
    const blobId = await writeObject(ctx, blob);
    const treeId = await writeTree(ctx, [treeEntry(FILE_MODE.REGULAR, 'f.txt', blobId)]);
    const commitId = await createCommit(ctx, {
      tree: treeId,
      parents: parent === undefined ? [] : [parent],
      author: MANY_TAGS_AUTHOR,
      committer: MANY_TAGS_AUTHOR,
      message: `many-tags-bench-${index}`,
    });
    await updateRef(ctx, `refs/tags/bench-tag-${index}` as RefName, commitId, {
      reflogMessage: `bench tag ${index}`,
    });
    parent = commitId;
    headCommitId = commitId;
  }

  if (headCommitId === undefined) {
    throw new Error('many-tags fixture: chain produced no commits');
  }

  return headCommitId;
}

const setupManyTagsFixture = async (): Promise<ManyTagsFixture> => {
  const cwd = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-bench-many-tags-')));
  const bootstrap = await openRepository({ cwd });
  await bootstrap.init();
  await bootstrap.dispose();

  const ctx = createNodeContext({ workDir: cwd, hooks: false, command: false, ssh: false });
  const headCommitId = await buildManyTagsHistory(ctx);

  return { cwd, headCommitId };
};

benchScenario(
  `Given an in-process repository with ${MANY_TAGS_COMMITS} commits and ${MANY_TAGS_COMMITS} lightweight tags spread over the history`,
  'When name-rev() names a commit under 200 tags, Then measure tsgit',
  async () => {
    const fixture = await setupManyTagsFixture();
    const repo = await openRepository({ cwd: fixture.cwd });
    return {
      teardown: async (): Promise<void> => {
        removeSync(fixture.cwd);
        await repo.dispose();
      },
      sut: async (): Promise<void> => {
        await repo.nameRev(fixture.headCommitId);
      },
    };
  },
);
