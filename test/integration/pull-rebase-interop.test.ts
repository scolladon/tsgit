/**
 * Cross-tool interop — a rebasing pull. git's `pull` with `pull.rebase` set
 * fast-forwards a head it can, else runs `rebase --onto <fetched head>
 * <upstream>`, where the upstream is the fork point the remote-tracking ref's
 * reflog names unless it is already the merge base. tsgit pulls through
 * `git http-backend`, git over a local path; the rebased commits, the refs
 * and the reflogs agree byte for byte.
 *
 * @proves
 *   surface:        pull
 *   bucket:         cross-tool-interop
 *   unique:         pull rebases onto the fetched head from git's fork point under git's reflog
 */

import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { pull } from '../../src/application/commands/pull.js';
import { backendTransport } from './http-backend-transport.js';
import { GIT_AVAILABLE, git, runGit, runGitEnv } from './interop-helpers.js';

const PEER_URL = 'https://example.com/peer.git';
const EPOCH = 1_700_000_000;
const DATED_ENV = {
  ...runGitEnv(),
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
  GIT_AUTHOR_DATE: `${EPOCH} +0000`,
  GIT_COMMITTER_DATE: `${EPOCH} +0000`,
};

let root: string;

const dated = (args: ReadonlyArray<string>): string => runGit(args, { env: DATED_ENV });

const commitFile = (dir: string, file: string, message: string): void => {
  writeFileSync(path.join(dir, file), `${message}\n`);
  dated(['-C', dir, 'add', file]);
  dated(['-C', dir, 'commit', '-q', '-m', message]);
};

beforeAll(() => {
  if (!GIT_AVAILABLE) return;
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'tsgit-interop-pull-rebase-')));
});

afterAll(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * A peer whose `main` is A and `next` is A→U; one clone per tool, `main`
 * tracking `next` from U with a local commit L on top.
 */
const setUp = (label: string) => {
  const work = path.join(root, `${label}-work`);
  const peerRoot = path.join(root, `${label}-peer`);
  const peerPath = path.join(peerRoot, 'peer.git');
  dated(['init', '-q', '-b', 'main', work]);
  commitFile(work, 'a.txt', 'a');
  dated(['-C', work, 'checkout', '-q', '-b', 'next']);
  commitFile(work, 'u.txt', 'u');
  dated(['clone', '-q', '--bare', work, peerPath]);
  const dirs = {
    ours: path.join(root, `${label}-ours`),
    theirs: path.join(root, `${label}-theirs`),
  };
  for (const [dir, url] of [
    [dirs.ours, PEER_URL],
    [dirs.theirs, peerPath],
  ] as const) {
    dated(['clone', '-q', '-b', 'main', peerPath, dir]);
    dated(['-C', dir, 'remote', 'set-url', 'origin', url]);
    dated(['-C', dir, 'checkout', '-q', '-B', 'main', 'origin/next']);
    dated(['-C', dir, 'config', 'branch.main.remote', 'origin']);
    dated(['-C', dir, 'config', 'branch.main.merge', 'refs/heads/next']);
    dated(['-C', dir, 'config', 'user.name', 't']);
    dated(['-C', dir, 'config', 'user.email', 't@t']);
  }
  return { ...dirs, work, peerRoot, peerPath };
};

/** Move the peer's `next` to `work`'s `next`, forced. */
const publish = (work: string, peerPath: string): void => {
  dated(['-C', work, 'push', '-q', '-f', peerPath, 'next']);
};

const state = (dir: string) => ({
  head: git(dir, 'cat-file', 'commit', 'HEAD'),
  parent: git(dir, 'rev-parse', 'HEAD~1'),
  headLog: git(dir, 'reflog', '-4', '--format=%H %gs', 'HEAD'),
  mainLog: git(dir, 'reflog', '-1', '--format=%H %gs', 'refs/heads/main'),
  origHead: readFileSync(path.join(dir, '.git', 'ORIG_HEAD'), 'utf8'),
});

const pullBoth = async (ours: string, theirs: string, peerRoot: string) => {
  dated(['-C', theirs, '-c', 'pull.rebase=true', 'pull']);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(EPOCH * 1000);
  const ctx = { ...createNodeContext({ workDir: ours }), transport: backendTransport(peerRoot) };
  await pull(ctx, { rebase: true });
};

describe.skipIf(!GIT_AVAILABLE)('pull rebase interop', () => {
  describe('Given a local commit diverging from the advanced upstream', () => {
    describe('When both tools pull rebasing', () => {
      it('Then the rebased commit, the refs, ORIG_HEAD and the reflogs agree', async () => {
        // Arrange
        const { ours, theirs, work, peerRoot, peerPath } = setUp('diverged');
        commitFile(ours, 'l.txt', 'l');
        commitFile(theirs, 'l.txt', 'l');
        commitFile(work, 'v.txt', 'v');
        publish(work, peerPath);
        const sut = pullBoth;

        // Act
        await sut(ours, theirs, peerRoot);

        // Assert
        expect(state(ours)).toEqual(state(theirs));
      });
    });
  });

  describe('Given an upstream rewritten under the local commit', () => {
    describe('When both tools pull rebasing', () => {
      it('Then both replay only the commits after the fork point', async () => {
        // Arrange
        const { ours, theirs, work, peerRoot, peerPath } = setUp('rewritten');
        commitFile(ours, 'l.txt', 'l');
        commitFile(theirs, 'l.txt', 'l');
        dated(['-C', work, 'reset', '-q', '--hard', 'main']);
        commitFile(work, 'r.txt', 'r');
        publish(work, peerPath);
        const sut = pullBoth;

        // Act
        await sut(ours, theirs, peerRoot);

        // Assert
        expect(state(ours)).toEqual(state(theirs));
        expect(git(ours, 'rev-parse', 'HEAD~1')).toBe(git(work, 'rev-parse', 'next'));
      });
    });
  });

  describe('Given an upstream the local branch can fast-forward to', () => {
    describe('When both tools pull rebasing', () => {
      it('Then both fast-forward through the merge with the same reflog', async () => {
        // Arrange
        const { ours, theirs, work, peerRoot, peerPath } = setUp('fast-forward');
        commitFile(work, 'v.txt', 'v');
        publish(work, peerPath);
        const sut = pullBoth;

        // Act
        await sut(ours, theirs, peerRoot);

        // Assert
        expect(state(ours)).toEqual(state(theirs));
      });
    });
  });
});
