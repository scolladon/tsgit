/**
 * Cross-tool interop — checkout on an unborn HEAD: `-b <name>` with no start point only
 * moves HEAD, a start point that resolves to nothing refuses as git does, and an omitted
 * rev reads as HEAD on a born branch.
 *
 * @proves
 *   surface:        checkout
 *   bucket:         cross-tool-interop
 *   unique:         checkout -b on an unborn HEAD and an omitted rev behave as git does
 *   interopSurface: checkout
 */
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkout } from '../../src/application/commands/checkout.js';
import { TsgitError } from '../../src/domain/error.js';
import { openRepository } from '../../src/index.node.js';
import { GIT_AVAILABLE, git, runGit, tryRunGitWithExit } from './interop-helpers.js';

const ROW_TIMEOUT = 60_000;
const NULL_OID = '0'.repeat(40);
const HOOK_BODY = `#!/bin/sh\nd=$(git rev-parse --git-dir)\nprintf '%s' "$*" > "$d/hook-args"\nexit 0\n`;

type Kind =
  | 'fresh'
  | 'fresh-no-index'
  | 'fresh-reftable'
  | 'orphan'
  | 'born'
  | 'linked-orphan'
  | 'bare-linked-orphan'
  | 'unborn-main-linked';

interface Twin {
  readonly repo: string;
  readonly act: string;
}

type CheckoutOptions = Parameters<typeof checkout>[1];

interface Row {
  readonly id: string;
  readonly kind: Kind;
  readonly prepare?: (twin: Twin) => Promise<void>;
  readonly git: ReadonlyArray<string>;
  readonly opts: CheckoutOptions;
  readonly gitExit: number;
  readonly result?: Record<string, unknown>;
  readonly data?: Record<string, unknown>;
  readonly stderr?: string;
}

let root: string;
let origin: string;

const seedFresh = (dir: string, extraInit: ReadonlyArray<string> = []): void => {
  runGit(['init', '-q', '-b', 'main', ...extraInit, dir]);
};

const writeF = (dir: string): Promise<void> => writeFile(path.join(dir, 'f'), 'a\n');

const BUILDERS: Readonly<Record<Kind, (t: string) => Promise<Twin>>> = {
  fresh: async (t) => {
    seedFresh(t);
    await writeF(t);
    git(t, 'add', 'f');
    return { repo: t, act: t };
  },
  'fresh-no-index': async (t) => {
    seedFresh(t);
    await writeF(t);
    return { repo: t, act: t };
  },
  'fresh-reftable': async (t) => {
    seedFresh(t, ['--ref-format=reftable']);
    await writeF(t);
    git(t, 'add', 'f');
    return { repo: t, act: t };
  },
  orphan: async (t) => {
    runGit(['clone', '-q', origin, t]);
    git(t, 'checkout', '-q', '--orphan', 'o');
    return { repo: t, act: t };
  },
  born: async (t) => {
    runGit(['clone', '-q', origin, t]);
    return { repo: t, act: t };
  },
  'linked-orphan': async (t) => {
    runGit(['clone', '-q', origin, t]);
    git(t, 'worktree', 'add', '-q', '--detach', `${t}-wt`);
    git(`${t}-wt`, 'checkout', '-q', '--orphan', 'o2');
    return { repo: t, act: `${t}-wt` };
  },
  'bare-linked-orphan': async (t) => {
    runGit(['clone', '-q', '--bare', origin, `${t}.git`]);
    git(`${t}.git`, 'worktree', 'add', '-q', '--detach', `${t}-wt`);
    git(`${t}-wt`, 'checkout', '-q', '--orphan', 'o3');
    return { repo: `${t}.git`, act: `${t}-wt` };
  },
  'unborn-main-linked': async (t) => {
    seedFresh(t);
    await writeF(t);
    git(t, 'add', 'f');
    git(t, 'worktree', 'add', '-q', '--orphan', '-b', 'o2', `${t}-wt`);
    return { repo: t, act: `${t}-wt` };
  },
};

const probe = (dir: string, args: ReadonlyArray<string>): string => {
  const run = tryRunGitWithExit(['-C', dir, ...args]);
  return `${run.exitCode}:${run.stdout}`;
};

const headOf = (dir: string): string => {
  const sym = tryRunGitWithExit(['-C', dir, 'symbolic-ref', '-q', 'HEAD']);
  return sym.exitCode === 0 ? sym.stdout : probe(dir, ['rev-parse', 'HEAD']);
};

const headLogOf = async (dir: string): Promise<string> => {
  const logPath = path.resolve(dir, git(dir, 'rev-parse', '--git-path', 'logs/HEAD').trim());
  const text = await readFile(logPath, 'utf8').catch(() => undefined);
  if (text === undefined) return 'absent';
  const lines = text.trimEnd().split('\n');
  const [head = '', message = ''] = (lines.at(-1) ?? '').split('\t');
  return `${lines.length}|${head.split(' ').slice(0, 2).join(' ')}|${message}`;
};

const hookArgsOf = async (dir: string): Promise<string> => {
  const gitDir = git(dir, 'rev-parse', '--absolute-git-dir').trim();
  return readFile(path.join(gitDir, 'hook-args'), 'utf8').catch(() => 'absent');
};

const branchLogsOf = (dir: string): string => {
  const refs = git(dir, 'for-each-ref', '--format=%(refname)', 'refs/heads').split('\n');
  return refs
    .filter((ref) => ref !== '')
    .map((ref) => `${ref} ${probe(dir, ['log', '-g', '--format=%gs', '-1', ref])}`)
    .join('\n');
};

const stateOfOne = async (dir: string): Promise<ReadonlyArray<string>> => [
  headOf(dir),
  probe(dir, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads']),
  probe(dir, ['ls-files', '-s']),
  probe(dir, ['status', '--porcelain', '--untracked-files=all']),
  await headLogOf(dir),
  await hookArgsOf(dir),
  branchLogsOf(dir),
];

const stateOf = async (twin: Twin): Promise<ReadonlyArray<ReadonlyArray<string>>> =>
  Promise.all([...new Set([twin.act, twin.repo])].map(stateOfOne));

interface Outcome {
  readonly result?: unknown;
  readonly error?: TsgitError;
}

const runTsgit = async (act: string, opts: CheckoutOptions): Promise<Outcome> => {
  const repo = await openRepository({ cwd: act });
  try {
    return { result: await checkout(repo.ctx, opts) };
  } catch (error) {
    if (!(error instanceof TsgitError)) throw error;
    return { error };
  } finally {
    await repo.dispose();
  }
};

const runRow = async (row: Row) => {
  const label = row.id.toLowerCase();
  const gitTwin = await BUILDERS[row.kind](path.join(root, `${label}-git`));
  const tsgitTwin = await BUILDERS[row.kind](path.join(root, `${label}-tsgit`));
  await row.prepare?.(gitTwin);
  await row.prepare?.(tsgitTwin);
  const gitRun = tryRunGitWithExit(['-C', gitTwin.act, ...row.git]);
  const outcome = await runTsgit(tsgitTwin.act, row.opts);
  return {
    gitRun,
    outcome,
    gitState: await stateOf(gitTwin),
    tsgitState: await stateOf(tsgitTwin),
  };
};

const expectRow = async (row: Row): Promise<void> => {
  // Arrange / Act
  const sut = await runRow(row);

  // Assert
  expect(sut.gitRun.exitCode).toBe(row.gitExit);
  expect(sut.tsgitState).toEqual(sut.gitState);
  if (row.data === undefined) {
    expect(sut.outcome.error?.data).toBeUndefined();
    expect(sut.outcome.result).toMatchObject(row.result ?? {});
    return;
  }
  expect(sut.outcome.error?.data).toEqual(row.data);
  if (row.stderr !== undefined) expect(sut.gitRun.stderr).toContain(row.stderr);
};

const created = (name: string): Record<string, unknown> => ({
  branch: `refs/heads/${name}`,
  id: NULL_OID,
  detached: false,
  changedPaths: 0,
});

const lockFile =
  (name: string) =>
  async ({ repo }: Twin): Promise<void> => {
    await writeFile(path.join(repo, '.git', name), '');
  };

const installHook = async ({ repo }: Twin): Promise<void> => {
  const hookPath = path.join(repo, '.git', 'hooks', 'post-checkout');
  await writeFile(hookPath, HOOK_BODY);
  await chmod(hookPath, 0o755);
};

const gitFileWith =
  (name: string, content: string) =>
  async ({ repo }: Twin): Promise<void> => {
    await writeFile(path.join(repo, '.git', name), content);
  };

const setConfig =
  (key: string, value: string) =>
  async ({ repo }: Twin): Promise<void> => {
    git(repo, 'config', key, value);
  };

const U1 = { createBranch: { name: 'x' } } as const;
const noStart = (name: string): string =>
  `fatal: '${name}' is not a commit and a branch 'x' cannot be created from it`;

const SUCCESS_ROWS: ReadonlyArray<Row> = [
  {
    id: 'U1',
    kind: 'fresh',
    git: ['checkout', '-b', 'x'],
    opts: U1,
    gitExit: 0,
    result: created('x'),
  },
  {
    id: 'U3',
    kind: 'fresh',
    git: ['checkout', '-b', 'x', '--track'],
    opts: { createBranch: { name: 'x', track: 'direct' } },
    gitExit: 0,
    result: created('x'),
  },
  {
    id: 'U4',
    kind: 'fresh',
    git: ['checkout', '-f', '-b', 'x'],
    opts: { force: true, createBranch: { name: 'x' } },
    gitExit: 0,
    result: created('x'),
  },
  {
    id: 'U7',
    kind: 'fresh',
    git: ['checkout', '-b', 'main'],
    opts: { createBranch: { name: 'main' } },
    gitExit: 0,
    result: created('main'),
  },
  {
    id: 'U10',
    kind: 'fresh',
    prepare: setConfig('core.logAllRefUpdates', 'always'),
    git: ['checkout', '-b', 'x'],
    opts: U1,
    gitExit: 0,
    result: created('x'),
  },
  {
    id: 'U11',
    kind: 'fresh',
    prepare: installHook,
    git: ['checkout', '-b', 'x'],
    opts: U1,
    gitExit: 0,
    result: created('x'),
  },
  {
    id: 'U12',
    kind: 'fresh',
    prepare: lockFile('index.lock'),
    git: ['checkout', '-b', 'x'],
    opts: U1,
    gitExit: 0,
    result: created('x'),
  },
  {
    id: 'U13',
    kind: 'fresh',
    prepare: gitFileWith('index', 'garbage'),
    git: ['checkout', '-b', 'x'],
    opts: U1,
    gitExit: 0,
    result: created('x'),
  },
  {
    id: 'U15',
    kind: 'fresh',
    prepare: gitFileWith('MERGE_MSG', 'm\n'),
    git: ['checkout', '-b', 'x'],
    opts: U1,
    gitExit: 0,
    result: created('x'),
  },
  {
    id: 'U16',
    kind: 'linked-orphan',
    git: ['checkout', '-b', 'x'],
    opts: U1,
    gitExit: 0,
    result: created('x'),
  },
  {
    id: 'U17',
    kind: 'bare-linked-orphan',
    git: ['checkout', '-b', 'x'],
    opts: U1,
    gitExit: 0,
    result: created('x'),
  },
  {
    id: 'U18',
    kind: 'unborn-main-linked',
    git: ['checkout', '-b', 'main'],
    opts: { createBranch: { name: 'main' } },
    gitExit: 0,
    result: created('main'),
  },
];

const REFUSAL_ROWS: ReadonlyArray<Row> = [
  {
    id: 'U5',
    kind: 'fresh',
    git: ['checkout', '-b', 'x', '--detach'],
    opts: { detach: true, createBranch: { name: 'x' } },
    gitExit: 128,
    data: {
      code: 'INVALID_OPTION',
      option: 'createBranch',
      reason: 'cannot be combined with detach',
    },
    stderr: "fatal: '--detach' cannot be used with '-b/-B/--orphan'",
  },
  {
    id: 'U6',
    kind: 'fresh',
    git: ['checkout', '-b', 'x..y'],
    opts: { createBranch: { name: 'x..y' } },
    gitExit: 128,
    data: { code: 'INVALID_REF', reason: 'ref name must not contain ..' },
    stderr: "fatal: 'x..y' is not a valid branch name",
  },
  {
    id: 'U8',
    kind: 'orphan',
    git: ['checkout', '-b', 'main'],
    opts: { createBranch: { name: 'main' } },
    gitExit: 128,
    data: { code: 'BRANCH_EXISTS', name: 'refs/heads/main' },
    stderr: "fatal: a branch named 'main' already exists",
  },
  {
    id: 'U14',
    kind: 'fresh',
    prepare: lockFile('HEAD.lock'),
    git: ['checkout', '-b', 'x'],
    opts: U1,
    gitExit: 255,
    data: { code: 'REF_LOCKED', name: 'HEAD' },
    stderr: "cannot lock ref 'HEAD'",
  },
  ...['HEAD', '@', 'main'].map(
    (rev, i): Row => ({
      id: `S${i + 1}`,
      kind: 'fresh',
      git: ['checkout', '-b', 'x', rev],
      opts: { rev, createBranch: { name: 'x' } },
      gitExit: 128,
      data: { code: 'CHECKOUT_START_POINT_NOT_COMMIT', revision: rev, branch: 'x' },
      stderr: noStart(rev),
    }),
  ),
  {
    id: 'S6',
    kind: 'linked-orphan',
    git: ['checkout', '-b', 'x', 'HEAD'],
    opts: { rev: 'HEAD', createBranch: { name: 'x' } },
    gitExit: 128,
    data: { code: 'CHECKOUT_START_POINT_NOT_COMMIT', revision: 'HEAD', branch: 'x' },
    stderr: noStart('HEAD'),
  },
  ...['HEAD', 'main'].map(
    (rev): Row => ({
      id: `S7-${rev}`,
      kind: 'fresh',
      git: ['checkout', rev],
      opts: { rev },
      gitExit: 1,
      data: { code: 'PATHSPEC_NO_MATCH', pattern: rev, patterns: [rev] },
      stderr: `error: pathspec '${rev}' did not match any file(s) known to git`,
    }),
  ),
  {
    id: 'H4',
    kind: 'fresh',
    git: ['checkout'],
    opts: {},
    gitExit: 128,
    data: { code: 'NO_INITIAL_COMMIT' },
    stderr: 'fatal: You are on a branch yet to be born',
  },
  {
    id: 'H4-no-index',
    kind: 'fresh-no-index',
    git: ['checkout'],
    opts: {},
    gitExit: 128,
    data: { code: 'NO_INITIAL_COMMIT' },
    stderr: 'fatal: You are on a branch yet to be born',
  },
  {
    id: 'H5',
    kind: 'fresh',
    git: ['checkout', '--detach'],
    opts: { detach: true },
    gitExit: 128,
    data: { code: 'NO_INITIAL_COMMIT' },
    stderr: 'fatal: You are on a branch yet to be born',
  },
];

const BORN_ROWS: ReadonlyArray<Row> = [
  {
    id: 'H1',
    kind: 'born',
    git: ['checkout', '-b', 'x'],
    opts: U1,
    gitExit: 0,
    result: { branch: 'refs/heads/x', detached: false, changedPaths: 0 },
  },
  {
    id: 'H2',
    kind: 'born',
    git: ['checkout', '--detach'],
    opts: { detach: true },
    gitExit: 0,
    result: { detached: true, changedPaths: 0 },
  },
  {
    id: 'H3',
    kind: 'born',
    git: ['checkout'],
    opts: {},
    gitExit: 0,
    result: { branch: 'refs/heads/main', detached: false, changedPaths: 0 },
  },
];

describe.skipIf(!GIT_AVAILABLE || process.platform === 'win32')(
  'checkout on an unborn HEAD against git',
  () => {
    beforeAll(async () => {
      root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-unborn-nb-')));
      origin = path.join(root, 'origin');
      runGit(['init', '-q', '-b', 'main', origin]);
      await writeFile(path.join(origin, 'f'), 'f\n');
      await writeFile(path.join(origin, 'x'), 'x\n');
      git(origin, 'add', 'f', 'x');
      git(origin, 'commit', '-q', '-m', 'root');
    });

    afterAll(async () => {
      await rm(root, { recursive: true, force: true });
    });

    describe('Given a branch creation on an unborn HEAD that git accepts', () => {
      describe('When tsgit runs the same checkout', () => {
        it.each(SUCCESS_ROWS)(
          'Then $id leaves the same state as git',
          async (row) => {
            await expectRow(row);
          },
          ROW_TIMEOUT,
        );
      });
    });

    describe('Given a checkout git refuses on an unborn HEAD', () => {
      describe('When tsgit runs the same checkout', () => {
        it.each(REFUSAL_ROWS)(
          'Then $id refuses as git does and leaves the same state',
          async (row) => {
            await expectRow(row);
          },
          ROW_TIMEOUT,
        );
      });
    });

    describe('Given a born branch and an omitted start point or rev', () => {
      describe('When tsgit runs the same checkout', () => {
        it.each(BORN_ROWS)(
          'Then $id leaves the same state as git',
          async (row) => {
            await expectRow(row);
          },
          ROW_TIMEOUT,
        );
      });
    });

    describe('Given a reftable repository on an unborn HEAD', () => {
      describe('When a branch is created without a start point', () => {
        it(
          'Then git and tsgit agree on HEAD and on the HEAD reflog exit status',
          async () => {
            // Arrange
            const gitTwin = await BUILDERS['fresh-reftable'](path.join(root, 'u10r-git'));
            const tsgitTwin = await BUILDERS['fresh-reftable'](path.join(root, 'u10r-tsgit'));

            // Act
            const gitRun = tryRunGitWithExit(['-C', gitTwin.act, 'checkout', '-b', 'x']);
            const outcome = await runTsgit(tsgitTwin.act, U1);

            // Assert
            expect(gitRun.exitCode).toBe(0);
            expect(outcome.result).toMatchObject(created('x'));
            expect(headOf(tsgitTwin.act)).toBe(headOf(gitTwin.act));
            expect(probe(tsgitTwin.act, ['reflog', 'show', 'HEAD']).split(':')[0]).toBe(
              probe(gitTwin.act, ['reflog', 'show', 'HEAD']).split(':')[0],
            );
          },
          ROW_TIMEOUT,
        );
      });
    });
  },
);
