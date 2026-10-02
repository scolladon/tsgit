/**
 * Cross-tool interop — a remote whose name begins with `/`. git never
 * registers it and warns once per entry of it each time a command builds its
 * remote table. Each row runs real `git` and tsgit on twin repositories and
 * rebuilds git's warning lines from tsgit's structured logger calls.
 *
 * @proves
 *   surface:        remote
 *   bucket:         cross-tool-interop
 *   unique:         a /-named remote is never registered and warns exactly where git builds its remote table
 *   interopSurface: remote, fetch, branch, status, submodule
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Repository } from '../../src/index.node.js';
import { openRepository } from '../../src/index.node.js';
import { GIT_AVAILABLE, runGit, tryRunGitWithExit } from './interop-helpers.js';

const ROW_TIMEOUT = 30_000;
const PIN = '1111111111111111111111111111111111111111';
const WARNING_PREFIX = "warning: config remote shorthand cannot begin with '/': ";
const TSGIT_WARNING = "readRemoteConfig: config remote shorthand cannot begin with '/'";
const PROMISOR_PREFIX = "warning: promisor remote name cannot begin with '/': ";
const TSGIT_PROMISOR_WARNING =
  "readPromisorRemoteNames: promisor remote name cannot begin with '/'";
const SLASH_REMOTE_CONFIG =
  '[remote "/x"]\n\turl = u\n\tFetch = +refs/heads/*:refs/remotes/x/*\n\tvalueless\n' +
  '[remote "y"]\n\turl = /nonexistent/y.git\n[remote "/w"]\n';

let root: string;

beforeAll(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'tsgit-interop-remote-shorthand-')));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A repository on `main` with a merged `side` branch, a `y/main` remote-tracking branch, and a `/`-named remote. */
const repoWithSlashRemote = (slug: string): string => {
  const dir = path.join(root, slug);
  runGit(['init', '-q', '-b', 'main', dir]);
  runGit(['-C', dir, 'commit', '-q', '--allow-empty', '-m', 'c']);
  runGit(['-C', dir, 'branch', 'side']);
  runGit(['-C', dir, 'update-ref', 'refs/remotes/y/main', 'HEAD']);
  writeFileSync(path.join(dir, '.git', 'config'), SLASH_REMOTE_CONFIG, { flag: 'a' });
  return dir;
};

const slashWarnings = (stderr: string): ReadonlyArray<string> =>
  stderr
    .split('\n')
    .filter((line) => line.startsWith(WARNING_PREFIX) || line.startsWith(PROMISOR_PREFIX));

const gitWarnings = (dir: string, args: ReadonlyArray<string>): ReadonlyArray<string> =>
  slashWarnings(tryRunGitWithExit(['-C', dir, ...args]).stderr);

const branchesOf = (dir: string): string =>
  runGit(['-C', dir, 'for-each-ref', '--format=%(refname)', 'refs/heads/']);

/** The `/`-named warnings tsgit logs running `run` in `dir`, as git's lines, and how `run` settled. */
const tsgitRun = async (
  dir: string,
  run: (repo: Repository) => Promise<unknown>,
): Promise<{
  readonly lines: ReadonlyArray<string>;
  readonly outcome: PromiseSettledResult<unknown>;
}> => {
  const lines: string[] = [];
  const warn = (message: string, context?: Record<string, unknown>): void => {
    if (message === TSGIT_WARNING)
      lines.push(`${WARNING_PREFIX}${context?.remote}.${context?.key}`);
    if (message === TSGIT_PROMISOR_WARNING) lines.push(`${PROMISOR_PREFIX}${context?.remote}`);
  };
  const repo = await openRepository({ cwd: dir, logger: { warn } });
  try {
    const [outcome] = await Promise.allSettled([run(repo)]);
    return { lines, outcome: outcome as PromiseSettledResult<unknown> };
  } finally {
    await repo.dispose();
  }
};

const tsgitWarnings = async (
  dir: string,
  run: (repo: Repository) => Promise<unknown>,
): Promise<ReadonlyArray<string>> => (await tsgitRun(dir, run)).lines;

const MID_TABLE_REFSPEC_CONFIG =
  '[core]\n\trepositoryformatversion = 0\n[remote "/a"]\n\turl = u\n' +
  '[remote "y"]\n\turl = /nonexistent/y.git\n\tpush = refs/heads/*:refs/x\n\tfetch = bad^\n' +
  '[remote "/b"]\n\turl = v\n';

const ROWS: ReadonlyArray<{
  readonly verb: string;
  readonly git: ReadonlyArray<string>;
  readonly run: (repo: Repository) => Promise<unknown>;
}> = [
  { verb: 'remote', git: ['remote'], run: (repo) => repo.remote.list() },
  { verb: 'fetch y', git: ['fetch', '-q', 'y'], run: (repo) => repo.fetch({ remote: 'y' }) },
  {
    verb: 'branch -d side',
    git: ['branch', '-d', 'side'],
    run: (repo) => repo.branch.delete({ name: 'side' }),
  },
  {
    verb: 'branch -D side',
    git: ['branch', '-D', 'side'],
    run: (repo) => repo.branch.delete({ name: 'side', force: true }),
  },
  { verb: 'branch z', git: ['branch', 'z'], run: (repo) => repo.branch.create({ name: 'z' }) },
  {
    verb: 'branch z side',
    git: ['branch', 'z', 'side'],
    run: (repo) => repo.branch.create({ name: 'z', startPoint: 'side' }),
  },
  {
    verb: 'branch --no-track z side',
    git: ['branch', '--no-track', 'z', 'side'],
    run: (repo) => repo.branch.create({ name: 'z', startPoint: 'side', noTrack: true }),
  },
  {
    verb: 'branch --no-track z y/main',
    git: ['branch', '--no-track', 'z', 'y/main'],
    run: (repo) => repo.branch.create({ name: 'z', startPoint: 'y/main', noTrack: true }),
  },
  {
    verb: 'branch z side~0',
    git: ['branch', 'z', 'side~0'],
    run: (repo) => repo.branch.create({ name: 'z', startPoint: 'side~0' }),
  },
  {
    verb: 'branch side',
    git: ['branch', 'side'],
    run: (repo) => repo.branch.create({ name: 'side' }),
  },
  { verb: 'status --porcelain', git: ['status', '--porcelain'], run: (repo) => repo.status() },
  { verb: 'log -1', git: ['log', '-1'], run: (repo) => repo.log({ limit: 1 }) },
];

const PINNED_SUBMODULES =
  '[submodule "a"]\n\tpath = a\n\turl = ../sub\n\tupdate = none\n' +
  '[submodule "b"]\n\tpath = b\n\turl = ./b\n\tupdate = none\n' +
  '[submodule "c"]\n\tpath = c\n\turl = /abs/c\n\tupdate = none\n';

/** The superproject every submodule row clones: three `update = none` gitlinks,
 *  two of them under relative urls. Built once, lazily. */
let superDir: string | undefined;
const superproject = (): string => {
  if (superDir !== undefined) return superDir;
  const dir = path.join(root, 'super');
  runGit(['init', '-q', '-b', 'main', dir]);
  writeFileSync(path.join(dir, '.gitmodules'), PINNED_SUBMODULES);
  for (const name of ['a', 'b', 'c']) {
    runGit(['-C', dir, 'update-index', '--add', '--cacheinfo', `160000,${PIN},${name}`]);
  }
  runGit(['-C', dir, 'add', '.gitmodules']);
  runGit(['-C', dir, 'commit', '-q', '-m', 'pins']);
  superDir = dir;
  return dir;
};

/** A clone of {@link superproject} configuring `/`-named remotes, its rows
 *  registered first when `init`. */
const cloneSuperWithSlashRemote = (slug: string, init: boolean): string => {
  const dir = path.join(root, slug);
  runGit(['clone', '-q', superproject(), dir]);
  if (init) runGit(['-C', dir, 'submodule', 'init', '-q']);
  writeFileSync(path.join(dir, '.git', 'config'), SLASH_REMOTE_CONFIG, { flag: 'a' });
  return dir;
};

const SUBMODULE_ROWS: ReadonlyArray<{
  readonly verb: string;
  readonly init: boolean;
  readonly git: ReadonlyArray<string>;
  readonly run: (repo: Repository) => Promise<unknown>;
}> = [
  { verb: 'init', init: false, git: ['submodule', 'init'], run: (repo) => repo.submodule.init() },
  {
    verb: 'init c',
    init: false,
    git: ['submodule', 'init', 'c'],
    run: (repo) => repo.submodule.init({ paths: ['c'] }),
  },
  {
    verb: 'init, registered',
    init: true,
    git: ['submodule', 'init'],
    run: (repo) => repo.submodule.init(),
  },
  {
    verb: 'update --init',
    init: false,
    git: ['submodule', 'update', '--init'],
    run: (repo) => repo.submodule.update({ init: true }),
  },
  { verb: 'sync', init: true, git: ['submodule', 'sync'], run: (repo) => repo.submodule.sync() },
];

describe.skipIf(!GIT_AVAILABLE)('Given a repository configuring /-named remotes', () => {
  describe.each(ROWS)('When $verb runs under git and tsgit', ({ verb, git, run }) => {
    it(
      'Then both warn the same lines, once per entry of each /-named remote',
      async () => {
        // Arrange
        const slug = verb.replace(/[^a-z]+/g, '-');
        const gitDir = repoWithSlashRemote(`git-${slug}`);
        const tsgitDir = repoWithSlashRemote(`tsgit-${slug}`);
        const sut = run;

        // Act
        const result = await tsgitWarnings(tsgitDir, sut);

        // Assert
        expect(result).toEqual(gitWarnings(gitDir, git));
      },
      ROW_TIMEOUT,
    );
  });

  describe.each(SUBMODULE_ROWS)(
    'When submodule $verb runs under git and tsgit',
    ({ verb, init, git, run }) => {
      it(
        'Then both warn the same lines, once per command however many relative urls resolve',
        async () => {
          // Arrange
          const slug = `submodule-${verb.replace(/[^a-z]+/g, '-')}`;
          const gitDir = cloneSuperWithSlashRemote(`git-${slug}`, init);
          const tsgitDir = cloneSuperWithSlashRemote(`tsgit-${slug}`, init);
          const sut = run;

          // Act
          const result = await tsgitWarnings(tsgitDir, sut);

          // Assert
          expect(result).toEqual(gitWarnings(gitDir, git));
        },
        ROW_TIMEOUT,
      );
    },
  );

  describe('When fetch y runs under git and tsgit with a /-named promisor remote', () => {
    it(
      "Then both warn the remote table's entries, then the promisor name",
      async () => {
        // Arrange
        const [gitDir, tsgitDir] = ['git-fetch-promisor', 'tsgit-fetch-promisor'].map((slug) => {
          const dir = repoWithSlashRemote(slug);
          writeFileSync(path.join(dir, '.git', 'config'), '[remote "/p"]\n\tpromisor = true\n', {
            flag: 'a',
          });
          return dir;
        }) as [string, string];
        const sut = (repo: Repository) => repo.fetch({ remote: 'y' });

        // Act
        const result = await tsgitWarnings(tsgitDir, sut);

        // Assert
        expect(result).toEqual(gitWarnings(gitDir, ['fetch', '-q', 'y']));
      },
      ROW_TIMEOUT,
    );
  });

  describe.each(
    ROWS.filter(({ verb }) =>
      ['remote', 'fetch y', 'branch -d side', 'branch z', 'branch z side'].includes(verb),
    ),
  )('When $verb meets an unusable refspec between two /-named remotes', ({ verb, git, run }) => {
    it(
      'Then both warn up to that spec, then die on it',
      async () => {
        // Arrange
        const slug = `refspec-${verb.replace(/[^a-z]+/g, '-')}`;
        const [gitDir, tsgitDir] = [`git-${slug}`, `tsgit-${slug}`].map((name) => {
          const dir = repoWithSlashRemote(name);
          writeFileSync(path.join(dir, '.git', 'config'), MID_TABLE_REFSPEC_CONFIG);
          return dir;
        }) as [string, string];
        const sut = run;

        // Act
        const { lines: result, outcome } = await tsgitRun(tsgitDir, sut);
        const refusal = (outcome as PromiseRejectedResult).reason.data;

        // Assert
        const expected = tryRunGitWithExit(['-C', gitDir, ...git]);
        expect(expected.exitCode).toBe(128);
        expect(expected.stderr).toContain(`fatal: invalid refspec '${refusal.raw}'`);
        expect(result).toEqual(slashWarnings(expected.stderr));
        expect(branchesOf(tsgitDir)).toEqual(branchesOf(gitDir));
      },
      ROW_TIMEOUT,
    );
  });

  describe('When git and tsgit list the remotes', () => {
    it('Then neither lists a /-named one', async () => {
      // Arrange
      const dir = repoWithSlashRemote('list');
      const repo = await openRepository({ cwd: dir });
      const sut = repo.remote.list;

      // Act
      const result = await sut().finally(() => repo.dispose());

      // Assert
      expect(result.remotes.map((remote) => remote.name)).toEqual(
        runGit(['-C', dir, 'remote']).split('\n').filter(Boolean),
      );
    });
  });
});
