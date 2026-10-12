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
import { errorDataCode } from '../../src/domain/error-data-code.js';
import { backendTransport } from './http-backend-transport.js';
import { GIT_AVAILABLE, git, runGit, runGitEnv, tryRunGitWithExit } from './interop-helpers.js';

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

  describe('Given rebase.autostash and a dirty tree under a diverging local commit', () => {
    describe('When both tools pull rebasing', () => {
      it('Then both stash, rebase and re-apply the local change alike', async () => {
        // Arrange
        const { ours, theirs, work, peerRoot, peerPath } = setUp('autostash');
        for (const dir of [ours, theirs]) {
          commitFile(dir, 'l.txt', 'l');
          dated(['-C', dir, 'config', 'rebase.autostash', 'true']);
          writeFileSync(path.join(dir, 'a.txt'), 'dirty\n');
        }
        commitFile(work, 'v.txt', 'v');
        publish(work, peerPath);
        const sut = pullBoth;

        // Act
        await sut(ours, theirs, peerRoot);

        // Assert
        const dirtyState = (dir: string) => ({
          ...state(dir),
          status: git(dir, 'status', '--porcelain'),
          stash: git(dir, 'stash', 'list'),
        });
        expect(dirtyState(ours)).toEqual(dirtyState(theirs));
        expect(readFileSync(path.join(ours, 'a.txt'), 'utf8')).toBe('dirty\n');
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

  /** Configure both clones alike, then let each tool pull with no reconcile option. */
  const pullConfigured = async (
    dirs: { readonly ours: string; readonly theirs: string; readonly peerRoot: string },
    config: ReadonlyArray<readonly [string, string]>,
  ) => {
    for (const dir of [dirs.ours, dirs.theirs]) {
      for (const [key, value] of config) dated(['-C', dir, 'config', key, value]);
    }
    const exitCode = tryRunGitWithExit(['-C', dirs.theirs, 'pull'], { env: DATED_ENV }).exitCode;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(EPOCH * 1000);
    const ctx = {
      ...createNodeContext({ workDir: dirs.ours }),
      transport: backendTransport(dirs.peerRoot),
    };
    const code = await pull(ctx, {}).then(
      () => undefined,
      (error: unknown) => errorDataCode(error),
    );
    return { exitCode, code };
  };

  describe.each([
    { label: 'nothing configured', config: [], exitCode: 128, code: 'PULL_DIVERGENT_BRANCHES' },
    {
      label: 'merge.ff=false alone',
      config: [['merge.ff', 'false']],
      exitCode: 128,
      code: 'PULL_DIVERGENT_BRANCHES',
    },
    {
      label: 'pull.ff=only',
      config: [['pull.ff', 'only']],
      exitCode: 128,
      code: 'NON_FAST_FORWARD',
    },
    {
      label: 'pull.rebase=bogus',
      config: [['pull.rebase', 'bogus']],
      exitCode: 128,
      code: 'CONFIG_INVALID_ENUM_VALUE',
    },
    { label: 'pull.rebase=true', config: [['pull.rebase', 'true']], exitCode: 0, code: undefined },
    {
      label: 'pull.rebase=merges',
      config: [['pull.rebase', 'merges']],
      exitCode: 0,
      code: undefined,
    },
    {
      label: 'pull.rebase=false',
      config: [['pull.rebase', 'false']],
      exitCode: 0,
      code: undefined,
    },
    { label: 'pull.ff=true', config: [['pull.ff', 'true']], exitCode: 0, code: undefined },
    {
      label: 'branch.main.rebase=true over pull.rebase=false',
      config: [
        ['pull.rebase', 'false'],
        ['branch.main.rebase', 'true'],
      ],
      exitCode: 0,
      code: undefined,
    },
  ] as ReadonlyArray<{
    label: string;
    config: ReadonlyArray<readonly [string, string]>;
    exitCode: number;
    code: string | undefined;
  }>)('Given a divergence and $label', ({ label, config, exitCode, code }) => {
    describe('When both tools pull with no reconcile option', () => {
      it('Then both integrate or refuse alike and leave the same commits and reflogs', async () => {
        // Arrange
        const dirs = setUp(`configured-${label.replace(/[^a-z]+/g, '-')}`);
        commitFile(dirs.ours, 'l.txt', 'l');
        commitFile(dirs.theirs, 'l.txt', 'l');
        commitFile(dirs.work, 'v.txt', 'v');
        publish(dirs.work, dirs.peerPath);
        const sut = pullConfigured;

        // Act
        const result = await sut(dirs, config);

        // Assert
        expect(result).toEqual({ exitCode, code });
        const peerUrl = dirs.peerPath.slice(0, -'.git'.length);
        const commitOf = (dir: string) =>
          git(dir, 'cat-file', 'commit', 'HEAD').replaceAll(
            peerUrl,
            PEER_URL.slice(0, -'.git'.length),
          );
        expect(commitOf(dirs.ours)).toBe(commitOf(dirs.theirs));
        const log = (dir: string) => git(dir, 'reflog', '-4', '--format=%gs', 'HEAD');
        expect(log(dirs.ours)).toBe(log(dirs.theirs));
      });
    });
  });

  describe.each([
    { label: 'pull.autostash', key: 'pull.autostash' },
    { label: 'merge.autostash', key: 'merge.autostash' },
  ])('Given a dirty tree under a divergence and $label', ({ label, key }) => {
    describe('When both tools pull merging', () => {
      it('Then both stash around the merge and re-apply the change alike', async () => {
        // Arrange
        const dirs = setUp(`merge-autostash-${label.replace(/[^a-z]+/g, '-')}`);
        for (const dir of [dirs.ours, dirs.theirs]) {
          commitFile(dir, 'l.txt', 'l');
          writeFileSync(path.join(dir, 'a.txt'), 'dirty\n');
        }
        commitFile(dirs.work, 'v.txt', 'v');
        publish(dirs.work, dirs.peerPath);
        const sut = pullConfigured;

        // Act
        const result = await sut(dirs, [
          ['pull.rebase', 'false'],
          [key, 'true'],
        ]);

        // Assert
        expect(result).toEqual({ exitCode: 0, code: undefined });
        const tree = (dir: string) => ({
          status: git(dir, 'status', '--porcelain'),
          stash: git(dir, 'stash', 'list'),
          head: git(dir, 'rev-parse', 'HEAD^{tree}'),
          a: readFileSync(path.join(dir, 'a.txt'), 'utf8'),
        });
        expect(tree(dirs.ours)).toEqual(tree(dirs.theirs));
        expect(tree(dirs.ours).a).toBe('dirty\n');
      });
    });
  });

  describe.each([
    { label: 'pull.rebase=merges', value: 'merges' },
    { label: 'pull.rebase=true', value: 'true' },
  ])('Given a local merge diverging from the advanced upstream and $label', ({ value }) => {
    describe('When both tools pull', () => {
      it('Then the merge is recreated or flattened alike, with the same commits and reflogs', async () => {
        // Arrange
        const dirs = setUp(`local-merge-${value}`);
        for (const dir of [dirs.ours, dirs.theirs]) {
          dated(['-C', dir, 'checkout', '-q', '-b', 'side']);
          commitFile(dir, 's.txt', 's');
          dated(['-C', dir, 'checkout', '-q', 'main']);
          commitFile(dir, 'l.txt', 'l');
          dated(['-C', dir, 'merge', '-q', '--no-ff', 'side', '-m', "Merge branch 'side'"]);
        }
        commitFile(dirs.work, 'v.txt', 'v');
        publish(dirs.work, dirs.peerPath);
        const sut = pullConfigured;

        // Act
        const result = await sut(dirs, [['pull.rebase', value]]);

        // Assert
        expect(result).toEqual({ exitCode: 0, code: undefined });
        const history = (dir: string) => git(dir, 'log', '--format=%H %P %s', 'HEAD');
        expect(history(dirs.ours)).toBe(history(dirs.theirs));
        const log = (dir: string) => git(dir, 'reflog', '-8', '--format=%H %gs', 'HEAD');
        expect(log(dirs.ours)).toBe(log(dirs.theirs));
      });
    });
  });
});
