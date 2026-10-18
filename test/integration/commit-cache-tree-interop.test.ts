/**
 * Cross-tool interop — what `commit` leaves in the index. A twin pair is built
 * identically by git; one step runs in canonical git on the peer and in tsgit
 * on ours. The `TREE` payload bytes, the extension set, whether the index was
 * rewritten, the commit's tree and the refusal must agree, and `git fsck`
 * must pass on ours.
 *
 * @proves
 *   surface:        commit
 *   bucket:         cross-tool-interop
 *   unique:         commit maintains the index TREE, excludes intent-to-add entries and refuses as git does
 *   interopSurface: index
 */
import { chmod, mkdir, stat, utimes, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { commit } from '../../src/application/commands/commit.js';
import { readIndex } from '../../src/application/primitives/read-index.js';
import type { TsgitError } from '../../src/domain/error.js';
import type { CacheTreeEntry } from '../../src/domain/git-index/index-entry.js';
import { parseCacheTree } from '../../src/domain/git-index/index-parser.js';
import type { AuthorIdentity } from '../../src/domain/objects/index.js';
import type { Context } from '../../src/ports/context.js';
import {
  GIT_AVAILABLE,
  git,
  makePeerPair,
  type PeerPair,
  runGit,
  runGitEnvWithoutGlobalConfig,
  tryRunGitWithExit,
} from './interop-helpers.js';

type Format = 'sha1' | 'sha256';

const DIGEST_LENGTH: Record<Format, 20 | 32> = { sha1: 20, sha256: 32 };
const FILES = ['a/x/f', 'b/f', 'c/f', 'top', 'bb/f', 'zzz/f'] as const;
const PAST_SECONDS = 10;
const TOUCH_SECONDS = 5;
const ROW_TIMEOUT_MS = 180_000;
const GIT_REFUSED = 1;
const GIT_DIED = 128;
const identity: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

const secondsAgo = (seconds: number): Date => new Date(Date.now() - seconds * 1000);

const write = async (dir: string, file: string, body: string): Promise<void> => {
  await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
  await writeFile(path.join(dir, file), body);
};

const touchForward = async (dir: string, file: string): Promise<void> => {
  const when = secondsAgo(TOUCH_SECONDS);
  await utimes(path.join(dir, file), when, when);
};

interface Fixture {
  readonly files: ReadonlyArray<string>;
  readonly committed: boolean;
}

const BASE: Fixture = { files: FILES, committed: true };

const buildFixture = async (dir: string, format: Format, fixture: Fixture): Promise<void> => {
  runGit(['init', '-q', '-b', 'main', `--object-format=${format}`, dir]);
  git(dir, 'config', 'user.name', 'Ada');
  git(dir, 'config', 'user.email', 'ada@example.com');
  git(dir, 'config', 'gc.auto', '0');
  git(dir, 'config', 'maintenance.auto', 'false');
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'config', 'merge.conflictStyle', 'merge');
  const past = secondsAgo(PAST_SECONDS);
  for (const file of fixture.files) {
    await write(dir, file, `${file} body\n`);
    await utimes(path.join(dir, file), past, past);
  }
  git(dir, 'add', '-A');
  if (fixture.committed) git(dir, 'commit', '-q', '-m', 'one');
};

const contextFor = (dir: string, format: Format): Context =>
  createNodeContext({ workDir: dir, ...(format === 'sha256' ? { algorithm: 'sha256' } : {}) });

const indexPathOf = (dir: string): string => path.join(dir, '.git', 'index');

const inodeOf = async (dir: string): Promise<number> => (await stat(indexPathOf(dir))).ino;

const extensionsOf = async (
  dir: string,
  format: Format,
): Promise<ReadonlyMap<string, Uint8Array>> => {
  const index = await readIndex(contextFor(dir, format));
  return new Map(index.extensions.map((extension) => [extension.signature, extension.data]));
};

const countsOf = (node: CacheTreeEntry, prefix = ''): ReadonlyArray<string> => [
  `${prefix}:${node.entryCount}/${node.children.length}`,
  ...node.children.flatMap((child) => countsOf(child, `${prefix}/${child.path}`)),
];

const chainOf = (extensions: ReadonlyMap<string, Uint8Array>, format: Format): string => {
  const data = extensions.get('TREE');
  return data === undefined
    ? 'none'
    : countsOf(parseCacheTree(data, DIGEST_LENGTH[format])).join(' ');
};

const headTree = (dir: string): string => git(dir, 'rev-parse', 'HEAD^{tree}').trim();

interface Step {
  /** Applied with git to both twins before the step. */
  readonly prepare?: (dir: string, format: Format) => Promise<void>;
  readonly gitArgs: ReadonlyArray<string>;
  readonly gitEnv?: NodeJS.ProcessEnv;
  readonly gitExit: number;
  readonly tsgit: (ctx: Context) => Promise<unknown>;
  /** The code tsgit refuses with; absent when the commit succeeds. */
  readonly refusal?: string;
  readonly rewritten: boolean;
}

interface Row {
  readonly title: string;
  readonly fixture?: Fixture;
  readonly steps: ReadonlyArray<Step>;
}

interface Snapshot {
  readonly chain: string;
  readonly tree: Uint8Array | undefined;
  readonly extensionNames: ReadonlyArray<string>;
  readonly headTree: string | undefined;
  readonly committedPaths: string | undefined;
}

interface StepOutcome {
  readonly peer: Snapshot;
  readonly ours: Snapshot;
  readonly peerExit: number;
  readonly oursCode: string | undefined;
  readonly peerRewritten: boolean;
  readonly oursRewritten: boolean;
}

const snapshot = async (dir: string, format: Format): Promise<Snapshot> => {
  const extensions = await extensionsOf(dir, format);
  const hasHead = tryRunGitWithExit(['-C', dir, 'rev-parse', '--verify', '-q', 'HEAD']);
  return {
    chain: chainOf(extensions, format),
    tree: extensions.get('TREE'),
    extensionNames: [...extensions.keys()].sort(),
    headTree: hasHead.exitCode === 0 ? headTree(dir) : undefined,
    committedPaths:
      hasHead.exitCode === 0 ? git(dir, 'ls-tree', '-r', '--name-only', 'HEAD') : undefined,
  };
};

const codeOf = async (attempt: Promise<unknown>): Promise<string | undefined> => {
  try {
    await attempt;
    return undefined;
  } catch (error) {
    return (error as TsgitError).data.code;
  }
};

const playStep = async (pair: PeerPair, format: Format, step: Step): Promise<StepOutcome> => {
  for (const dir of [pair.peer, pair.ours]) await step.prepare?.(dir, format);
  const peerBefore = await inodeOf(pair.peer);
  const oursBefore = await inodeOf(pair.ours);
  const peerExit = tryRunGitWithExit(['-C', pair.peer, ...step.gitArgs], {
    ...(step.gitEnv === undefined ? {} : { env: step.gitEnv }),
  }).exitCode;
  const oursCode = await codeOf(step.tsgit(contextFor(pair.ours, format)));
  return {
    peer: await snapshot(pair.peer, format),
    ours: await snapshot(pair.ours, format),
    peerExit,
    oursCode,
    peerRewritten: (await inodeOf(pair.peer)) !== peerBefore,
    oursRewritten: (await inodeOf(pair.ours)) !== oursBefore,
  };
};

const commitWith =
  (
    message: string,
    options: { readonly allowEmpty?: boolean; readonly anonymous?: boolean } = {},
  ) =>
  (ctx: Context): Promise<unknown> =>
    commit(ctx, {
      message,
      ...(options.anonymous === true ? {} : { author: identity, committer: identity }),
      ...(options.allowEmpty === true ? { allowEmpty: true } : {}),
    });

const withIndexWrite = (overrides: Partial<Step> & Pick<Step, 'gitArgs' | 'tsgit'>): Step => ({
  gitExit: 0,
  rewritten: true,
  ...overrides,
});

const addAfter =
  (...edits: ReadonlyArray<readonly [string, string]>) =>
  async (dir: string): Promise<void> => {
    for (const [file, body] of edits) await write(dir, file, body);
    git(dir, 'add', ...edits.map(([file]) => file));
  };

const COMMIT_ONE = ['commit', '-q', '-m', 'step'] as const;
const STEP_TREE_CHANGED = withIndexWrite({
  prepare: addAfter(['b/f', '22\n']),
  gitArgs: COMMIT_ONE,
  tsgit: commitWith('step'),
});

const refusedNothing = (prepare?: Step['prepare'], rewritten = true): Step =>
  withIndexWrite({
    ...(prepare === undefined ? {} : { prepare }),
    gitArgs: COMMIT_ONE,
    gitExit: GIT_REFUSED,
    tsgit: commitWith('step'),
    refusal: 'NOTHING_TO_COMMIT',
    rewritten,
  });

const conflictOn = async (dir: string): Promise<void> => {
  git(dir, 'checkout', '-q', '-b', 'side');
  await write(dir, 'a/x/f', 'side\n');
  git(dir, 'commit', '-q', '-am', 'side');
  git(dir, 'checkout', '-q', 'main');
  await write(dir, 'a/x/f', 'main\n');
  git(dir, 'commit', '-q', '-am', 'main');
  tryRunGitWithExit(['-C', dir, 'merge', 'side']);
};

const withoutIdentity = async (dir: string): Promise<void> => {
  git(dir, 'config', '--unset', 'user.name');
  git(dir, 'config', '--unset', 'user.email');
  git(dir, 'config', 'user.useConfigOnly', 'true');
  await write(dir, 'b/f', '22\n');
  git(dir, 'add', 'b/f');
};

const HOOK_MODE = 0o755;
const RESTAGING_HOOK = '#!/bin/sh\necho hook >> c/f\ngit add c/f\n';

const withRestagingHook = async (dir: string): Promise<void> => {
  await addAfter(['b/f', '22\n'])(dir);
  const hookPath = path.join(dir, '.git', 'hooks', 'pre-commit');
  await write(dir, '.git/hooks/pre-commit', RESTAGING_HOOK);
  await chmod(hookPath, HOOK_MODE);
};

const ANONYMOUS_ENV = ((): NodeJS.ProcessEnv => {
  const env = runGitEnvWithoutGlobalConfig();
  for (const key of [
    'GIT_AUTHOR_NAME',
    'GIT_AUTHOR_EMAIL',
    'GIT_COMMITTER_NAME',
    'GIT_COMMITTER_EMAIL',
  ]) {
    delete env[key];
  }
  return env;
})();

const SETTLED_ROWS: ReadonlyArray<Row> = [
  {
    title: 'commit of a fresh index (no TREE yet)',
    fixture: { files: FILES, committed: false },
    steps: [withIndexWrite({ gitArgs: ['commit', '-q', '-m', 'one'], tsgit: commitWith('one') })],
  },
  { title: 'commit after add b/f changed content', steps: [STEP_TREE_CHANGED] },
  {
    title: 'commit refused as nothing to commit after a stat-only re-add',
    steps: [
      refusedNothing(async (dir) => {
        await touchForward(dir, 'b/f');
        git(dir, 'add', 'b/f');
      }),
    ],
  },
  {
    title: 'commit refused for an empty message after add c/f',
    steps: [
      withIndexWrite({
        prepare: addAfter(['c/f', '33\n']),
        gitArgs: ['commit', '-q', '-m', ''],
        gitExit: GIT_REFUSED,
        tsgit: commitWith(''),
        refusal: 'EMPTY_COMMIT_MESSAGE',
      }),
    ],
  },
  {
    title: 'commit refused as nothing to commit when only an intent-to-add entry differs',
    steps: [
      refusedNothing(async (dir) => {
        await write(dir, 'a/x/n', '7\n');
        git(dir, 'add', '-N', 'a/x/n');
      }),
    ],
  },
  {
    title: 'commit after rm -r zzz',
    steps: [
      withIndexWrite({
        prepare: async (dir) => {
          git(dir, 'rm', '-q', '-r', 'zzz');
        },
        gitArgs: COMMIT_ONE,
        tsgit: commitWith('step'),
      }),
    ],
  },
  {
    title: 'commit --allow-empty over a fully valid TREE (no index write)',
    steps: [
      withIndexWrite({
        gitArgs: ['commit', '-q', '--allow-empty', '-m', 'step'],
        tsgit: commitWith('step', { allowEmpty: true }),
        rewritten: false,
      }),
    ],
  },
  {
    title: 'commit refused as nothing to commit over a fully valid TREE (no index write)',
    steps: [refusedNothing(undefined, false)],
  },
  {
    title: 'commit refused over unmerged entries (no index write)',
    steps: [
      withIndexWrite({
        prepare: conflictOn,
        gitArgs: ['commit', '-q', '-m', 'step'],
        gitExit: GIT_DIED,
        tsgit: commitWith('step'),
        refusal: 'MERGE_HAS_CONFLICTS',
        rewritten: false,
      }),
    ],
  },
  {
    title: 'commit while index.lock exists',
    steps: [
      withIndexWrite({
        prepare: (dir) => write(dir, '.git/index.lock', ''),
        gitArgs: ['commit', '-q', '--allow-empty', '-m', 'step'],
        gitExit: GIT_DIED,
        tsgit: commitWith('step', { allowEmpty: true }),
        refusal: 'RESOURCE_LOCKED',
        rewritten: false,
      }),
    ],
  },
  {
    title: 'commit with no identity over an invalid TREE (the index is written first)',
    steps: [
      withIndexWrite({
        prepare: withoutIdentity,
        gitArgs: ['-c', 'user.useConfigOnly=true', 'commit', '-q', '-m', 'step'],
        gitEnv: ANONYMOUS_ENV,
        gitExit: GIT_DIED,
        tsgit: commitWith('step', { anonymous: true }),
        refusal: 'AUTHOR_UNCONFIGURED',
      }),
    ],
  },
  {
    title: 'add, commit, add on a four-file fixture',
    fixture: { files: ['a/x/f', 'b/f', 'c/f', 'top'], committed: true },
    steps: [
      withIndexWrite({
        prepare: addAfter(['b/f', '22\n']),
        gitArgs: COMMIT_ONE,
        tsgit: commitWith('step'),
      }),
      withIndexWrite({
        prepare: addAfter(['c/f', '33\n']),
        gitArgs: ['commit', '-q', '-m', 'second'],
        tsgit: commitWith('second'),
      }),
    ],
  },
];

const HOOK_ROW: Row = {
  title: 'commit whose pre-commit hook re-stages a file',
  steps: [
    withIndexWrite({
      prepare: withRestagingHook,
      gitArgs: COMMIT_ONE,
      tsgit: commitWith('step'),
    }),
  ],
};

const ITA_ROW: Row = {
  title: 'commit with a staged file and an intent-to-add entry',
  fixture: { files: ['a/f', 'b'], committed: true },
  steps: [
    withIndexWrite({
      prepare: async (dir) => {
        await write(dir, 'b', '3\n');
        await write(dir, 'a/n', 'new\n');
        git(dir, 'add', 'b');
        git(dir, 'add', '-N', 'a/n');
      },
      gitArgs: ['commit', '-q', '-m', 'm'],
      tsgit: commitWith('m'),
    }),
  ],
};

const expectOutcome = (step: Step, outcome: StepOutcome): void => {
  expect(outcome.peerExit).toBe(step.gitExit);
  expect(outcome.oursCode).toBe(step.refusal);
  expect(outcome.ours.chain).toBe(outcome.peer.chain);
  expect(outcome.ours.tree).toEqual(outcome.peer.tree);
  expect(outcome.ours.extensionNames).toEqual(outcome.peer.extensionNames);
  expect([outcome.peerRewritten, outcome.oursRewritten]).toEqual([step.rewritten, step.rewritten]);
  expect(outcome.ours.headTree).toBe(outcome.peer.headTree);
  expect(outcome.ours.committedPaths).toBe(outcome.peer.committedPaths);
};

const describeRow = (row: Row, format: Format = 'sha1'): void => {
  describe(`Given a twin pair built by git (${format})`, () => {
    describe(`When ${row.title} runs in git and in tsgit`, () => {
      let pair: PeerPair;
      const outcomes: StepOutcome[] = [];

      beforeAll(async () => {
        pair = await makePeerPair('commit-cache-tree');
        for (const dir of [pair.peer, pair.ours]) {
          await buildFixture(dir, format, row.fixture ?? BASE);
        }
        for (const step of row.steps) outcomes.push(await playStep(pair, format, step));
      }, ROW_TIMEOUT_MS);

      afterAll(async () => {
        await pair.dispose();
      });

      it('Then the TREE bytes, extensions, rewrite, refusal and commit tree agree with git', () => {
        // Arrange + Assert
        row.steps.forEach((step, index) => {
          expectOutcome(step, outcomes[index] as StepOutcome);
        });
      });

      it('Then git fsck exits 0 on the tsgit twin', () => {
        // Arrange + Assert
        expect(tryRunGitWithExit(['-C', pair.ours, 'fsck']).exitCode).toBe(0);
      });
    });
  });
};

describe.skipIf(!GIT_AVAILABLE)('commit cache-tree interop', () => {
  for (const row of SETTLED_ROWS) describeRow(row);
  describeRow(SETTLED_ROWS[0] as Row, 'sha256');
  describeRow(SETTLED_ROWS[1] as Row, 'sha256');
  describeRow(ITA_ROW);
  describe.skipIf(process.platform === 'win32')('with a pre-commit hook', () => {
    describeRow(HOOK_ROW);
  });
});
