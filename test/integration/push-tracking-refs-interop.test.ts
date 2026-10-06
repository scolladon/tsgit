/**
 * Cross-tool interop — the remote-tracking refs a push leaves behind. git's
 * `transport_update_tracking_ref` maps every accepted or up-to-date ref
 * through `remote.<name>.fetch`, deletes the mapped ref on a delete, and a
 * forced lease reads its expectation through the same mapping. tsgit pushes
 * to a peer served by `git http-backend`; git pushes over a local path, each
 * from its own clone of one repository, and the tracking refs must agree.
 *
 * @proves
 *   surface:        push
 *   bucket:         cross-tool-interop
 *   unique:         push updates, deletes and leases through the fetch-refspec-mapped tracking ref
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { push } from '../../src/application/commands/push.js';
import { backendTransport } from './http-backend-transport.js';
import { GIT_AVAILABLE, git, runGit, tryRunGitWithExit } from './interop-helpers.js';

const PEER_URL = 'https://example.com/peer.git';
const MIRROR_REFSPEC = '+refs/heads/*:refs/remotes/mirror/*';

let root: string;

beforeAll(() => {
  if (!GIT_AVAILABLE) return;
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'tsgit-interop-push-tracking-')));
});

afterAll(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

interface Clones {
  readonly ours: string;
  readonly theirs: string;
  readonly peerRoot: string;
}

/** Two clones of one repository, each pushing to its own empty bare peer through a mirror refspec. */
const setUp = (slug: string): Clones => {
  const base = path.join(root, `${slug}-base`);
  runGit(['init', '-q', '-b', 'main', base]);
  runGit(['-C', base, 'commit', '-q', '--allow-empty', '-m', 'a']);
  for (const branch of ['b2', 'gone']) runGit(['-C', base, 'branch', branch]);
  const peerRoot = path.join(root, `${slug}-peer`);
  for (const bare of ['peer.git', 'twin.git']) {
    runGit(['init', '-q', '--bare', '-b', 'main', path.join(peerRoot, bare)]);
  }
  runGit(['-C', path.join(peerRoot, 'peer.git'), 'config', 'http.receivepack', 'true']);
  const ours = path.join(root, `${slug}-ours`);
  const theirs = path.join(root, `${slug}-theirs`);
  for (const [dir, url] of [
    [ours, PEER_URL],
    [theirs, path.join(peerRoot, 'twin.git')],
  ] as const) {
    runGit(['clone', '-q', base, dir]);
    for (const branch of ['b2', 'gone']) runGit(['-C', dir, 'branch', branch, `origin/${branch}`]);
    runGit(['-C', dir, 'config', 'remote.origin.url', url]);
    runGit(['-C', dir, 'config', 'remote.origin.fetch', MIRROR_REFSPEC]);
  }
  return { ours, theirs, peerRoot };
};

const trackingRefs = (dir: string): string =>
  git(dir, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/remotes/mirror');

describe.skipIf(!GIT_AVAILABLE)('push tracking refs interop', () => {
  describe('Given clones whose origin maps branches under refs/remotes/mirror/', () => {
    describe('When both tools push, delete, then re-push an up-to-date branch', () => {
      it('Then the mirror tracking refs agree', async () => {
        // Arrange
        const { ours, theirs, peerRoot } = setUp('mapped');
        const ctx = {
          ...createNodeContext({ workDir: ours }),
          transport: backendTransport(peerRoot),
        };
        const steps = [['main', 'b2', 'gone'], [':refs/heads/gone'], ['b2']] as const;
        const sut = push;

        // Act
        for (const refspecs of steps) {
          git(ours, 'update-ref', '-d', 'refs/remotes/mirror/b2');
          git(theirs, 'update-ref', '-d', 'refs/remotes/mirror/b2');
          await sut(ctx, { remote: 'origin', refspecs });
          git(theirs, 'push', '-q', 'origin', ...refspecs);
        }

        // Assert
        expect(trackingRefs(ours)).toBe(trackingRefs(theirs));
        expect(trackingRefs(ours)).toContain('refs/remotes/mirror/b2');
      });
    });

    describe('When both tools push main with an automatic lease the mirror ref no longer matches', () => {
      it('Then both reject it as stale', async () => {
        // Arrange
        const { ours, theirs, peerRoot } = setUp('lease');
        const ctx = {
          ...createNodeContext({ workDir: ours }),
          transport: backendTransport(peerRoot),
        };
        await push(ctx, { remote: 'origin', refspecs: ['main'] });
        git(theirs, 'push', '-q', 'origin', 'main');
        for (const dir of [ours, theirs]) {
          git(dir, 'commit', '-q', '--allow-empty', '-m', 'b');
          git(dir, 'update-ref', 'refs/remotes/mirror/main', 'HEAD');
        }
        const sut = push;

        // Act
        const result = await sut(ctx, {
          remote: 'origin',
          refspecs: ['main'],
          forceWithLease: 'auto',
        });

        // Assert
        const theirsOut = tryRunGitWithExit([
          '-C',
          theirs,
          'push',
          '--porcelain',
          '--force-with-lease',
          'origin',
          'main',
        ]);
        expect(result.pushedRefs.map((ref) => ref.rejection)).toEqual(['stale-info']);
        expect(theirsOut.stdout).toContain('[rejected] (stale info)');
      });
    });

    describe('When the peer advanced past a mirror ref main never integrated, then main was amended', () => {
      it('Then an automatic lease with force-if-includes rejects it in both tools', async () => {
        // Arrange
        const { ours, theirs, peerRoot } = setUp('includes');
        const ctx = {
          ...createNodeContext({ workDir: ours }),
          transport: backendTransport(peerRoot),
        };
        await push(ctx, { remote: 'origin', refspecs: ['main'] });
        git(theirs, 'push', '-q', 'origin', 'main');
        const advanced = new Map<string, string>();
        for (const [dir, bare] of [
          [ours, 'peer.git'],
          [theirs, 'twin.git'],
        ] as const) {
          const other = git(dir, 'commit-tree', '-p', 'HEAD', '-m', 'other', 'HEAD^{tree}').trim();
          git(dir, 'push', '-q', path.join(peerRoot, bare), `${other}:refs/heads/main`);
          git(dir, 'update-ref', 'refs/remotes/mirror/main', other);
          git(dir, 'commit', '-q', '--amend', '--allow-empty', '-m', 'mine');
          advanced.set(dir, other);
        }
        const sut = push;

        // Act
        const result = await sut(ctx, {
          remote: 'origin',
          refspecs: ['main'],
          forceWithLease: 'auto',
          forceIfIncludes: true,
        });
        const theirsOut = tryRunGitWithExit([
          '-C',
          theirs,
          'push',
          '--porcelain',
          '--force-with-lease',
          '--force-if-includes',
          'origin',
          'main',
        ]);

        // Assert
        expect(result.pushedRefs.map((ref) => ref.rejection)).toEqual(['remote-ref-updated']);
        expect(theirsOut.stdout).toContain('[rejected] (remote ref updated since checkout)');
        const peerMain = (bare: string) =>
          git(path.join(peerRoot, bare), 'rev-parse', 'refs/heads/main').trim();
        expect(peerMain('peer.git')).toBe(advanced.get(ours));
        expect(peerMain('twin.git')).toBe(advanced.get(theirs));
      });
    });
  });
});
