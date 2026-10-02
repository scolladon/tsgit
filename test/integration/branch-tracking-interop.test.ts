/**
 * Cross-tool interop — the upstream `branch` records for a new branch. Every
 * row builds two repositories of the same shape (an `origin` remote with
 * `origin/main` and `origin/z`, `main` tracking `origin/main`, a tag `t`),
 * runs canonical git's `branch` against one and tsgit's `branchCreate`
 * against the other, and compares the `branch.z.*` config both write. git's
 * `branch 'z' set up to track '…'` line is rebuilt from the structured
 * `upstream` field and compared to git's stdout.
 *
 * @proves
 *   surface:        branch.create
 *   bucket:         cross-tool-interop
 *   unique:         branch.create records the same branch.<n>.remote/merge/rebase
 *                    git's setup_tracking writes, for every track mode
 *   interopSurface: branch
 */
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  type BranchCreateInput,
  type BranchUpstream,
  branchCreate,
} from '../../src/application/commands/branch.js';
import type { TsgitError } from '../../src/domain/error.js';
import { openRepository } from '../../src/index.node.js';
import {
  disableAutoMaintenance,
  GIT_AVAILABLE,
  git,
  runGit,
  tryRunGitWithExit,
} from './interop-helpers.js';

const ROW_TIMEOUT = 60_000;
const HEADS = 'refs/heads/';

type Config = ReadonlyArray<readonly [string, string]>;

interface Row {
  readonly label: string;
  readonly config: Config;
  readonly args: ReadonlyArray<string>;
  readonly input: BranchCreateInput;
}

const z = (input: Omit<BranchCreateInput, 'name'>): BranchCreateInput => ({ name: 'z', ...input });

const ROWS: ReadonlyArray<Row> = [
  {
    label: 'a remote start',
    config: [],
    args: ['z', 'origin/main'],
    input: z({ startPoint: 'origin/main' }),
  },
  { label: 'a local start', config: [], args: ['z', 'main'], input: z({ startPoint: 'main' }) },
  {
    label: '--track from a local start',
    config: [],
    args: ['--track', 'z', 'main'],
    input: z({ startPoint: 'main', track: 'direct' }),
  },
  {
    label: '--track with no start',
    config: [],
    args: ['--track', 'z'],
    input: z({ track: 'direct' }),
  },
  {
    label: '--track=inherit from a local start',
    config: [],
    args: ['--track=inherit', 'z', 'main'],
    input: z({ startPoint: 'main', track: 'inherit' }),
  },
  {
    label: '--no-track from a remote start',
    config: [],
    args: ['--no-track', 'z', 'origin/main'],
    input: z({ startPoint: 'origin/main', noTrack: true }),
  },
  {
    label: 'autoSetupMerge=always from a local start',
    config: [['branch.autoSetupMerge', 'always']],
    args: ['z', 'main'],
    input: z({ startPoint: 'main' }),
  },
  {
    label: 'autoSetupMerge=inherit from a local start',
    config: [['branch.autoSetupMerge', 'inherit']],
    args: ['z', 'main'],
    input: z({ startPoint: 'main' }),
  },
  {
    label: 'autoSetupMerge=simple from a differently named remote start',
    config: [['branch.autoSetupMerge', 'simple']],
    args: ['z', 'origin/main'],
    input: z({ startPoint: 'origin/main' }),
  },
  {
    label: 'autoSetupMerge=simple from a same-named remote start',
    config: [['branch.autoSetupMerge', 'simple']],
    args: ['z', 'origin/z'],
    input: z({ startPoint: 'origin/z' }),
  },
  {
    label: '--track under autoSetupMerge=false',
    config: [['branch.autoSetupMerge', 'false']],
    args: ['--track', 'z', 'origin/main'],
    input: z({ startPoint: 'origin/main', track: 'direct' }),
  },
  {
    label: 'autoSetupRebase=always from a remote start',
    config: [['branch.autoSetupRebase', 'always']],
    args: ['z', 'origin/main'],
    input: z({ startPoint: 'origin/main' }),
  },
  {
    label: 'autoSetupRebase=local with --track from a local start',
    config: [['branch.autoSetupRebase', 'local']],
    args: ['--track', 'z', 'main'],
    input: z({ startPoint: 'main', track: 'direct' }),
  },
  {
    label: 'autoSetupRebase=remote from a remote start',
    config: [['branch.autoSetupRebase', 'remote']],
    args: ['z', 'origin/main'],
    input: z({ startPoint: 'origin/main' }),
  },
];

interface RefusalRow {
  readonly label: string;
  readonly config: Config;
  readonly args: ReadonlyArray<string>;
  readonly input: BranchCreateInput;
  readonly fatal: string;
  readonly data: unknown;
  readonly created: boolean;
}

const REFUSALS: ReadonlyArray<RefusalRow> = [
  {
    label: '--track from a tag',
    config: [],
    args: ['--track', 'z', 't'],
    input: z({ startPoint: 't', track: 'direct' }),
    fatal: "fatal: cannot set up tracking information; starting point 't' is not a branch",
    data: { code: 'UPSTREAM_NOT_BRANCH', startPoint: 't' },
    created: false,
  },
  {
    label: '--track from a missing name',
    config: [],
    args: ['--track', 'z', 'absent'],
    input: z({ startPoint: 'absent', track: 'direct' }),
    fatal: "fatal: the requested upstream branch 'absent' does not exist",
    data: { code: 'UPSTREAM_MISSING', startPoint: 'absent' },
    created: false,
  },
  {
    label: 'two remotes fetching into the start ref',
    config: [
      ['remote.o2.url', '/nowhere'],
      ['remote.o2.fetch', '+refs/heads/*:refs/remotes/origin/*'],
    ],
    args: ['z', 'origin/main'],
    input: z({ startPoint: 'origin/main' }),
    fatal: "fatal: not tracking: ambiguous information for ref 'refs/remotes/origin/main'",
    data: {
      code: 'TRACKING_AMBIGUOUS',
      ref: 'refs/remotes/origin/main',
      remotes: ['origin', 'o2'],
    },
    created: true,
  },
];

/** git's `branch '<n>' set up to track '<upstream>'` line, rebuilt from the structured result. */
const trackingLine = (name: string, upstream: BranchUpstream | undefined): string => {
  if (upstream === undefined) return '';
  const short = upstream.merge.startsWith(HEADS)
    ? upstream.merge.slice(HEADS.length)
    : upstream.merge;
  const friendly = upstream.remote === '.' ? short : `${upstream.remote}/${short}`;
  const suffix = upstream.rebase ? ' by rebasing' : '';
  return `branch '${name}' set up to track '${friendly}'${suffix}.\n`;
};

const branchConfig = (dir: string): string =>
  tryRunGitWithExit(['-C', dir, 'config', '--get-regexp', '^branch\\.z\\.']).stdout;

const branchExists = (dir: string): boolean =>
  tryRunGitWithExit(['-C', dir, 'rev-parse', '-q', '--verify', 'refs/heads/z']).exitCode === 0;

describe.skipIf(!GIT_AVAILABLE)('branch create — upstream tracking interop', () => {
  const caseRoots: string[] = [];

  const caseRepo = async (slug: string, config: Config): Promise<string> => {
    const root = await realpath(
      await mkdtemp(path.join(os.tmpdir(), `tsgit-branch-track-${slug}-`)),
    );
    caseRoots.push(root);
    const dir = path.join(root, 'repo');
    runGit(['init', '-q', '-b', 'main', dir]);
    git(dir, 'config', 'user.name', 'Ada');
    git(dir, 'config', 'user.email', 'ada@example.com');
    disableAutoMaintenance(dir);
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'root');
    git(dir, 'tag', 't');
    git(dir, 'config', 'remote.origin.url', '/nowhere');
    git(dir, 'config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*');
    git(dir, 'update-ref', 'refs/remotes/origin/main', 'main');
    git(dir, 'update-ref', 'refs/remotes/origin/z', 'main');
    git(dir, 'config', 'branch.main.remote', 'origin');
    git(dir, 'config', 'branch.main.merge', 'refs/heads/main');
    for (const [key, value] of config) git(dir, 'config', '--add', key, value);
    return dir;
  };

  const createWithTsgit = async (dir: string, input: BranchCreateInput) => {
    const repo = await openRepository({ cwd: dir });
    return branchCreate(repo.ctx, input);
  };

  afterAll(async () => {
    await Promise.all(caseRoots.map((root) => rm(root, { recursive: true, force: true })));
  });

  describe.each(ROWS)('Given $label', ({ label, config, args, input }) => {
    describe('When git branch and tsgit branchCreate run', () => {
      it(
        'Then both record the same branch.z config and the same tracking line',
        async () => {
          // Arrange
          const slug = label.replace(/[^a-z]+/gi, '-');
          const peer = await caseRepo(`${slug}-git`, config);
          const ours = await caseRepo(`${slug}-ts`, config);
          const expected = tryRunGitWithExit(['-C', peer, 'branch', ...args]);

          // Act
          const result = await createWithTsgit(ours, input);

          // Assert
          expect(expected.exitCode).toBe(0);
          expect(branchConfig(ours)).toBe(branchConfig(peer));
          expect(trackingLine('z', result.upstream)).toBe(expected.stdout);
        },
        ROW_TIMEOUT,
      );
    });
  });

  describe.each(REFUSALS)(
    'Given $label',
    ({ label, config, args, input, fatal, data, created }) => {
      describe('When git branch and tsgit branchCreate run', () => {
        it(
          'Then both refuse at the same point',
          async () => {
            // Arrange
            const slug = label.replace(/[^a-z]+/gi, '-');
            const peer = await caseRepo(`${slug}-git`, config);
            const ours = await caseRepo(`${slug}-ts`, config);
            const expected = tryRunGitWithExit(['-C', peer, 'branch', ...args]);

            // Act
            let caught: unknown;
            try {
              await createWithTsgit(ours, input);
            } catch (error) {
              caught = error;
            }

            // Assert
            expect(expected.exitCode).toBe(128);
            expect(expected.stderr.split('\n')[0]).toBe(fatal);
            expect((caught as TsgitError).data).toEqual(data);
            expect(branchExists(peer)).toBe(created);
            expect(branchExists(ours)).toBe(created);
            expect(branchConfig(ours)).toBe(branchConfig(peer));
          },
          ROW_TIMEOUT,
        );
      });
    },
  );
});
