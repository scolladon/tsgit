/**
 * Cross-tool interop — an empty pathspec. git's `parse_pathspec` reads every
 * argument for an empty one before it parses any, and refuses it whatever the
 * command: `add`, `rm`, `grep`, a `checkout` path restore, and a `checkout`
 * whose switch argument no revision answers, which git reads as a path. tsgit
 * refuses each with `EMPTY_PATHSPEC`, even beside an argument outside the
 * repository.
 *
 * @proves
 *   surface:        add, rm, grep, checkout
 *   bucket:         cross-tool-interop
 *   unique:         an empty pathspec is refused before any pattern is read
 *   interopSurface: add, rm, grep, checkout
 */
import { mkdtemp, realpath, rm as removePath, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/index.js';
import { add } from '../../src/application/commands/add.js';
import { checkout } from '../../src/application/commands/checkout.js';
import { grep } from '../../src/application/commands/grep.js';
import { rm } from '../../src/application/commands/rm.js';
import type { TsgitError } from '../../src/domain/error.js';
import type { Context } from '../../src/ports/context.js';
import { GIT_AVAILABLE, runGit, runGitEnv, tryRunGitWithExit } from './interop-helpers.js';

const GIT_EMPTY_PATHSPEC = 'fatal: empty string is not a valid pathspec.';
const GIT_FATAL_EXIT = 128;

const IDENTITY_ENV = {
  ...runGitEnv(),
  GIT_AUTHOR_DATE: '@1700000000 +0000',
  GIT_COMMITTER_DATE: '@1700000000 +0000',
};

interface Row {
  readonly label: string;
  readonly gitArgs: ReadonlyArray<string>;
  readonly run: (ctx: Context) => Promise<unknown>;
}

const ROWS: ReadonlyArray<Row> = [
  { label: 'add', gitArgs: ['add', ''], run: (ctx) => add(ctx, ['']) },
  { label: 'rm', gitArgs: ['rm', ''], run: (ctx) => rm(ctx, ['']) },
  {
    label: 'grep',
    gitArgs: ['grep', 'a', '--', ''],
    run: (ctx) => grep(ctx, { patterns: [/a/], paths: [''] }),
  },
  {
    label: 'a checkout path restore',
    gitArgs: ['checkout', '--', ''],
    run: (ctx) => checkout(ctx, { paths: [''] }),
  },
  {
    label: 'a checkout path restore beside a path outside the repository',
    gitArgs: ['checkout', '--', '../x', ''],
    run: (ctx) => checkout(ctx, { paths: ['../x', ''] }),
  },
  {
    label: 'a checkout of a switch argument',
    gitArgs: ['checkout', ''],
    run: (ctx) => checkout(ctx, { rev: '' }),
  },
];

const refusalOf = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    await run();
  } catch (error) {
    return (error as TsgitError).data;
  }
  return undefined;
};

describe.skipIf(!GIT_AVAILABLE)('Given an empty pathspec', () => {
  let root = '';

  beforeAll(async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-empty-pathspec-')));
  });

  afterAll(async () => {
    await removePath(root, { recursive: true, force: true });
  });

  const repoAt = async (slug: string): Promise<string> => {
    const repo = path.join(root, slug);
    runGit(['init', '-q', '-b', 'main', repo]);
    await writeFile(path.join(repo, 'a'), 'a\n');
    runGit(['-C', repo, 'add', 'a']);
    runGit(['-C', repo, '-c', 'user.name=A', '-c', 'user.email=a@a', 'commit', '-qm', 'c'], {
      env: IDENTITY_ENV,
    });
    return repo;
  };

  describe.each(ROWS)('When git and tsgit run $label', ({ label, gitArgs, run }) => {
    it('Then both refuse the empty pathspec', async () => {
      // Arrange
      const slug = label.replaceAll(/[^a-z]/gi, '');
      const gitRepo = await repoAt(`git-${slug}`);
      const tsgitRepo = await repoAt(`tsgit-${slug}`);
      const sut = run;

      // Act
      const git = tryRunGitWithExit(['-C', gitRepo, ...gitArgs]);
      const result = await refusalOf(() => sut(createNodeContext({ workDir: tsgitRepo })));

      // Assert
      expect(git.exitCode).toBe(GIT_FATAL_EXIT);
      expect(git.stderr).toContain(GIT_EMPTY_PATHSPEC);
      expect(result).toEqual({ code: 'EMPTY_PATHSPEC' });
    });
  });
});
