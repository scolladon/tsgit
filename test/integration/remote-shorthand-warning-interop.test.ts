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
 *   interopSurface: remote, fetch, branch, status
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Repository } from '../../src/index.node.js';
import { openRepository } from '../../src/index.node.js';
import { GIT_AVAILABLE, runGit, tryRunGitWithExit } from './interop-helpers.js';

const ROW_TIMEOUT = 30_000;
const WARNING_PREFIX = "warning: config remote shorthand cannot begin with '/': ";
const TSGIT_WARNING = "readRemoteConfig: config remote shorthand cannot begin with '/'";
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

/** A repository on `main` with a merged `side` branch and a `/`-named remote. */
const repoWithSlashRemote = (slug: string): string => {
  const dir = path.join(root, slug);
  runGit(['init', '-q', '-b', 'main', dir]);
  runGit(['-C', dir, 'commit', '-q', '--allow-empty', '-m', 'c']);
  runGit(['-C', dir, 'branch', 'side']);
  writeFileSync(path.join(dir, '.git', 'config'), SLASH_REMOTE_CONFIG, { flag: 'a' });
  return dir;
};

const gitWarnings = (dir: string, args: ReadonlyArray<string>): ReadonlyArray<string> =>
  tryRunGitWithExit(['-C', dir, ...args])
    .stderr.split('\n')
    .filter((line) => line.startsWith(WARNING_PREFIX));

const tsgitWarnings = async (
  dir: string,
  run: (repo: Repository) => Promise<unknown>,
): Promise<ReadonlyArray<string>> => {
  const lines: string[] = [];
  const warn = (message: string, context?: Record<string, unknown>): void => {
    if (message === TSGIT_WARNING)
      lines.push(`${WARNING_PREFIX}${context?.remote}.${context?.key}`);
  };
  const repo = await openRepository({ cwd: dir, logger: { warn } });
  try {
    await Promise.allSettled([run(repo)]);
    return lines;
  } finally {
    await repo.dispose();
  }
};

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
  { verb: 'status --porcelain', git: ['status', '--porcelain'], run: (repo) => repo.status() },
  { verb: 'log -1', git: ['log', '-1'], run: (repo) => repo.log({ limit: 1 }) },
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
