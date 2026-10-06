/**
 * Cross-tool interop — `merge`'s and `pull`'s squash, no-commit, strategy and
 * mergeoptions behaviour. One history is cloned per tool; each tool merges (or
 * pulls) the same head under a pinned identity and date, and the on-disk
 * state — state files and their bytes, the index, HEAD, the concluding commit
 * — must agree with canonical git.
 *
 * @proves
 *   surface:        repo.merge.run
 *   bucket:         cross-tool-interop
 *   unique:         merge and pull leave git's squash and stop state byte for byte
 *   interopSurface: merge
 */
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { chmod, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { mergeRun } from '../../src/application/commands/merge.js';
import { pull } from '../../src/application/commands/pull.js';
import type { TsgitError } from '../../src/domain/error.js';
import type { AuthorIdentity } from '../../src/domain/objects/index.js';
import { openRepository } from '../../src/index.node.js';
import type { Context } from '../../src/ports/context.js';
import { backendTransport } from './http-backend-transport.js';
import { GIT_AVAILABLE, git, runGit, runGitEnv, tryRunGitWithExit } from './interop-helpers.js';

const PEER_URL = 'https://example.com/peer.git';
const SHORT_URL = 'https://example.com/peer';
const EPOCH = 1_700_000_000;
const IDENTITY: AuthorIdentity = {
  name: 't',
  email: 't@t',
  timestamp: EPOCH,
  timezoneOffset: '+0000',
};
const DATED_ENV: NodeJS.ProcessEnv = {
  ...runGitEnv(),
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
  GIT_AUTHOR_DATE: `${EPOCH} +0000`,
  GIT_COMMITTER_DATE: `${EPOCH} +0000`,
  GIT_EDITOR: 'true',
};
const LINES = '1\n2\n3\n4\n5\n6\n7\n8\n';
const STATE_FILES = ['MERGE_HEAD', 'MERGE_MSG', 'MERGE_MODE', 'SQUASH_MSG', 'ORIG_HEAD'];

let root: string;
let peerRoot: string;
let peerPath: string;
let clones = 0;

const dated = (args: ReadonlyArray<string>): string => runGit(args, { env: DATED_ENV });
const datedExit = (dir: string, args: ReadonlyArray<string>) =>
  tryRunGitWithExit(['-C', dir, ...args], { env: DATED_ENV });

const commitFile = (dir: string, file: string, body: string, message: string): void => {
  writeFileSync(path.join(dir, file), body);
  dated(['-C', dir, 'add', file]);
  dated(['-C', dir, 'commit', '-q', '-m', message]);
};

beforeAll(() => {
  if (!GIT_AVAILABLE) return;
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'tsgit-interop-merge-options-')));
  peerRoot = path.join(root, 'peer');
  peerPath = path.join(peerRoot, 'peer.git');
  const work = path.join(root, 'work');
  dated(['init', '-q', '-b', 'main', work]);
  commitFile(work, 'f', 'base\n', 'base');
  commitFile(work, 'big', LINES, 'lines');
  dated(['-C', work, 'tag', 'start']);
  dated(['-C', work, 'checkout', '-q', '-b', 'edits']);
  commitFile(work, 'big', LINES.replace('2\n', 'two\n'), 'edit two');
  dated(['-C', work, 'checkout', '-q', '-b', 'clean', 'main']);
  commitFile(work, 's2', 's2\n', 'clean one');
  dated(['-C', work, 'checkout', '-q', '-b', 'side', 'main']);
  commitFile(work, 's1', 's1\n', 'side one');
  commitFile(work, 'f', 'side\n', 'conflicting');
  dated(['-C', work, 'checkout', '-q', '--orphan', 'orphan']);
  dated(['-C', work, 'rm', '-q', '-r', '--cached', '.']);
  commitFile(work, 'o', 'o\n', 'orphan');
  dated(['-C', work, 'checkout', '-q', '-f', 'main']);
  commitFile(work, 'f', 'main\n', 'main');
  commitFile(work, 'big', LINES.replace('7\n', 'seven\n'), 'edit seven');
  dated(['clone', '-q', '--bare', work, peerPath]);
});

afterAll(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

interface Clones {
  readonly ours: string;
  readonly theirs: string;
}

/** One clone per tool on `main`, configured alike but for the url tsgit reaches the peer by. */
const setUp = (config: ReadonlyArray<readonly [string, string]> = []): Clones => {
  clones += 1;
  const dirs = {
    ours: path.join(root, `${clones}-ours`),
    theirs: path.join(root, `${clones}-theirs`),
  };
  for (const [dir, url] of [
    [dirs.ours, PEER_URL],
    [dirs.theirs, peerPath],
  ] as const) {
    dated(['clone', '-q', '-b', 'main', peerPath, dir]);
    dated(['-C', dir, 'remote', 'set-url', 'origin', url]);
    for (const [key, value] of config) dated(['-C', dir, 'config', key, value]);
  }
  return dirs;
};

const contextOf = (dir: string): Context => ({
  ...createNodeContext({ workDir: dir }),
  transport: backendTransport(peerRoot),
});

const stateFile = (dir: string, name: string): string | undefined => {
  const file = path.join(dir, '.git', name);
  return existsSync(file) ? readFileSync(file, 'utf8') : undefined;
};

/** The state files present with their bytes, the index and HEAD. */
const snapshot = (dir: string) => ({
  state: Object.fromEntries(STATE_FILES.map((name) => [name, stateFile(dir, name)])),
  index: git(dir, 'ls-files', '--stage'),
  head: git(dir, 'rev-parse', 'HEAD'),
  note: git(dir, 'reflog', '-1', '--format=%gs'),
});

/** git's snapshot after a pull, its state files spelling the peer as the url tsgit fetched from. */
const pulledSnapshot = (dir: string) => {
  const taken = snapshot(dir);
  const spelt = peerPath.slice(0, -'.git'.length);
  const state = Object.entries(taken.state).map(([name, bytes]) => [
    name,
    bytes?.replaceAll(spelt, SHORT_URL),
  ]);
  return { ...taken, state: Object.fromEntries(state) };
};

describe.skipIf(!GIT_AVAILABLE)('merge options interop', () => {
  describe('Given a squash merge that conflicts', () => {
    describe('When both tools squash-merge the head', () => {
      it('Then the squash state, conflict stages and HEAD are identical', async () => {
        // Arrange
        const { ours, theirs } = setUp();
        const repo = await openRepository({ cwd: ours });
        const sut = repo.merge.run;
        const theirsRun = datedExit(theirs, ['merge', '--squash', 'origin/side']);

        // Act
        const result = await sut({ rev: 'origin/side', squash: true, author: IDENTITY });
        await repo.dispose();

        // Assert
        expect(theirsRun.exitCode).toBe(1);
        expect(result.kind).toBe('squashed');
        expect(snapshot(ours)).toEqual(snapshot(theirs));
      });
    });

    describe('When both tools resolve it and commit without a message', () => {
      it('Then the concluding commit is identical', async () => {
        // Arrange
        const { ours, theirs } = setUp();
        datedExit(theirs, ['merge', '--squash', 'origin/side']);
        const repo = await openRepository({ cwd: ours });
        await repo.merge.run({ rev: 'origin/side', squash: true, author: IDENTITY });
        for (const dir of [ours, theirs]) await writeFile(path.join(dir, 'f'), 'resolved\n');
        dated(['-C', theirs, 'add', 'f']);
        dated(['-C', theirs, 'commit', '-q']);
        await repo.add(['f']);
        const sut = repo.commit;

        // Act
        await sut({ message: '', author: IDENTITY, committer: IDENTITY });
        await repo.dispose();

        // Assert
        expect(snapshot(ours)).toEqual(snapshot(theirs));
      });
    });
  });

  describe('Given a pull with squash whose merge conflicts', () => {
    describe('When both tools pull the head', () => {
      it('Then the squash state, conflict stages and HEAD are identical', async () => {
        // Arrange
        const { ours, theirs } = setUp();
        const sut = pull;
        const theirsRun = datedExit(theirs, [
          'pull',
          '-q',
          '--no-rebase',
          '--squash',
          'origin',
          'side',
        ]);

        // Act
        const result = await sut(contextOf(ours), {
          remote: 'origin',
          ref: 'side',
          rebase: false,
          squash: true,
          author: IDENTITY,
        });

        // Assert
        expect(theirsRun.exitCode).toBe(1);
        expect(result.integration === 'merge' && result.merge.kind).toBe('squashed');
        expect(snapshot(ours)).toEqual(pulledSnapshot(theirs));
      });
    });
  });

  describe.each([
    ['HEAD diverged from one head', 'main', ['origin/clean'], {}],
    ['HEAD fast-forwardable to one head', 'start', ['origin/clean'], {}],
    [
      'fastForward never over a fast-forwardable head',
      'start',
      ['origin/clean'],
      { fastForward: 'never' },
    ],
    ['two heads', 'start', ['origin/clean', 'origin/side'], {}],
  ] as const)('Given %s', (_label, start, revs, input) => {
    describe('When both tools merge with commit false', () => {
      it('Then the stop state, the index and HEAD are identical', async () => {
        // Arrange
        const { ours, theirs } = setUp();
        for (const dir of [ours, theirs])
          dated(['-C', dir, 'checkout', '-q', '-B', 'topic', start]);
        const flags = 'fastForward' in input ? ['--no-ff'] : [];
        datedExit(theirs, ['merge', '--no-commit', ...flags, ...revs]);
        const repo = await openRepository({ cwd: ours });
        const sut = repo.merge.run;

        // Act
        await sut({ rev: revs, commit: false, ...input, author: IDENTITY });
        await repo.dispose();

        // Assert
        expect(snapshot(ours)).toEqual(snapshot(theirs));
      });
    });
  });

  describe('Given a merge stopped by commit false', () => {
    describe('When both tools commit it without a message', () => {
      it('Then the concluding merge commit is identical', async () => {
        // Arrange
        const { ours, theirs } = setUp();
        datedExit(theirs, ['merge', '--no-commit', 'origin/clean']);
        dated(['-C', theirs, 'commit', '-q', '--no-edit']);
        const repo = await openRepository({ cwd: ours });
        await repo.merge.run({ rev: 'origin/clean', commit: false, author: IDENTITY });
        const sut = repo.commit;

        // Act
        await sut({ message: '', author: IDENTITY, committer: IDENTITY });
        await repo.dispose();

        // Assert
        expect(snapshot(ours)).toEqual(snapshot(theirs));
      });
    });
  });

  describe('Given squash with commit true', () => {
    describe('When both tools merge', () => {
      it('Then both refuse before writing ORIG_HEAD', async () => {
        // Arrange
        const { ours, theirs } = setUp();
        const theirsRun = datedExit(theirs, ['merge', '--squash', '--commit', 'origin/clean']);
        const repo = await openRepository({ cwd: ours });
        const sut = repo.merge.run;

        // Act
        const result = await sut({ rev: 'origin/clean', squash: true, commit: true }).catch(
          (e: unknown) => (e as { data: unknown }).data,
        );
        await repo.dispose();

        // Assert
        expect(theirsRun.stderr).toContain(
          "options '--squash' and '--commit.' cannot be used together",
        );
        expect(result).toEqual({ code: 'INCOMPATIBLE_OPTIONS', options: ['--squash', '--commit'] });
        expect(snapshot(ours)).toEqual(snapshot(theirs));
      });
    });
  });

  describe('Given a pull with commit false over a true merge', () => {
    describe('When both tools pull the head', () => {
      it('Then the stop state, the index and HEAD are identical', async () => {
        // Arrange
        const { ours, theirs } = setUp();
        const sut = pull;
        datedExit(theirs, ['pull', '-q', '--no-rebase', '--no-commit', 'origin', 'clean']);

        // Act
        const result = await sut(contextOf(ours), {
          remote: 'origin',
          ref: 'clean',
          rebase: false,
          commit: false,
          author: IDENTITY,
        });

        // Assert
        expect(result.integration === 'merge' && result.merge.kind).toBe('stopped');
        expect(snapshot(ours)).toEqual(pulledSnapshot(theirs));
      });
    });
  });

  describe.each([
    ['ort', 'main', ['origin/clean']],
    ['recursive', 'main', ['origin/clean']],
    ['resolve', 'main', ['origin/clean']],
    ['octopus', 'main', ['origin/clean']],
    ['ours', 'main', ['origin/clean']],
    ['ours', 'start', ['origin/clean']],
    ['resolve', 'start', ['origin/clean']],
    ['resolve', 'main', ['origin/edits']],
    ['resolve', 'main', ['origin/side']],
    ['octopus', 'main', ['origin/edits']],
    ['ort', 'main', ['origin/clean', 'origin/edits']],
    ['ours', 'main', ['origin/clean', 'origin/edits']],
    ['bogus', 'main', ['origin/clean']],
  ] as const)('Given strategy %s from %s merging %j', (strategy, start, revs) => {
    describe('When both tools merge', () => {
      it('Then the commit, reflog note, state files and index are identical', async () => {
        // Arrange
        const { ours, theirs } = setUp();
        for (const dir of [ours, theirs])
          dated(['-C', dir, 'checkout', '-q', '-B', 'topic', start]);
        datedExit(theirs, ['merge', '-s', strategy, ...revs]);
        const repo = await openRepository({ cwd: ours });
        const sut = repo.merge.run;

        // Act
        await sut({ rev: revs, strategy, author: IDENTITY, committer: IDENTITY }).catch(
          (e: unknown) => e,
        );
        await repo.dispose();

        // Assert
        expect(snapshot(ours)).toEqual(snapshot(theirs));
      });
    });
  });

  describe('Given a dirty tree and a squash that merges without a fast-forward', () => {
    describe('When both tools squash-merge with autostash', () => {
      it('Then MERGE_AUTOSTASH holds the change for the commit in both', async () => {
        // Arrange
        const { ours, theirs } = setUp();
        for (const dir of [ours, theirs]) writeFileSync(path.join(dir, 'f'), 'dirty\n');
        datedExit(theirs, ['merge', '--squash', '--autostash', 'origin/clean']);
        const repo = await openRepository({ cwd: ours });
        const sut = repo.merge.run;

        // Act
        await sut({ rev: 'origin/clean', squash: true, autostash: true, author: IDENTITY });
        await repo.dispose();

        // Assert
        const kept = (dir: string) => ({
          ...snapshot(dir),
          autostash: existsSync(path.join(dir, '.git', 'MERGE_AUTOSTASH')),
          stashes: git(dir, 'stash', 'list'),
          f: readFileSync(path.join(dir, 'f'), 'utf8'),
        });
        expect(kept(ours)).toEqual(kept(theirs));
        expect(kept(ours).autostash).toBe(true);
      });
    });
  });

  describe.each([
    ['a squash committed with a message', ['--squash', 'origin/clean'], 'squashed', 'message'],
    ['a squash committed from its draft', ['--squash', 'origin/clean'], '', 'squash'],
    ['a conflict resolved with a message', ['origin/side'], 'resolved', 'message'],
    ['a conflict resolved from its draft', ['origin/side'], '', 'merge'],
  ] as const)('Given %s', (_label, mergeArgs, message, source) => {
    describe('When both tools commit under a prepare-commit-msg hook', () => {
      it(`Then both hooks receive the ${source} source`, async () => {
        // Arrange
        const { ours, theirs } = setUp();
        const hook = '#!/bin/sh\necho "$2" >> source.log\n';
        for (const dir of [ours, theirs]) {
          const hookPath = path.join(dir, '.git', 'hooks', 'prepare-commit-msg');
          await writeFile(hookPath, hook);
          await chmod(hookPath, 0o755);
          datedExit(dir, ['merge', '-q', ...mergeArgs]);
          await writeFile(path.join(dir, 'f'), 'resolved\n');
          dated(['-C', dir, 'add', 'f']);
        }
        dated(['-C', theirs, 'commit', '-q', ...(message === '' ? [] : ['-m', message])]);
        const repo = await openRepository({ cwd: ours });
        const sut = repo.commit;

        // Act
        await sut({ message, author: IDENTITY, committer: IDENTITY });
        await repo.dispose();

        // Assert
        const logged = (dir: string) => readFileSync(path.join(dir, 'source.log'), 'utf8');
        expect(logged(ours)).toBe(logged(theirs));
        expect(logged(ours)).toBe(`${source}\n`);
      });
    });
  });

  describe('Given unrelated histories and strategy resolve', () => {
    describe('When both tools merge allowing unrelated histories', () => {
      it('Then both fail the strategy and leave HEAD and the index alone', async () => {
        // Arrange
        const { ours, theirs } = setUp();
        for (const dir of [ours, theirs]) {
          dated(['-C', dir, 'checkout', '-q', '--orphan', 'other']);
          dated(['-C', dir, 'rm', '-rqf', '.']);
          commitFile(dir, 'o', 'o\n', 'other root');
          dated(['-C', dir, 'checkout', '-q', 'main']);
        }
        const args = ['-s', 'resolve', '--allow-unrelated-histories', 'other'];
        const theirsRun = datedExit(theirs, ['merge', ...args]);
        const repo = await openRepository({ cwd: ours });
        const sut = repo.merge.run;

        // Act
        const result = await sut({
          rev: 'other',
          strategy: 'resolve',
          allowUnrelatedHistories: true,
          author: IDENTITY,
        }).catch((e: unknown) => (e as { data: unknown }).data);
        await repo.dispose();

        // Assert
        expect(theirsRun.exitCode).toBe(2);
        expect(theirsRun.stderr).toContain('Merge with strategy resolve failed.');
        expect(result).toEqual({ code: 'MERGE_STRATEGY_FAILED', strategy: 'resolve' });
        expect(snapshot(ours)).toEqual(snapshot(theirs));
      });
    });
  });

  describe.each([
    [['octopus', 'ort'], 'main', ['origin/clean'], [], 0, 0],
    [['resolve', 'octopus'], 'start', ['origin/clean'], [], 0, 0],
    [['ort', 'ours'], 'start', ['origin/clean'], [], 0, 0],
    [['resolve', 'ort'], 'main', ['origin/side'], [], 1, 0],
    [['ort', 'resolve'], 'main', ['origin/side'], [], 1, 0],
    [['octopus', 'octopus'], 'main', ['origin/side'], [], 2, 'NO_MERGE_STRATEGY_HANDLED'],
    [undefined, 'main', ['origin/clean'], [['pull.twohead', 'ours resolve']], 0, 0],
    [undefined, 'main', ['origin/clean'], [['pull.twohead', 'resolve']], 0, 0],
    [undefined, 'main', ['origin/clean'], [['pull.twohead', 'bogus']], 1, 'UNKNOWN_MERGE_STRATEGY'],
    [['ort'], 'main', ['origin/clean'], [['pull.twohead', 'ours']], 0, 0],
    [undefined, 'main', ['origin/clean', 'origin/edits'], [['pull.octopus', 'ours']], 0, 0],
  ] as const)(
    'Given strategies %j from %s merging %j under %j',
    (strategies, start, revs, config, exitCode, outcome) => {
      describe('When both tools merge', () => {
        it('Then the chosen strategy, commit, state files and index are identical', async () => {
          // Arrange
          const { ours, theirs } = setUp(config);
          for (const dir of [ours, theirs])
            dated(['-C', dir, 'checkout', '-q', '-B', 'topic', start]);
          const flags = (strategies ?? []).flatMap((strategy) => ['-s', strategy]);
          const theirsRun = datedExit(theirs, ['merge', ...flags, ...revs]);
          const repo = await openRepository({ cwd: ours });
          const sut = repo.merge.run;
          const strategy = strategies === undefined ? {} : { strategy: strategies };

          // Act
          const result = await sut({
            rev: revs,
            ...strategy,
            author: IDENTITY,
            committer: IDENTITY,
          })
            .then(() => 0)
            .catch((e: unknown) => (e as { data: { code: string } }).data.code);
          await repo.dispose();

          // Assert
          expect(snapshot(ours)).toEqual(snapshot(theirs));
          expect(theirsRun.exitCode).toBe(exitCode);
          expect(result).toBe(outcome);
        });
      });
    },
  );

  describe('Given pull.twohead ours', () => {
    describe('When both tools pull a true merge', () => {
      it('Then both merge with the configured strategy', async () => {
        // Arrange
        const { ours, theirs } = setUp([['pull.twohead', 'ours']]);
        const sut = pull;
        datedExit(theirs, ['pull', '-q', '--no-rebase', 'origin', 'clean']);

        // Act
        await sut(contextOf(ours), {
          remote: 'origin',
          ref: 'clean',
          rebase: false,
          author: IDENTITY,
          committer: IDENTITY,
        });

        // Assert
        const tree = (dir: string) => git(dir, 'rev-parse', 'HEAD^{tree}');
        expect(tree(ours)).toBe(tree(theirs));
        const note = (dir: string) => git(dir, 'reflog', '-1', '--format=%gs').split(': ')[1];
        expect(note(ours)).toBe(note(theirs));
      });
    });
  });

  describe('Given a pull with strategy ours over a true merge', () => {
    describe('When both tools pull the head', () => {
      it("Then the merge commit and the reflog's strategy note are identical", async () => {
        // Arrange
        const { ours, theirs } = setUp();
        const sut = pull;
        datedExit(theirs, ['pull', '-q', '--no-rebase', '-s', 'ours', 'origin', 'clean']);

        // Act
        await sut(contextOf(ours), {
          remote: 'origin',
          ref: 'clean',
          rebase: false,
          strategy: 'ours',
          author: IDENTITY,
          committer: IDENTITY,
        });

        // Assert
        expect(git(ours, 'cat-file', 'commit', 'HEAD')).toBe(
          git(theirs, 'cat-file', 'commit', 'HEAD').replaceAll(
            peerPath.slice(0, -'.git'.length),
            SHORT_URL,
          ),
        );
        const note = (dir: string) => git(dir, 'reflog', '-1', '--format=%gs').split(': ')[1];
        expect(note(ours)).toBe(note(theirs));
      });
    });
  });

  describe.each([
    { options: '-X theirs', head: 'side' },
    { options: '--no-commit', head: 'clean' },
    { options: "--log=1 -m 'from branch'", head: 'clean', message: 'from caller' },
  ])('Given branch.main.mergeoptions $options', ({ options, head, message }) => {
    describe(`When both tools merge origin/${head}`, () => {
      it('Then the merge state and the commit are identical', async () => {
        // Arrange
        const { ours, theirs } = setUp([['branch.main.mergeoptions', options]]);
        const sut = mergeRun;
        datedExit(theirs, [
          'merge',
          ...(message === undefined ? [] : ['-m', message]),
          `origin/${head}`,
        ]);

        // Act
        await sut(createNodeContext({ workDir: ours }), {
          rev: `origin/${head}`,
          ...(message === undefined ? {} : { message }),
          author: IDENTITY,
          committer: IDENTITY,
        });

        // Assert
        expect(snapshot(ours)).toEqual(snapshot(theirs));
        expect(git(ours, 'cat-file', '-p', 'HEAD')).toBe(git(theirs, 'cat-file', '-p', 'HEAD'));
      });
    });
  });

  describe.each([
    { options: "'--no-ff", code: 'BAD_BRANCH_MERGE_OPTIONS', exitCode: 128 },
    { options: '--no-ff --bogus', code: 'UNKNOWN_OPTION', exitCode: 129 },
  ])('Given branch.main.mergeoptions $options', ({ options, code, exitCode }) => {
    describe('When both tools merge', () => {
      it('Then both refuse before writing any merge state', async () => {
        // Arrange
        const { ours, theirs } = setUp([['branch.main.mergeoptions', options]]);
        const sut = mergeRun;
        const theirsRun = datedExit(theirs, ['merge', 'origin/clean']);

        // Act
        const result = await sut(createNodeContext({ workDir: ours }), { rev: 'origin/clean' })
          .then(() => undefined)
          .catch((e: unknown) => (e as TsgitError).data.code);

        // Assert
        expect(theirsRun.exitCode).toBe(exitCode);
        expect(result).toBe(code);
        expect(snapshot(ours)).toEqual(snapshot(theirs));
      });
    });
  });

  describe.each([
    { options: '--no-commit', head: 'clean' },
    { options: '--allow-unrelated-histories', head: 'orphan' },
  ])('Given branch.main.mergeoptions $options', ({ options, head }) => {
    describe(`When both tools pull ${head}`, () => {
      it('Then the pull merges under them alike', async () => {
        // Arrange
        const { ours, theirs } = setUp([['branch.main.mergeoptions', options]]);
        const sut = pull;
        datedExit(theirs, ['pull', '-q', '--no-rebase', 'origin', head]);

        // Act
        await sut(contextOf(ours), {
          remote: 'origin',
          ref: head,
          rebase: false,
          author: IDENTITY,
          committer: IDENTITY,
        });

        // Assert
        const { state, index } = pulledSnapshot(theirs);
        expect(snapshot(ours)).toMatchObject({ state, index });
        expect(git(ours, 'cat-file', 'commit', 'HEAD')).toBe(
          git(theirs, 'cat-file', 'commit', 'HEAD').replaceAll(
            peerPath.slice(0, -'.git'.length),
            SHORT_URL,
          ),
        );
      });
    });
  });
});
