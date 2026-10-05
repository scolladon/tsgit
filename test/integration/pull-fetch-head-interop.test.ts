/**
 * Cross-tool interop — what a pull merges. git's `pull` fetches, then merges
 * the refs `FETCH_HEAD` marks for merging under `fmt_merge_msg`'s title — the
 * shortened url, and ` into <branch>` unless the branch is `main` or `master`.
 * A pull with nothing marked refuses after its fetch. tsgit pulls through
 * `git http-backend`, git over a local path; with the url each tool records
 * swapped for one, the merge commits agree byte for byte.
 *
 * @proves
 *   surface:        pull
 *   bucket:         cross-tool-interop
 *   unique:         pull merges the FETCH_HEAD merge heads under git's merge message
 */

import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { pull } from '../../src/application/commands/pull.js';
import { errorDataCode } from '../../src/domain/error-data-code.js';
import type { AuthorIdentity } from '../../src/domain/objects/index.js';
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
let peerRoot: string;
let peerPath: string;

const dated = (args: ReadonlyArray<string>): string => runGit(args, { env: DATED_ENV });

beforeAll(() => {
  if (!GIT_AVAILABLE) return;
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'tsgit-interop-pull-fetch-head-')));
  peerRoot = path.join(root, 'peer');
  peerPath = path.join(peerRoot, 'peer.git');
  const work = path.join(root, 'work');
  dated(['init', '-q', '-b', 'main', work]);
  dated(['-C', work, 'commit', '-q', '--allow-empty', '-m', 'a']);
  dated(['-C', work, 'checkout', '-q', '-b', 'side']);
  dated(['-C', work, 'commit', '-q', '--allow-empty', '-m', 'side']);
  dated(['-C', work, 'checkout', '-q', '-b', 'side2', 'main']);
  dated(['-C', work, 'commit', '-q', '--allow-empty', '-m', 'side2']);
  dated(['-C', work, 'checkout', '-q', '--orphan', 'root']);
  dated(['-C', work, 'commit', '-q', '--allow-empty', '-m', 'root']);
  dated(['-C', work, 'checkout', '-q', 'main']);
  dated(['clone', '-q', '--bare', work, peerPath]);
});

afterAll(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

/** One clone per tool, on `branch` with a local commit, configured alike but for the url. */
const setUp = (label: string, branch: string, config: ReadonlyArray<readonly [string, string]>) => {
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
    dated(['-C', dir, 'checkout', '-q', '-B', branch]);
    dated(['-C', dir, 'commit', '-q', '--allow-empty', '-m', 'local']);
    const seen = new Set<string>();
    for (const [key, value] of config) {
      dated(['-C', dir, 'config', ...(seen.has(key) ? ['--add'] : []), key, value]);
      seen.add(key);
    }
  }
  return dirs;
};

const head = (dir: string): string => git(dir, 'cat-file', 'commit', 'HEAD');

describe.skipIf(!GIT_AVAILABLE)('pull FETCH_HEAD interop', () => {
  describe.each([
    {
      label: 'upstream-main',
      branch: 'main',
      config: [
        ['branch.main.remote', 'origin'],
        ['branch.main.merge', 'refs/heads/side'],
      ],
    },
    {
      label: 'upstream-feat',
      branch: 'feat',
      config: [
        ['branch.feat.remote', 'origin'],
        ['branch.feat.merge', 'refs/heads/side'],
      ],
    },
    {
      label: 'mirrored',
      branch: 'main',
      config: [
        ['remote.origin.fetch', '+refs/heads/*:refs/remotes/mirror/*'],
        ['branch.main.remote', 'origin'],
        ['branch.main.merge', 'refs/heads/side'],
      ],
    },
    {
      label: 'octopus',
      branch: 'main',
      config: [
        ['branch.main.remote', 'origin'],
        ['branch.main.merge', 'refs/heads/side'],
        ['branch.main.merge', 'refs/heads/side2'],
      ],
    },
    {
      label: 'reduced-to-one',
      branch: 'main',
      config: [
        ['branch.main.remote', 'origin'],
        ['branch.main.merge', 'refs/heads/main'],
        ['branch.main.merge', 'refs/heads/side'],
      ],
    },
    {
      label: 'suppressed-feat',
      branch: 'feat',
      config: [
        ['branch.feat.remote', 'origin'],
        ['branch.feat.merge', 'refs/heads/side'],
        ['merge.suppressDest', 'fe*'],
      ],
    },
  ] as ReadonlyArray<{
    label: string;
    branch: string;
    config: ReadonlyArray<readonly [string, string]>;
  }>)('Given the $label upstream', ({ label, branch, config }) => {
    describe('When both tools pull', () => {
      it('Then the merge commits and their reflog notes agree', async () => {
        // Arrange
        const { ours, theirs } = setUp(label, branch, config);
        const ctx = {
          ...createNodeContext({ workDir: ours }),
          transport: backendTransport(peerRoot),
        };
        const sut = pull;
        dated(['-C', theirs, 'pull', '-q', '--no-rebase', '--no-edit']);
        const expected = head(theirs).replaceAll(peerPath.slice(0, -'.git'.length), SHORT_URL);

        // Act
        await sut(ctx, { author: IDENTITY, committer: IDENTITY });

        // Assert
        expect(head(ours)).toBe(expected);
        const note = (dir: string) =>
          git(dir, 'reflog', '-1', '--format=%gs', 'HEAD').split(': ').slice(1).join(': ');
        expect(note(ours)).toBe(note(theirs));
      });
    });
  });

  describe('Given a non-forcing fetch refspec and a tracking ref the fetched upstream does not descend from', () => {
    describe('When both tools pull', () => {
      it('Then both refuse before merging and leave the same refs', async () => {
        // Arrange
        const { ours, theirs } = setUp('rejected', 'main', [
          ['remote.origin.fetch', 'refs/heads/*:refs/remotes/origin/*'],
          ['branch.main.remote', 'origin'],
          ['branch.main.merge', 'refs/heads/side'],
        ]);
        for (const dir of [ours, theirs]) {
          dated(['-C', dir, 'update-ref', 'refs/remotes/origin/side', 'HEAD']);
        }
        const ctx = {
          ...createNodeContext({ workDir: ours }),
          transport: backendTransport(peerRoot),
        };
        const sut = pull;
        const theirsRun = tryRunGitWithExit(
          ['-C', theirs, 'pull', '-q', '--no-rebase', '--no-edit'],
          {
            env: DATED_ENV,
          },
        );
        let caught: unknown;

        // Act
        try {
          await sut(ctx, { author: IDENTITY, committer: IDENTITY });
        } catch (error) {
          caught = error;
        }

        // Assert
        expect(theirsRun.exitCode).toBe(1);
        expect((caught as { data?: { code?: string } }).data?.code).toBe('FETCH_REJECTED');
        const refs = (dir: string) => git(dir, 'for-each-ref', '--format=%(refname) %(objectname)');
        expect(refs(ours)).toBe(refs(theirs));
        expect(existsSync(path.join(ours, '.git', 'MERGE_HEAD'))).toBe(false);
        expect(existsSync(path.join(theirs, '.git', 'MERGE_HEAD'))).toBe(false);
      });
    });
  });

  describe('Given an upstream sharing no history with the branch', () => {
    const UNRELATED = [
      ['branch.main.remote', 'origin'],
      ['branch.main.merge', 'refs/heads/root'],
    ] as const;
    const ctxFor = (ours: string) => ({
      ...createNodeContext({ workDir: ours }),
      transport: backendTransport(peerRoot),
    });
    const origHead = (dir: string): string | undefined => {
      const file = path.join(dir, '.git', 'ORIG_HEAD');
      return existsSync(file) ? readFileSync(file, 'utf8') : undefined;
    };

    describe.each([
      { label: 'unrelated', flags: [], opts: {}, code: 'UNRELATED_HISTORIES', config: UNRELATED },
      {
        label: 'unrelated-ff-only',
        flags: ['--ff-only'],
        opts: { fastForward: 'only' },
        code: 'NON_FAST_FORWARD',
        config: UNRELATED,
      },
      {
        label: 'two-heads-ff-only',
        flags: ['--ff-only'],
        opts: { fastForward: 'only' },
        code: 'FAST_FORWARD_MULTIPLE_BRANCHES',
        config: [...UNRELATED, ['branch.main.merge', 'refs/heads/side']],
      },
    ] as const)(
      'When both tools pull the $label upstream',
      ({ label, flags, opts, code, config }) => {
        it('Then both refuse and leave ORIG_HEAD alike', async () => {
          // Arrange
          const { ours, theirs } = setUp(label, 'main', config);
          const theirsRun = tryRunGitWithExit(
            ['-C', theirs, 'pull', '-q', '--no-rebase', '--no-edit', ...flags],
            { env: DATED_ENV },
          );
          const sut = pull;

          // Act
          const result = await sut(ctxFor(ours), { ...opts, author: IDENTITY, committer: IDENTITY })
            .then(() => undefined)
            .catch(errorDataCode);

          // Assert
          expect(theirsRun.exitCode).toBe(128);
          expect(result).toBe(code);
          expect(origHead(ours)).toBe(origHead(theirs));
        });
      },
    );

    describe('When both tools pull it allowing unrelated histories', () => {
      it('Then the merge commits agree', async () => {
        // Arrange
        const { ours, theirs } = setUp('unrelated-allowed', 'main', UNRELATED);
        dated([
          '-C',
          theirs,
          'pull',
          '-q',
          '--no-rebase',
          '--no-edit',
          '--allow-unrelated-histories',
        ]);
        const expected = head(theirs).replaceAll(peerPath.slice(0, -'.git'.length), SHORT_URL);
        const sut = pull;

        // Act
        await sut(ctxFor(ours), {
          allowUnrelatedHistories: true,
          author: IDENTITY,
          committer: IDENTITY,
        });

        // Assert
        expect(head(ours)).toBe(expected);
      });
    });
  });

  describe('Given fast-forward configuration', () => {
    const UPSTREAM = [
      ['branch.main.remote', 'origin'],
      ['branch.main.merge', 'refs/heads/side'],
    ] as const;
    const ctxFor = (ours: string) => ({
      ...createNodeContext({ workDir: ours }),
      transport: backendTransport(peerRoot),
    });
    /** Both clones without their local commit, so the upstream fast-forwards. */
    const dropLocal = (dirs: ReadonlyArray<string>) => {
      for (const dir of dirs) dated(['-C', dir, 'reset', '-q', '--hard', 'HEAD~1']);
    };

    describe.each([
      { label: 'merge-ff-false', ff: true, config: [['merge.ff', 'false']] },
      { label: 'pull-ff-false', ff: true, config: [['pull.ff', 'false']] },
      {
        label: 'pull-ff-true',
        ff: true,
        config: [
          ['merge.ff', 'false'],
          ['pull.ff', 'true'],
        ],
      },
      { label: 'pull-ff-only-diverged', ff: false, config: [['pull.ff', 'only']] },
    ] as const)('When both tools pull under $label', ({ label, ff, config }) => {
      it('Then the commits HEAD lands on and the reflog notes agree', async () => {
        // Arrange
        const { ours, theirs } = setUp(label, 'main', [...UPSTREAM, ...config]);
        if (ff) dropLocal([ours, theirs]);
        dated(['-C', theirs, 'pull', '-q', '--no-rebase', '--no-edit']);
        const expected = head(theirs).replaceAll(peerPath.slice(0, -'.git'.length), SHORT_URL);
        const sut = pull;

        // Act
        await sut(ctxFor(ours), { author: IDENTITY, committer: IDENTITY });

        // Assert
        expect(head(ours)).toBe(expected);
        const note = (dir: string) =>
          git(dir, 'reflog', '-1', '--format=%gs', 'HEAD').split(': ').slice(1).join(': ');
        expect(note(ours)).toBe(note(theirs));
      });
    });

    describe.each([
      { label: 'merge-ff-only-diverged', config: [['merge.ff', 'only']], code: 'NON_FAST_FORWARD' },
      { label: 'pull-ff-bogus', config: [['pull.ff', 'bogus']], code: 'CONFIG_INVALID_ENUM_VALUE' },
    ] as const)('When both tools pull under $label', ({ label, config, code }) => {
      it('Then both refuse and leave HEAD and FETCH_HEAD alike', async () => {
        // Arrange
        const { ours, theirs } = setUp(label, 'main', [...UPSTREAM, ...config]);
        const theirsRun = tryRunGitWithExit(
          ['-C', theirs, 'pull', '-q', '--no-rebase', '--no-edit'],
          { env: DATED_ENV },
        );
        const sut = pull;

        // Act
        const result = await sut(ctxFor(ours), { author: IDENTITY, committer: IDENTITY })
          .then(() => undefined)
          .catch(errorDataCode);

        // Assert
        expect(theirsRun.exitCode).toBe(128);
        expect(result).toBe(code);
        expect(git(ours, 'rev-parse', 'HEAD')).toBe(git(theirs, 'rev-parse', 'HEAD'));
        const fetched = (dir: string) => existsSync(path.join(dir, '.git', 'FETCH_HEAD'));
        expect(fetched(ours)).toBe(fetched(theirs));
      });
    });
  });
});
