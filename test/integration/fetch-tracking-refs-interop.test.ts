/**
 * Cross-tool interop — the local refs a fetch writes and prunes. git's
 * `get_ref_map` maps the advertised refs through `remote.<name>.fetch` — a
 * negative refspec dropping what it names — and `get_stale_heads` prunes only
 * the local refs those refspecs map from a ref the remote no longer has. tsgit
 * fetches through `git http-backend`, git over a local path, each into its own
 * repository holding the same refs, and the resulting refs must agree.
 *
 * @proves
 *   surface:        fetch
 *   bucket:         cross-tool-interop
 *   unique:         fetch writes and prunes the refs its configured refspecs map
 */
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { type FetchUpdate, fetch } from '../../src/application/commands/fetch.js';
import { backendTransport } from './http-backend-transport.js';
import { GIT_AVAILABLE, git, runGit, tryRunGitWithExit } from './interop-helpers.js';

const PEER_URL = 'https://example.com/peer.git';
const REFSPECS = ['+refs/heads/b*:refs/remotes/x/b*', '^refs/heads/b3'] as const;

let root: string;

beforeAll(() => {
  if (!GIT_AVAILABLE) return;
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'tsgit-interop-fetch-tracking-')));
});

afterAll(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

/** A peer with main, b2, b3 and a tag, and one empty repository per tool fetching from it. */
const setUp = (): { readonly ours: string; readonly theirs: string; readonly peerRoot: string } => {
  const peerRoot = path.join(root, 'peer');
  const work = path.join(root, 'work');
  runGit(['init', '-q', '-b', 'main', work]);
  runGit(['-C', work, 'commit', '-q', '--allow-empty', '-m', 'a']);
  for (const branch of ['b2', 'b3']) runGit(['-C', work, 'branch', branch]);
  runGit(['-C', work, 'tag', 'v1']);
  runGit(['clone', '-q', '--bare', work, path.join(peerRoot, 'peer.git')]);
  const tip = git(work, 'rev-parse', 'HEAD').trim();
  const ours = path.join(root, 'ours');
  const theirs = path.join(root, 'theirs');
  for (const [dir, url] of [
    [ours, PEER_URL],
    [theirs, path.join(peerRoot, 'peer.git')],
  ] as const) {
    runGit(['init', '-q', '-b', 'main', dir]);
    runGit(['-C', dir, 'config', 'remote.origin.url', url]);
    for (const spec of REFSPECS)
      runGit(['-C', dir, 'config', '--add', 'remote.origin.fetch', spec]);
    runGit(['-C', dir, 'fetch', '-q', path.join(peerRoot, 'peer.git'), 'main']);
    for (const ref of ['refs/remotes/x/b-gone', 'refs/remotes/other/zz']) {
      runGit(['-C', dir, 'update-ref', ref, tip]);
    }
  }
  return { ours, theirs, peerRoot };
};

const SHORT_PREFIXES = /^refs\/(heads|tags|remotes)\//;
const REJECTION_TEXT = {
  'non-fast-forward': 'non-fast-forward',
  'would-clobber-existing-tag': 'would clobber existing tag',
} as const;

/** git's `! [rejected] <src> -> <dst> (<reason>)` line, column padding collapsed. */
const rejectedLine = (update: FetchUpdate): string =>
  update.status === 'rejected'
    ? `! [rejected] ${update.source.replace(SHORT_PREFIXES, '')} -> ${update.name.replace(SHORT_PREFIXES, '')} (${REJECTION_TEXT[update.rejection]})`
    : '';

const collapsed = (text: string): ReadonlyArray<string> =>
  text
    .split('\n')
    .map((line) => line.trim().replace(/\s+/g, ' '))
    .filter((line) => line.startsWith('! '));

const allRefs = (dir: string): string =>
  git(dir, 'for-each-ref', '--format=%(refname) %(objectname)');

describe.skipIf(!GIT_AVAILABLE)('fetch tracking refs interop', () => {
  describe('Given repositories whose origin maps b* branches under refs/remotes/x/ but not b3', () => {
    describe('When both tools fetch with prune', () => {
      it('Then the refs written and pruned agree', async () => {
        // Arrange
        const { ours, theirs, peerRoot } = setUp();
        const ctx = {
          ...createNodeContext({ workDir: ours }),
          transport: backendTransport(peerRoot),
        };
        const sut = fetch;

        // Act
        await sut(ctx, { remote: 'origin', prune: true });
        git(theirs, 'fetch', '-q', '--prune', 'origin');

        // Assert
        expect(allRefs(ours)).toBe(allRefs(theirs));
        expect(allRefs(ours)).toContain('refs/remotes/x/b2');
      });
    });
  });

  describe('Given a remote that is an empty repository', () => {
    describe('When both tools fetch from it', () => {
      it('Then both succeed with no ref and an empty FETCH_HEAD', async () => {
        // Arrange
        const emptyRoot = path.join(root, 'empty-peer');
        runGit(['init', '-q', '--bare', path.join(emptyRoot, 'peer.git')]);
        const dirs = {
          ours: path.join(root, 'empty-ours'),
          theirs: path.join(root, 'empty-theirs'),
        };
        for (const [dir, url] of [
          [dirs.ours, PEER_URL],
          [dirs.theirs, path.join(emptyRoot, 'peer.git')],
        ] as const) {
          runGit(['init', '-q', '-b', 'main', dir]);
          runGit(['-C', dir, 'remote', 'add', 'origin', url]);
        }
        const ctx = {
          ...createNodeContext({ workDir: dirs.ours }),
          transport: backendTransport(emptyRoot),
        };
        const sut = fetch;

        // Act
        const result = await sut(ctx, { remote: 'origin' });
        git(dirs.theirs, 'fetch', '-q', 'origin');

        // Assert
        expect(result.updatedRefs).toEqual([]);
        const fetchHead = (dir: string) =>
          readFileSync(path.join(dir, '.git', 'FETCH_HEAD'), 'utf8');
        expect(fetchHead(dirs.ours)).toBe(fetchHead(dirs.theirs));
        expect(allRefs(dirs.ours)).toBe(allRefs(dirs.theirs));
      });
    });
  });

  describe('Given tracking refs and a tag the remote then advances, rewrites and adds', () => {
    describe('When both tools fetch again', () => {
      it("Then each ref's reflog records git's update action", async () => {
        // Arrange
        const peerRoot = path.join(root, 'reflog-peer');
        const work = path.join(root, 'reflog-work');
        const bare = path.join(peerRoot, 'peer.git');
        runGit(['init', '-q', '-b', 'main', work]);
        runGit(['-C', work, 'commit', '-q', '--allow-empty', '-m', 'a']);
        runGit(['-C', work, 'branch', 'side']);
        runGit(['clone', '-q', '--bare', work, bare]);
        const dirs = {
          ours: path.join(root, 'reflog-ours'),
          theirs: path.join(root, 'reflog-theirs'),
        };
        for (const [dir, url] of [
          [dirs.ours, PEER_URL],
          [dirs.theirs, bare],
        ] as const) {
          runGit(['init', '-q', '-b', 'main', dir]);
          runGit(['-C', dir, 'config', 'core.logAllRefUpdates', 'always']);
          runGit(['-C', dir, 'remote', 'add', 'origin', bare]);
          runGit(['-C', dir, 'config', '--add', 'remote.origin.fetch', '+refs/tags/*:refs/tags/*']);
          runGit(['-C', dir, 'fetch', 'origin']);
          runGit(['-C', dir, 'remote', 'set-url', 'origin', url]);
        }
        runGit(['-C', work, 'commit', '-q', '--allow-empty', '-m', 'b']);
        runGit(['-C', work, 'tag', 'v1']);
        runGit(['-C', work, 'checkout', '-q', '--orphan', 'other']);
        runGit(['-C', work, 'commit', '-q', '--allow-empty', '-m', 'orphan']);
        runGit(['-C', work, 'branch', '-f', 'side', 'other']);
        runGit(['-C', work, 'push', '-q', '-f', bare, 'main', 'side', 'v1']);
        const ctx = {
          ...createNodeContext({ workDir: dirs.ours }),
          transport: backendTransport(peerRoot),
        };
        const sut = fetch;

        // Act
        await sut(ctx, { remote: 'origin' });
        runGit(['-C', dirs.theirs, 'fetch', 'origin']);

        // Assert
        const actions = (dir: string) =>
          ['refs/remotes/origin/main', 'refs/remotes/origin/side', 'refs/tags/v1'].map((ref) =>
            git(dir, 'reflog', 'show', '--format=%gs', ref),
          );
        expect(actions(dirs.ours)).toEqual(actions(dirs.theirs));
      });
    });
  });

  describe('Given refspecs without the force flag and a remote that rewrites main, advances side and moves a tag', () => {
    describe('When both tools fetch again', () => {
      it("Then git's rejections, refs, FETCH_HEAD and reflogs agree", async () => {
        // Arrange
        const peerRoot = path.join(root, 'reject-peer');
        const work = path.join(root, 'reject-work');
        const bare = path.join(peerRoot, 'peer.git');
        runGit(['init', '-q', '-b', 'main', work]);
        runGit(['-C', work, 'commit', '-q', '--allow-empty', '-m', 'a']);
        runGit(['-C', work, 'branch', 'side']);
        runGit(['-C', work, 'tag', 'v1']);
        runGit(['clone', '-q', '--bare', work, bare]);
        const dirs = {
          ours: path.join(root, 'reject-ours'),
          theirs: path.join(root, 'reject-theirs'),
        };
        for (const [dir, url] of [
          [dirs.ours, PEER_URL],
          [dirs.theirs, bare],
        ] as const) {
          runGit(['init', '-q', '-b', 'main', dir]);
          runGit(['-C', dir, 'config', 'core.logAllRefUpdates', 'always']);
          runGit(['-C', dir, 'remote', 'add', 'origin', bare]);
          runGit([
            '-C',
            dir,
            'config',
            'remote.origin.fetch',
            'refs/heads/*:refs/remotes/origin/*',
          ]);
          runGit(['-C', dir, 'config', '--add', 'remote.origin.fetch', 'refs/tags/*:refs/tags/*']);
          runGit(['-C', dir, 'fetch', 'origin']);
          runGit(['-C', dir, 'remote', 'set-url', 'origin', url]);
        }
        runGit(['-C', work, 'commit', '-q', '--amend', '--allow-empty', '-m', 'a2']);
        runGit(['-C', work, 'checkout', '-q', 'side']);
        runGit(['-C', work, 'commit', '-q', '--allow-empty', '-m', 's']);
        runGit(['-C', work, 'tag', '-f', 'v1']);
        runGit(['-C', work, 'push', '-q', '-f', bare, 'main', 'side', 'v1']);
        const ctx = {
          ...createNodeContext({ workDir: dirs.ours }),
          transport: backendTransport(peerRoot),
        };
        const sut = fetch;

        // Act
        const result = await sut(ctx, { remote: 'origin' });
        const theirs = tryRunGitWithExit(['-C', dirs.theirs, 'fetch', 'origin']);

        // Assert
        expect(theirs.exitCode).toBe(1);
        expect(result.updatedRefs.map(rejectedLine).filter((line) => line !== '')).toEqual(
          collapsed(theirs.stderr),
        );
        expect(allRefs(dirs.ours)).toBe(allRefs(dirs.theirs));
        const fetchHead = (dir: string) =>
          readFileSync(path.join(dir, '.git', 'FETCH_HEAD'), 'utf8').replaceAll(
            bare.replace(/\.git$/, ''),
            PEER_URL.replace(/\.git$/, ''),
          );
        expect(fetchHead(dirs.ours)).toBe(fetchHead(dirs.theirs));
        const actions = (dir: string) =>
          ['refs/remotes/origin/main', 'refs/remotes/origin/side', 'refs/tags/v1'].map((ref) =>
            git(dir, 'reflog', 'show', '--format=%gs', ref),
          );
        expect(actions(dirs.ours)).toEqual(actions(dirs.theirs));
      });
    });
  });
});
