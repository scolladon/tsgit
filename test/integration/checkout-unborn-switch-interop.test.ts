/**
 * Cross-tool interop — a switch from an unborn HEAD runs as git's does: the empty tree is the
 * two-way old side once an index exists, the reflog and post-checkout carry the null oid, and a
 * staged path the target needs for a file or a directory follows core.ignorecase.
 *
 * @proves
 *   surface:        checkout
 *   bucket:         cross-tool-interop
 *   unique:         a switch from an unborn HEAD carries, refuses and logs as git does
 *   interopSurface: checkout
 */
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkout } from '../../src/application/commands/checkout.js';
import { TsgitError } from '../../src/domain/error.js';
import { openRepository } from '../../src/index.node.js';
import { GIT_AVAILABLE, git, runGit, tryRunGitWithExit } from './interop-helpers.js';

const ROW_TIMEOUT = 60_000;
const HOOK_BODY = `#!/bin/sh\nd=$(git rev-parse --git-dir)\nprintf '%s' "$*" > "$d/hook-args"\nexit 0\n`;

type Kind = 'orphan' | 'fetched' | 'fetched-reftable' | 'sparse-orphan' | 'linked-orphan';

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
}

let root: string;
let origin: string;

const FETCH_REFSPECS = ['main:other', 'side:side', 'hf:hf'];

const fetchedTwin =
  (extraInit: ReadonlyArray<string>) =>
  async (t: string): Promise<Twin> => {
    runGit(['init', '-q', '-b', 'main', ...extraInit, t]);
    git(t, 'fetch', '-q', origin, ...FETCH_REFSPECS);
    return { repo: t, act: t };
  };

const cloneWithBranches = (t: string): void => {
  runGit(['clone', '-q', origin, t]);
  git(t, 'branch', '-q', 'side', 'origin/side');
  git(t, 'branch', '-q', 'hf', 'origin/hf');
};

const BUILDERS: Readonly<Record<Kind, (t: string) => Promise<Twin>>> = {
  orphan: async (t) => {
    cloneWithBranches(t);
    git(t, 'checkout', '-q', '--orphan', 'o');
    return { repo: t, act: t };
  },
  fetched: fetchedTwin([]),
  'fetched-reftable': fetchedTwin(['--ref-format=reftable']),
  'sparse-orphan': async (t) => {
    cloneWithBranches(t);
    git(t, 'sparse-checkout', 'set', '--no-cone', '/g');
    git(t, 'checkout', '-q', '--orphan', 'o');
    return { repo: t, act: t };
  },
  'linked-orphan': async (t) => {
    cloneWithBranches(t);
    git(t, 'worktree', 'add', '-q', '--detach', `${t}-wt`);
    git(`${t}-wt`, 'checkout', '-q', '--orphan', 'o2');
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

const hookArgsOf = async (dir: string): Promise<string> => {
  const gitDir = git(dir, 'rev-parse', '--absolute-git-dir').trim();
  return readFile(path.join(gitDir, 'hook-args'), 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return 'absent';
    throw error;
  });
};

const headLogOf = async (dir: string): Promise<string> => {
  // reftable keeps no logs/HEAD file, so only that format reads the reflog through `log -g`
  if (git(dir, 'rev-parse', '--show-ref-format').trim() === 'reftable') {
    return probe(dir, ['log', '-g', '--format=%H%x09%gs', 'HEAD']);
  }
  const logPath = path.resolve(dir, git(dir, 'rev-parse', '--git-path', 'logs/HEAD').trim());
  const text = await readFile(logPath, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (text === undefined) return 'absent';
  return text
    .trimEnd()
    .split('\n')
    .map((line) => {
      const [head = '', message = ''] = line.split('\t');
      return `${head.split(' ').slice(0, 2).join(' ')}|${message}`;
    })
    .join('\n');
};

const branchLogsOf = (dir: string): string => {
  const refs = git(dir, 'for-each-ref', '--format=%(refname)', 'refs/heads').split('\n');
  return refs
    .filter((ref) => ref !== '')
    .map((ref) => `${ref} ${probe(dir, ['log', '-g', '--format=%gs', '-1', ref])}`)
    .join('\n');
};

const diskOf = async (dir: string): Promise<string> => {
  const names = (await readdir(dir, { recursive: true })).filter(
    (name) => name !== '.git' && !name.startsWith(`.git${path.sep}`),
  );
  const lines = await Promise.all(
    names.sort().map(async (name) => {
      const full = path.join(dir, name);
      const isDir = (await stat(full)).isDirectory();
      return isDir ? `${name}/` : `${name}=${await readFile(full, 'utf8')}`;
    }),
  );
  return lines.join('|');
};

const stateOfOne = async (dir: string): Promise<ReadonlyArray<string>> => [
  headOf(dir),
  probe(dir, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads']),
  probe(dir, ['ls-files', '-s']),
  probe(dir, ['ls-files', '-t']),
  probe(dir, ['status', '--porcelain', '--untracked-files=all']),
  await headLogOf(dir),
  probe(dir, ['config', '--get-regexp', '^branch\\.']),
  await hookArgsOf(dir),
  branchLogsOf(dir),
  await diskOf(dir),
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
  const label = row.id.toLowerCase().replace(/[^a-z0-9]+/g, '-');
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
  expect(sut.outcome.error?.data).toMatchObject(row.data);
};

type Prepare = NonNullable<Row['prepare']>;

const sequence =
  (...steps: ReadonlyArray<Prepare>): Prepare =>
  async (twin) => {
    for (const step of steps) await step(twin);
  };

const writeIn =
  (name: string, content: string): Prepare =>
  async ({ act }) => {
    await writeFile(path.join(act, name), content);
  };

const gitStep =
  (...args: ReadonlyArray<string>): Prepare =>
  async ({ act }) => {
    git(act, ...args);
  };

const makeDir =
  (name: string): Prepare =>
  async ({ act }) => {
    await mkdir(path.join(act, name), { recursive: true });
  };

const installHook: Prepare = async ({ repo }) => {
  const hookPath = path.join(repo, '.git', 'hooks', 'post-checkout');
  await writeFile(hookPath, HOOK_BODY);
  await chmod(hookPath, 0o755);
};

const emptied = gitStep('rm', '-r', '-q', '-f', '.');
const refusal = (untracked: ReadonlyArray<string>): Record<string, unknown> => ({
  code: 'CHECKOUT_OVERWRITE_DIRTY',
  untracked,
});

const ORPHAN_ROWS: ReadonlyArray<Row> = [
  {
    id: 'F1+F4',
    kind: 'orphan',
    prepare: installHook,
    git: ['checkout', 'main'],
    opts: { rev: 'main' },
    gitExit: 0,
    result: { branch: 'refs/heads/main', detached: false },
  },
  {
    id: 'F2',
    kind: 'orphan',
    git: ['checkout', '--detach', 'main'],
    opts: { rev: 'main', detach: true },
    gitExit: 0,
    result: { detached: true },
  },
  {
    id: 'F3',
    kind: 'orphan',
    git: ['checkout', '-b', 'x', 'main'],
    opts: { rev: 'main', createBranch: { name: 'x' } },
    gitExit: 0,
    result: { branch: 'refs/heads/x' },
  },
  {
    id: 'F5',
    kind: 'orphan',
    git: ['checkout', 'side'],
    opts: { rev: 'side' },
    gitExit: 1,
    data: { code: 'CHECKOUT_OVERWRITE_DIRTY', localChanges: ['f'] },
  },
  {
    id: 'F6',
    kind: 'orphan',
    prepare: writeIn('f', 'm\n'),
    git: ['checkout', 'main'],
    opts: { rev: 'main' },
    gitExit: 0,
    result: { branch: 'refs/heads/main' },
  },
  {
    id: 'F7',
    kind: 'orphan',
    prepare: gitStep('rm', '-q', '-f', 'f'),
    git: ['checkout', 'main'],
    opts: { rev: 'main' },
    gitExit: 0,
    result: { branch: 'refs/heads/main' },
  },
  {
    id: 'F8',
    kind: 'orphan',
    prepare: writeIn('g', 'g\n'),
    git: ['checkout', 'main'],
    opts: { rev: 'main' },
    gitExit: 0,
    result: { branch: 'refs/heads/main' },
  },
];

const untrackedF = (content: string): Prepare => writeIn('f', content);

const FETCHED_ROWS: ReadonlyArray<Row> = [
  {
    id: 'F9',
    kind: 'fetched',
    prepare: sequence(
      writeIn('f', 'f\n'),
      gitStep('add', 'f'),
      gitStep('rm', '-q', '--cached', 'f'),
    ),
    git: ['checkout', 'other'],
    opts: { rev: 'other' },
    gitExit: 1,
    data: refusal(['f']),
  },
  {
    id: 'F10',
    kind: 'fetched',
    git: ['checkout', 'other'],
    opts: { rev: 'other' },
    gitExit: 0,
    result: { branch: 'refs/heads/other', changedPaths: 2 },
  },
  ...[
    ['differing', 'x\n'],
    ['identical', 'f\n'],
  ].flatMap(([label, content]) => [
    {
      id: `F11-${label}`,
      kind: 'fetched' as const,
      prepare: untrackedF(content as string),
      git: ['checkout', 'other'],
      opts: { rev: 'other' },
      gitExit: 1,
      data: refusal(['f']),
    },
    {
      id: `F11-${label}-detach`,
      kind: 'fetched' as const,
      prepare: untrackedF(content as string),
      git: ['checkout', '--detach', 'other'],
      opts: { rev: 'other', detach: true },
      gitExit: 1,
      data: refusal(['f']),
    },
  ]),
  {
    id: 'F12',
    kind: 'fetched',
    prepare: untrackedF('x\n'),
    git: ['checkout', '-f', 'other'],
    opts: { rev: 'other', force: true },
    gitExit: 0,
    result: { branch: 'refs/heads/other' },
  },
  {
    id: 'F13',
    kind: 'fetched-reftable',
    prepare: sequence(writeIn('g', 'g\n'), gitStep('add', 'g')),
    git: ['checkout', 'other'],
    opts: { rev: 'other' },
    gitExit: 0,
    result: { branch: 'refs/heads/other' },
  },
];

const WORKTREE_ROWS: ReadonlyArray<Row> = [
  {
    id: 'F14',
    kind: 'sparse-orphan',
    git: ['checkout', 'main'],
    opts: { rev: 'main' },
    gitExit: 0,
    result: { branch: 'refs/heads/main' },
  },
  {
    id: 'F15',
    kind: 'linked-orphan',
    git: ['checkout', '--detach', 'main'],
    opts: { rev: 'main', detach: true },
    gitExit: 0,
    result: { detached: true },
  },
];

const caseRows = (ignoreCase: string): ReadonlyArray<Row> => {
  const stagedDir = sequence(
    emptied,
    writeIn('dir', 's\n'),
    gitStep('add', 'dir'),
    gitStep('config', 'core.ignorecase', ignoreCase),
  );
  const stagedFileUnderDir = sequence(
    emptied,
    makeDir('dir'),
    writeIn(path.join('dir', 'x'), 's\n'),
    gitStep('add', path.join('dir', 'x')),
    gitStep('config', 'core.ignorecase', ignoreCase),
  );
  const a1Switches = ignoreCase === 'true';
  return [
    {
      id: `A1/A2-${ignoreCase}`,
      kind: 'orphan',
      prepare: stagedDir,
      git: ['checkout', 'main'],
      opts: { rev: 'main' },
      gitExit: a1Switches ? 0 : 1,
      ...(a1Switches ? { result: { branch: 'refs/heads/main' } } : { data: refusal(['dir']) }),
    },
    {
      id: `A2d-${ignoreCase}`,
      kind: 'orphan',
      prepare: sequence(stagedDir, writeIn('dir', 'modified\n')),
      git: ['checkout', 'main'],
      opts: { rev: 'main' },
      gitExit: 1,
      data: refusal(['dir']),
    },
    {
      id: `V4-${ignoreCase}`,
      kind: 'orphan',
      prepare: stagedFileUnderDir,
      git: ['checkout', 'hf'],
      opts: { rev: 'hf' },
      gitExit: 0,
      result: { branch: 'refs/heads/hf' },
    },
  ];
};

describe.skipIf(!GIT_AVAILABLE || process.platform === 'win32')(
  'checkout from an unborn HEAD against git',
  () => {
    beforeAll(async () => {
      root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-unborn-sw-')));
      origin = path.join(root, 'origin');
      runGit(['init', '-q', '-b', 'main', origin]);
      await mkdir(path.join(origin, 'dir'));
      await writeFile(path.join(origin, 'dir', 'x'), 'x\n');
      await writeFile(path.join(origin, 'f'), 'f\n');
      git(origin, 'add', 'dir/x', 'f');
      git(origin, 'commit', '-q', '-m', 'root');
      git(origin, 'checkout', '-q', '-b', 'side');
      await writeFile(path.join(origin, 'f'), 'side\n');
      git(origin, 'commit', '-q', '-a', '-m', 'side');
      git(origin, 'checkout', '-q', '-b', 'hf', 'main');
      git(origin, 'rm', '-q', '-r', 'dir');
      await writeFile(path.join(origin, 'dir'), 'D\n');
      git(origin, 'add', 'dir');
      git(origin, 'commit', '-q', '-m', 'hf');
      git(origin, 'checkout', '-q', 'main');
    });

    afterAll(async () => {
      await rm(root, { recursive: true, force: true });
    });

    describe.each([
      ['an orphan branch over a cloned index', ORPHAN_ROWS],
      ['a fetched unborn branch', FETCHED_ROWS],
      ['a sparse or linked orphan', WORKTREE_ROWS],
      ['core.ignorecase false', caseRows('false')],
      ['core.ignorecase true', caseRows('true')],
    ] as const)('Given %s', (_title, rows) => {
      describe('When tsgit runs the same checkout', () => {
        it.each(rows)(
          'Then $id leaves the same state as git',
          async (row) => {
            // Arrange + Act + Assert: the row builds both twins, runs both, and compares their state
            await expectRow(row);
          },
          ROW_TIMEOUT,
        );
      });
    });
  },
);
