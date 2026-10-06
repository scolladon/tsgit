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
import { writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { pull } from '../../src/application/commands/pull.js';
import type { AuthorIdentity } from '../../src/domain/objects/index.js';
import { openRepository } from '../../src/index.node.js';
import type { Context } from '../../src/ports/context.js';
import { backendTransport } from './http-backend-transport.js';
import { GIT_AVAILABLE, git, runGit, runGitEnv, tryRunGitWithExit } from './interop-helpers.js';

const PEER_URL = 'https://example.com/peer.git';
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
  dated(['-C', work, 'checkout', '-q', '-b', 'clean']);
  commitFile(work, 's2', 's2\n', 'clean one');
  dated(['-C', work, 'checkout', '-q', '-b', 'side', 'main']);
  commitFile(work, 's1', 's1\n', 'side one');
  commitFile(work, 'f', 'side\n', 'conflicting');
  dated(['-C', work, 'checkout', '-q', 'main']);
  commitFile(work, 'f', 'main\n', 'main');
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
});

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
        expect(snapshot(ours)).toEqual(snapshot(theirs));
      });
    });
  });
});
