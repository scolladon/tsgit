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
  {
    label: 'a revision expression start',
    config: [],
    args: ['z', 'HEAD~0'],
    input: z({ startPoint: 'HEAD~0' }),
  },
  {
    label: 'a remote expression start',
    config: [],
    args: ['z', 'origin/main~0'],
    input: z({ startPoint: 'origin/main~0' }),
  },
  {
    label: '--track=inherit from a start merging two refs',
    config: [['branch.main.merge', 'refs/heads/z']],
    args: ['--track=inherit', 'z', 'main'],
    input: z({ startPoint: 'main', track: 'inherit' }),
  },
  {
    label: 'a remote start a negative refspec excludes',
    config: [['remote.origin.fetch', '^refs/heads/main']],
    args: ['z', 'origin/main'],
    input: z({ startPoint: 'origin/main' }),
  },
  {
    label: 'a remote start a negative pattern refspec leaves alone',
    config: [['remote.origin.fetch', '^refs/heads/m*']],
    args: ['z', 'origin/z'],
    input: z({ startPoint: 'origin/z' }),
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
    label: '--track from a revision expression',
    config: [],
    args: ['--track', 'z', 'main~0'],
    input: z({ startPoint: 'main~0', track: 'direct' }),
    fatal: "fatal: cannot set up tracking information; starting point 'main~0' is not a branch",
    data: { code: 'UPSTREAM_NOT_BRANCH', startPoint: 'main~0' },
    created: false,
  },
  {
    label: '--track from a remote ref a negative refspec excludes',
    config: [['remote.origin.fetch', '^refs/heads/main']],
    args: ['--track', 'z', 'origin/main'],
    input: z({ startPoint: 'origin/main', track: 'direct' }),
    fatal:
      "fatal: cannot set up tracking information; starting point 'origin/main' is not a branch",
    data: { code: 'UPSTREAM_NOT_BRANCH', startPoint: 'origin/main' },
    created: false,
  },
  {
    label: '--track=inherit of two merges under autoSetupRebase=always',
    config: [
      ['branch.main.merge', 'refs/heads/z'],
      ['branch.autoSetupRebase', 'always'],
    ],
    args: ['--track=inherit', 'z', 'main'],
    input: z({ startPoint: 'main', track: 'inherit' }),
    fatal:
      'fatal: cannot inherit upstream tracking configuration of multiple refs when rebasing is requested',
    data: {
      code: 'TRACKING_INHERIT_REBASE_MULTIPLE',
      merges: ['refs/heads/main', 'refs/heads/z'],
    },
    created: true,
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

/** One upstream as git's tracking line names it: `<remote>/<branch>`, or the bare branch locally. */
const friendlyName = (remote: string, merge: string): string => {
  const short = merge.startsWith(HEADS) ? merge.slice(HEADS.length) : merge;
  return remote === '.' ? short : `${remote}/${short}`;
};

/** git's `branch '<n>' set up to track …` lines, rebuilt from the structured result. */
const trackingLine = (name: string, upstream: BranchUpstream | undefined): string => {
  if (upstream === undefined) return '';
  const friendly = upstream.merges.map((merge) => friendlyName(upstream.remote, merge));
  if (friendly.length > 1) {
    return `branch '${name}' set up to track:\n${friendly.map((f) => `  ${f}\n`).join('')}`;
  }
  const suffix = upstream.rebase ? ' by rebasing' : '';
  return `branch '${name}' set up to track '${friendly[0]}'${suffix}.\n`;
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
