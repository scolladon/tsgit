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
import { fetch } from '../../src/application/commands/fetch.js';
import { backendTransport } from './http-backend-transport.js';
import { GIT_AVAILABLE, git, runGit } from './interop-helpers.js';

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
});
