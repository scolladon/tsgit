/**
 * Cross-tool interop — the name a detaching `checkout` and a `tag` target
 * stand for. One shared base is built once with canonical git, carrying a
 * short name that is both a branch and a tag, a tag-only name and a
 * remote-tracking path; each row copies it into a fresh `peer` (moved by git)
 * and `ours` (moved by tsgit) and compares the object id both land on.
 *
 * @proves
 *   surface:        checkout
 *   bucket:         cross-tool-interop
 *   unique:         a detaching checkout and a tag target take git's revision ladder
 *   interopSurface: checkout
 */
import { cp, mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { checkout } from '../../src/application/commands/checkout.js';
import { tagCreate } from '../../src/application/commands/tag.js';
import type { Context } from '../../src/ports/context.js';
import {
  disableAutoMaintenance,
  GIT_AVAILABLE,
  git,
  runGit,
  runGitEnv,
} from './interop-helpers.js';

const SETUP_TIMEOUT = 60_000;

const IDENTITY_ENV: NodeJS.ProcessEnv = {
  ...runGitEnv(),
  GIT_AUTHOR_NAME: 'A',
  GIT_AUTHOR_EMAIL: 'a@x',
  GIT_AUTHOR_DATE: '1700000000 +0000',
  GIT_COMMITTER_NAME: 'A',
  GIT_COMMITTER_EMAIL: 'a@x',
  GIT_COMMITTER_DATE: '1700000000 +0000',
};

describe.skipIf(!GIT_AVAILABLE)('integration — target-name parity with canonical git', () => {
  let base = '';
  const caseRoots: string[] = [];

  beforeAll(async () => {
    base = await mkdtemp(path.join(os.tmpdir(), 'tsgit-target-dwim-interop-'));
    runGit(['init', '-q', '-b', 'main', base]);
    git(base, 'config', 'user.name', 'A');
    git(base, 'config', 'user.email', 'a@x');
    git(base, 'config', 'commit.gpgsign', 'false');
    git(base, 'config', 'tag.gpgsign', 'false');
    disableAutoMaintenance(base);
    runGit(['-C', base, 'commit', '-q', '--allow-empty', '-m', 'c1'], { env: IDENTITY_ENV });
    const first = git(base, 'rev-parse', 'HEAD').trim();
    runGit(['-C', base, 'commit', '-q', '--allow-empty', '-m', 'c2'], { env: IDENTITY_ENV });
    // `amb` is a branch at c1 and a tag at c2, so the resolution order shows.
    git(base, 'update-ref', 'refs/heads/amb', first);
    git(base, 'update-ref', 'refs/tags/amb', 'HEAD');
    git(base, 'update-ref', 'refs/tags/release', 'HEAD');
    git(base, 'update-ref', 'refs/remotes/org/tgt', first);
  }, SETUP_TIMEOUT);

  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
    await Promise.all(
      caseRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  const casePair = async (
    slug: string,
  ): Promise<{ readonly peer: string; readonly ours: string; readonly ctx: Context }> => {
    const root = await mkdtemp(path.join(os.tmpdir(), `tsgit-target-dwim-${slug}-`));
    caseRoots.push(root);
    const peer = path.join(root, 'peer');
    const ours = path.join(root, 'ours');
    await cp(base, peer, { recursive: true });
    await cp(base, ours, { recursive: true });
    return { peer, ours, ctx: createNodeContext({ workDir: ours }) };
  };

  describe('Given a short name that is both a branch and a tag', () => {
    describe('When both tools detach onto it', () => {
      it('Then they land on the same object, the branch checkout looks at first', async () => {
        // Arrange
        const { peer, ctx } = await casePair('ambiguous');

        // Act
        git(peer, 'checkout', '--detach', 'amb');
        const result = await checkout(ctx, { rev: 'amb', detach: true });

        // Assert
        expect(result.id).toBe(git(peer, 'rev-parse', 'HEAD').trim());
        expect(result.id).toBe(git(peer, 'rev-parse', 'refs/heads/amb').trim());
      });
    });

    describe('When both tools tag it', () => {
      it('Then both tags name the object the revision ladder reaches first', async () => {
        // Arrange
        const { peer, ctx } = await casePair('tag-ambiguous');

        // Act
        runGit(['-C', peer, 'tag', 'fresh', 'amb'], { env: IDENTITY_ENV });
        const result = await tagCreate(ctx, { name: 'fresh', target: 'amb' });

        // Assert
        expect(result.id).toBe(git(peer, 'rev-parse', 'refs/tags/fresh').trim());
        expect(result.id).toBe(git(peer, 'rev-parse', 'refs/tags/amb').trim());
      });
    });

    describe('When both tools tag its partially qualified branch path', () => {
      it('Then both tags name the branch', async () => {
        // Arrange
        const { peer, ctx } = await casePair('tag-heads');

        // Act
        runGit(['-C', peer, 'tag', 'fresh', 'heads/amb'], { env: IDENTITY_ENV });
        const result = await tagCreate(ctx, { name: 'fresh', target: 'heads/amb' });

        // Assert
        expect(result.id).toBe(git(peer, 'rev-parse', 'refs/tags/fresh').trim());
        expect(result.id).toBe(git(peer, 'rev-parse', 'refs/heads/amb').trim());
      });
    });
  });

  describe('Given a short name that only a tag carries', () => {
    describe('When both tools detach onto it', () => {
      it('Then they land on the tag', async () => {
        // Arrange
        const { peer, ctx } = await casePair('tag-only');

        // Act
        git(peer, 'checkout', '--detach', 'release');
        const result = await checkout(ctx, { rev: 'release', detach: true });

        // Assert
        expect(result.id).toBe(git(peer, 'rev-parse', 'HEAD').trim());
        expect(result.id).toBe(git(peer, 'rev-parse', 'refs/tags/release').trim());
      });
    });
  });

  describe('Given a remote-tracking ref named by its short path', () => {
    describe('When both tools detach onto it', () => {
      it('Then they land on the tracking ref', async () => {
        // Arrange
        const { peer, ctx } = await casePair('remote-short');

        // Act
        git(peer, 'switch', '--detach', 'org/tgt');
        const result = await checkout(ctx, { rev: 'org/tgt', detach: true });

        // Assert
        expect(result.id).toBe(git(peer, 'rev-parse', 'HEAD').trim());
        expect(result.id).toBe(git(peer, 'rev-parse', 'refs/remotes/org/tgt').trim());
      });
    });
  });
});
