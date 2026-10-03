/**
 * Cross-tool interop — `revParse`'s suffix grammar against `git rev-parse`.
 * One repository is built once with canonical git: three commits, a chain of
 * annotated tags each naming the previous one, and a tag naming an absent
 * object. Each row resolves the same argument through both and compares the
 * object id, or that neither resolves, and the `error:` lines each printed.
 *
 * @proves
 *   surface:        revParse
 *   bucket:         cross-tool-interop
 *   unique:         the ~, ^{}, ^{object} and ^{/regex} suffixes and unbounded tag peeling read like git's get_oid
 *   interopSurface: revParse
 */
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { revParse } from '../../src/application/commands/rev-parse.js';
import type { TsgitError } from '../../src/domain/error.js';
import { openRepository } from '../../src/index.node.js';
import {
  disableAutoMaintenance,
  GIT_AVAILABLE,
  git,
  runGit,
  runGitEnv,
  tryRunGitWithExit,
} from './interop-helpers.js';

const SETUP_TIMEOUT = 60_000;
const EPOCH = 1_700_000_000;
const TAG_CHAIN_LENGTH = 6;
const ABSENT_OID = '1'.repeat(40);

const identityAt = (offset: number): NodeJS.ProcessEnv => ({
  ...runGitEnv(),
  GIT_AUTHOR_NAME: 'A',
  GIT_AUTHOR_EMAIL: 'a@x',
  GIT_AUTHOR_DATE: `${EPOCH + offset} +0000`,
  GIT_COMMITTER_NAME: 'A',
  GIT_COMMITTER_EMAIL: 'a@x',
  GIT_COMMITTER_DATE: `${EPOCH + offset} +0000`,
});

const ERROR_PREFIX = 'error: ';

interface Outcome {
  readonly id: string | undefined;
  readonly errors: ReadonlyArray<string>;
}

const gitOutcome = (repo: string, argument: string): Outcome => {
  const result = tryRunGitWithExit(['-C', repo, 'rev-parse', argument], {
    env: runGitEnv(),
  });
  const errors = result.stderr
    .split('\n')
    .filter((line) => line.startsWith(ERROR_PREFIX))
    .map((line) => line.slice(ERROR_PREFIX.length));
  return { id: result.exitCode === 0 ? result.stdout.trim() : undefined, errors };
};

const tsgitOutcome = async (repo: string, argument: string): Promise<Outcome> => {
  const errors: string[] = [];
  const ctx = {
    ...createNodeContext({ workDir: repo }),
    logger: { error: (message: string) => errors.push(message) },
  };
  try {
    return { id: await revParse(ctx, argument), errors };
  } catch {
    return { id: undefined, errors };
  }
};

const buildRepository = (repo: string): void => {
  runGit(['init', '-q', '-b', 'main', repo]);
  disableAutoMaintenance(repo);
  ['first fix', 'second', 'third feature'].forEach((message, offset) => {
    runGit(['-C', repo, 'commit', '-q', '--allow-empty', '-m', message], {
      env: identityAt(offset),
    });
  });
  for (let level = 1; level <= TAG_CHAIN_LENGTH; level += 1) {
    const target = level === 1 ? 'HEAD' : `t${level - 1}`;
    runGit(['-C', repo, 'tag', '-a', '-m', `t${level}`, `t${level}`, target], {
      env: identityAt(100),
    });
  }
  const dangling = `object ${ABSENT_OID}\ntype commit\ntag bad\ntagger A <a@x> ${EPOCH} +0000\n\nbad\n`;
  const badTag = runGit(['-C', repo, 'hash-object', '-t', 'tag', '-w', '--stdin', '--literally'], {
    input: dangling,
  }).trim();
  git(repo, 'update-ref', 'refs/tags/bad', badTag);
};

describe.skipIf(!GIT_AVAILABLE)('integration — revParse suffix grammar parity with git', () => {
  let repo = '';

  beforeAll(async () => {
    repo = await mkdtemp(path.join(os.tmpdir(), 'tsgit-rev-parse-grammar-interop-'));
    buildRepository(repo);
  }, SETUP_TIMEOUT);

  afterAll(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  describe('Given commits, a six-deep tag chain and a tag naming an absent object', () => {
    describe.each([
      'HEAD~',
      'HEAD~~',
      'HEAD~^',
      'HEAD^{}',
      't1^{}',
      't6^{}',
      't6^{}~1',
      'HEAD^{object}',
      't6^{object}',
      'bad^{}',
      'bad^{object}',
      'bad^{commit}',
      't6^{commit}',
      't6^{tree}',
    ])('When git rev-parse and revParse read %s', (argument) => {
      it('Then both resolve the same object and print the same errors', async () => {
        // Arrange
        const peer = gitOutcome(repo, argument);

        // Act
        const result = await tsgitOutcome(repo, argument);

        // Assert
        expect(result).toEqual(peer);
      });
    });
  });
});

describe.skipIf(!GIT_AVAILABLE)(
  'integration — revParse relative tree paths parity with git',
  () => {
    let repo = '';
    let bare = '';

    beforeAll(async () => {
      repo = await realpath(
        await mkdtemp(path.join(os.tmpdir(), 'tsgit-rev-parse-relative-interop-')),
      );
      runGit(['init', '-q', '-b', 'main', repo]);
      disableAutoMaintenance(repo);
      await mkdir(path.join(repo, 'd'));
      await writeFile(path.join(repo, 'd', 'f'), 'x\n');
      await writeFile(path.join(repo, 'g'), 'y\n');
      git(repo, 'add', '.');
      runGit(['-C', repo, 'commit', '-q', '-m', 'c1'], { env: identityAt(0) });
      bare = `${repo}.git`;
      runGit(['clone', '-q', '--bare', repo, bare]);
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      await rm(repo, { recursive: true, force: true });
      await rm(bare, { recursive: true, force: true });
    });

    describe.each([
      'HEAD:./g',
      'HEAD:./d/../g',
      'HEAD:./d/./f',
      'HEAD:./',
      'HEAD:.//d//f',
      'HEAD:./d/',
      ':0:./g',
      ':0:./d/../g',
    ])('Given a worktree, When git rev-parse and revParse read %s', (argument) => {
      it('Then both resolve the same object', async () => {
        // Arrange
        const peer = gitOutcome(repo, argument);

        // Act
        const result = await tsgitOutcome(repo, argument);

        // Assert
        expect(peer.id).toBeDefined();
        expect(result).toEqual(peer);
      });
    });

    describe.each(['HEAD:../g', 'HEAD:./d/../../g', ':0:../g'])(
      'Given a worktree, When git rev-parse and revParse read %s',
      (argument) => {
        it('Then both refuse the path as outside the repository', async () => {
          // Arrange
          const peer = tryRunGitWithExit(['-C', repo, 'rev-parse', argument], { env: runGitEnv() });
          const sut = revParse;

          // Act
          const result = await sut(createNodeContext({ workDir: repo }), argument).catch(
            (error: TsgitError) => error.data,
          );

          // Assert
          const { path: outside } = result as { readonly path: string };
          expect(peer.exitCode).toBe(128);
          expect(peer.stderr).toContain(`fatal: '${outside}' is outside repository at '${repo}'`);
          expect(result).toMatchObject({ code: 'PATHSPEC_OUTSIDE_REPO' });
        });
      },
    );

    describe.each(['HEAD:./g', 'HEAD:../g'])(
      'Given a bare repository, When git rev-parse and revParse read %s',
      (argument) => {
        it('Then both refuse relative path syntax', async () => {
          // Arrange
          const peer = tryRunGitWithExit(['-C', bare, 'rev-parse', argument], { env: runGitEnv() });
          const sut = revParse;

          // Act
          const opened = await openRepository({ cwd: bare });
          const result = await sut(opened.ctx, argument).catch((error: TsgitError) => error.data);
          await opened.dispose();

          // Assert
          expect(peer.exitCode).toBe(128);
          expect(peer.stderr).toContain(
            "fatal: relative path syntax can't be used outside working tree",
          );
          expect(result).toEqual({ code: 'WORK_TREE_REQUIRED', operation: 'relative path syntax' });
        });
      },
    );
  },
);

const EMPTY_TREE_INPUT = '';

/**
 * c1 ← c2 ← a ← m, with c2 ← s1 ← s2 merged into m: a and s1 share a date,
 * s2 is younger. Raw commits beside: `nobody` (no message) on m, `mp`
 * naming an absent parent then `nobody`, `bp` a blob then c1, `z` a message
 * holding a NUL; `tt` an annotated tag of the tree; `dia` a diamond whose
 * shared parent names an absent parent.
 */
const buildSearchRepository = (repo: string): void => {
  runGit(['init', '-q', '-b', 'main', repo]);
  disableAutoMaintenance(repo);
  const tree = runGit(['-C', repo, 'hash-object', '-t', 'tree', '-w', '--stdin'], {
    input: EMPTY_TREE_INPUT,
  }).trim();
  const commit = (message: string, offset: number, parents: ReadonlyArray<string>): string =>
    runGit(
      [
        '-C',
        repo,
        'commit-tree',
        tree,
        ...parents.flatMap((parent) => ['-p', parent]),
        '-m',
        message,
      ],
      { env: identityAt(offset) },
    ).trim();
  const raw = (name: string, content: string): void => {
    const id = runGit(['-C', repo, 'hash-object', '-t', 'commit', '-w', '--stdin', '--literally'], {
      input: content,
    }).trim();
    git(repo, 'update-ref', `refs/tags/${name}`, id);
  };
  const header = (parents: ReadonlyArray<string>, offset: number): string =>
    `tree ${tree}\n${parents.map((parent) => `parent ${parent}\n`).join('')}author A <a@x> ${EPOCH + offset} +0000\ncommitter A <a@x> ${EPOCH + offset} +0000\n`;
  const c1 = commit('first fix', 1, []);
  const c2 = commit('second !bang', 2, [c1]);
  const a = commit('main same-date', 5, [c2]);
  const s1 = commit('side same-date', 5, [c2]);
  const s2 = commit('side newer', 7, [s1]);
  const m = commit('merge it', 9, [a, s2]);
  git(repo, 'update-ref', 'refs/heads/main', m);
  raw('nobody', header([m], 20));
  const nobody = git(repo, 'rev-parse', 'nobody').trim();
  raw('mp', `${header([ABSENT_OID, nobody], 30)}\nmissing parent\n`);
  const blob = runGit(['-C', repo, 'hash-object', '-w', '--stdin'], { input: 'b\n' }).trim();
  raw('bp', `${header([blob, c1], 31)}\nblob parent\n`);
  raw('z', `${header([c1], 40)}\nhead\u0000tail\n`);
  runGit(['-C', repo, 'tag', '-a', '-m', 'tt', 'tt', tree], { env: identityAt(100) });
  raw('shared', `${header([ABSENT_OID], 50)}\nshared\n`);
  const shared = git(repo, 'rev-parse', 'shared').trim();
  const left = commit('left', 51, [shared]);
  const right = commit('right', 52, [shared]);
  git(repo, 'update-ref', 'refs/tags/dia', commit('top', 53, [left, right]));
};

describe.skipIf(!GIT_AVAILABLE)('integration — revParse ^{/regex} search parity with git', () => {
  let repo = '';

  beforeAll(async () => {
    repo = await mkdtemp(path.join(os.tmpdir(), 'tsgit-rev-parse-search-interop-'));
    buildSearchRepository(repo);
  }, SETUP_TIMEOUT);

  afterAll(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  describe('Given a merge, commits sharing a date, a message-less commit and broken parents', () => {
    describe.each([
      'HEAD^{/same-date}',
      'HEAD^{/side}',
      'HEAD^{/^(main|side) same}',
      'HEAD^{/s(ec|id)}',
      'HEAD^{/[[:alpha:]]+ fix}',
      'HEAD^{/date$}',
      'HEAD^{/^merge it$}',
      'HEAD^{/merge}',
      'HEAD^{/}',
      'HEAD^{/!-same}',
      'HEAD^{/!!bang}',
      'HEAD^{/!x}',
      'HEAD^{/nomatch}',
      'HEAD^{/sec}~1',
      'HEAD^{/sec}^{/first}',
      'HEAD^{/fix}:',
      'HEAD^{commit}x}',
      'HEAD^{commit}@{0}',
      'nobody^{/!-zzz}',
      'nobody^{/.}',
      'mp^{/second}',
      'mp^{/zzz}',
      'mp^{/}',
      'dia^{/zzz}',
      'bp^{/first}',
      'z^{/head}',
      'z^{/tail}',
      'tt^{/x}',
    ])('When git rev-parse and revParse read %s', (argument) => {
      it('Then both resolve the same object and print the same errors', async () => {
        // Arrange
        const peer = gitOutcome(repo, argument);

        // Act
        const result = await tsgitOutcome(repo, argument);

        // Assert
        expect(result).toEqual(peer);
      });
    });
  });
});

/**
 * c1 ← c2, then same-date tips on c2: main (HEAD), a, z and an unnamed
 * `head`; `bad` tags an absent commit, `tt` the tree, `dangling` names an
 * absent object, `broken` holds no ref and `stale` points at an absent ref.
 * The index holds `f` and `4:x`.
 */
const buildRefsRepository = async (repo: string): Promise<string> => {
  runGit(['init', '-q', '-b', 'main', repo]);
  disableAutoMaintenance(repo);
  const tree = runGit(['-C', repo, 'hash-object', '-t', 'tree', '-w', '--stdin'], {
    input: EMPTY_TREE_INPUT,
  }).trim();
  const commit = (message: string, offset: number, parents: ReadonlyArray<string>): string =>
    runGit(
      [
        '-C',
        repo,
        'commit-tree',
        tree,
        ...parents.flatMap((parent) => ['-p', parent]),
        '-m',
        message,
      ],
      { env: identityAt(offset) },
    ).trim();
  const c2 = commit('second', 2, [commit('first fix', 1, [])]);
  for (const name of ['main', 'a', 'z']) {
    git(repo, 'update-ref', `refs/heads/${name}`, commit(`tip ${name}`, 5, [c2]));
  }
  const dangling = `object ${ABSENT_OID}\ntype commit\ntag bad\ntagger A <a@x> ${EPOCH} +0000\n\nbad\n`;
  const badTag = runGit(['-C', repo, 'hash-object', '-t', 'tag', '-w', '--stdin', '--literally'], {
    input: dangling,
  }).trim();
  git(repo, 'update-ref', 'refs/tags/bad', badTag);
  runGit(['-C', repo, 'tag', '-a', '-m', 'tt', 'tt', tree], { env: identityAt(100) });
  await writeFile(path.join(repo, '.git', 'refs', 'heads', 'dangling'), `${ABSENT_OID}\n`);
  await writeFile(path.join(repo, '.git', 'refs', 'heads', 'broken'), 'garbage\n');
  git(repo, 'symbolic-ref', 'refs/heads/stale', 'refs/heads/gone');
  await writeFile(path.join(repo, 'f'), 'x\n');
  await writeFile(path.join(repo, '4:x'), 'y\n');
  git(repo, 'add', 'f', '4:x');
  return commit('tip head', 5, [c2]);
};

describe.skipIf(!GIT_AVAILABLE)('integration — revParse :/regex and :path parity with git', () => {
  let repo = '';
  let unnamed = '';

  beforeAll(async () => {
    repo = await mkdtemp(path.join(os.tmpdir(), 'tsgit-rev-parse-refs-search-interop-'));
    unnamed = await buildRefsRepository(repo);
  }, SETUP_TIMEOUT);

  afterAll(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  describe('Given same-date tips, a tag of an absent object and an index', () => {
    describe.each([
      ':/tip',
      ':/tip (a|z)',
      ':/second',
      ':/!-tip',
      ':/zzz',
      ':/!x',
      ':f',
      ':0:f',
      ':./f',
      ':4:x',
      ':0',
      ':',
      ':nope',
    ])('When git rev-parse and revParse read %s', (argument) => {
      it('Then both resolve the same object and print the same errors', async () => {
        // Arrange
        const peer = gitOutcome(repo, argument);

        // Act
        const result = await tsgitOutcome(repo, argument);

        // Assert
        expect(result).toEqual(peer);
      });
    });
  });

  describe('Given HEAD detached at a commit no ref names', () => {
    describe('When git rev-parse and revParse read :/tip', () => {
      it('Then both search HEAD first', async () => {
        // Arrange
        git(repo, 'update-ref', '--no-deref', 'HEAD', unnamed);
        const peer = gitOutcome(repo, ':/tip');

        // Act
        const result = await tsgitOutcome(repo, ':/tip');

        // Assert
        expect(peer.id).toBe(unnamed);
        expect(result).toEqual(peer);
      });
    });
  });
});
