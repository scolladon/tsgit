/**
 * Cross-tool interop — how push matches a delete's destination. git's
 * `match_explicit` sends a full `refs/` destination the remote does not
 * advertise, resolves a short one against the remote's refs, and when a short
 * one names no remote ref reports `unable to delete` and sends nothing at all.
 * tsgit pushes to a peer served by `git http-backend`, git to a twin over a
 * local path, both seeded alike, and the peers must agree afterwards.
 *
 * @proves
 *   surface:        push
 *   bucket:         cross-tool-interop
 *   unique:         push matches a delete's destination against the remote refs as git does
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
const GIT_ERROR_PREFIX = 'error: ';

let root: string;

beforeAll(() => {
  if (!GIT_AVAILABLE) return;
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'tsgit-interop-push-delete-')));
});

afterAll(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

/** A repository with `main`, `b2` and tag `t1`, and two peers already holding `main` and `t1`. */
const setUp = (slug: string): { readonly dir: string; readonly peerRoot: string } => {
  const dir = path.join(root, slug);
  runGit(['init', '-q', '-b', 'main', dir]);
  runGit(['-C', dir, 'commit', '-q', '--allow-empty', '-m', 'a']);
  runGit(['-C', dir, 'branch', 'b2']);
  runGit(['-C', dir, 'tag', 't1']);
  runGit(['-C', dir, 'remote', 'add', 'origin', PEER_URL]);
  const peerRoot = path.join(root, `${slug}-peer`);
  for (const bare of ['peer.git', 'twin.git']) {
    const peer = path.join(peerRoot, bare);
    runGit(['init', '-q', '--bare', '-b', 'main', peer]);
    runGit(['-C', dir, 'push', '-q', peer, 'main', 't1']);
  }
  runGit(['-C', path.join(peerRoot, 'peer.git'), 'config', 'http.receivepack', 'true']);
  return { dir, peerRoot };
};

const peerRefs = (peerRoot: string, bare: string): string =>
  git(path.join(peerRoot, bare), 'for-each-ref', '--format=%(refname)');

describe.skipIf(!GIT_AVAILABLE)('push delete interop', () => {
  describe.each([
    { label: 'a full destination the remote lacks', refspecs: [':refs/heads/nope'] },
    { label: 'a short destination naming a remote tag', refspecs: [':t1'] },
  ])('Given $label', ({ refspecs }) => {
    describe('When both tools push the delete', () => {
      it('Then both succeed and the peers agree', async () => {
        // Arrange
        const { dir, peerRoot } = setUp(`ok-${refspecs[0]?.replaceAll('/', '-')}`);
        const ctx = {
          ...createNodeContext({ workDir: dir }),
          transport: backendTransport(peerRoot),
        };
        const sut = push;

        // Act
        const result = await sut(ctx, { remote: 'origin', refspecs });

        // Assert
        const twin = path.join(peerRoot, 'twin.git');
        const theirs = tryRunGitWithExit(['-C', dir, 'push', '--porcelain', twin, ...refspecs]);
        expect(theirs.exitCode).toBe(0);
        expect(result.pushedRefs.map((ref) => ref.status)).toEqual(['ok']);
        expect(peerRefs(peerRoot, 'peer.git')).toBe(peerRefs(peerRoot, 'twin.git'));
      });
    });
  });

  describe('Given a short destination naming no remote ref, beside a new branch', () => {
    describe('When both tools push', () => {
      it("Then both report git's error, send nothing and leave the peers alike", async () => {
        // Arrange
        const { dir, peerRoot } = setUp('missing');
        const errors: string[] = [];
        const ctx = {
          ...createNodeContext({ workDir: dir }),
          transport: backendTransport(peerRoot),
          logger: { error: (text: string) => errors.push(text) },
        };
        const refspecs = [':nope', 'b2'];
        const sut = push;

        // Act
        const caught = await sut(ctx, { remote: 'origin', refspecs }).catch((err: unknown) => err);

        // Assert
        const twin = path.join(peerRoot, 'twin.git');
        const theirs = tryRunGitWithExit(['-C', dir, 'push', '--porcelain', twin, ...refspecs]);
        const gitErrors = theirs.stderr
          .split('\n')
          .filter((line) => line.startsWith(GIT_ERROR_PREFIX))
          .map((line) => line.slice(GIT_ERROR_PREFIX.length));
        expect(theirs.exitCode).toBe(1);
        expect((caught as { data?: { code?: string } }).data?.code).toBe('PUSH_REFSPEC_UNMATCHED');
        expect([...errors, `failed to push some refs to '${twin}'`]).toEqual(gitErrors);
        expect(peerRefs(peerRoot, 'peer.git')).toBe(peerRefs(peerRoot, 'twin.git'));
      });
    });
  });
});
