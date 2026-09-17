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
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
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
const ABBREVIATED_LENGTH = 7;

/** The subject of `<dir>`'s newest `logs/HEAD` entry. */
const lastLogSubject = (dir: string): string =>
  git(dir, 'reflog', 'show', '--format=%gs', '-1', 'HEAD').trim();

/** `<dir>/.git/HEAD` and the newest `logs/HEAD` subject — the two files a
 *  detaching or switching move actually writes. */
const headState = async (dir: string): Promise<{ head: string; subject: string }> => ({
  head: await readFile(path.join(dir, '.git', 'HEAD'), 'utf8'),
  subject: lastLogSubject(dir),
});

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

  describe('Given a name no branch carries, switched to without asking to detach', () => {
    describe.each([
      { label: 'a tag', slug: 'plain-tag', arg: 'release', ref: 'refs/tags/release' },
      {
        label: 'a remote-tracking path',
        slug: 'plain-remote',
        arg: 'org/tgt',
        ref: 'refs/remotes/org/tgt',
      },
    ])('When both tools switch to $label', ({ slug, arg, ref }) => {
      it('Then both detach onto it with byte-identical HEAD and log lines', async () => {
        // Arrange
        const { peer, ours, ctx } = await casePair(slug);

        // Act
        runGit(['-C', peer, 'checkout', arg], { env: IDENTITY_ENV });
        const result = await checkout(ctx, { rev: arg });

        // Assert
        expect(result.detached).toBe(true);
        expect(result.branch).toBeUndefined();
        expect(result.id).toBe(git(peer, 'rev-parse', ref).trim());
        expect(await readFile(path.join(ours, '.git', 'HEAD'), 'utf8')).toBe(
          await readFile(path.join(peer, '.git', 'HEAD'), 'utf8'),
        );
        expect(lastLogSubject(ours)).toBe(lastLogSubject(peer));
        expect(lastLogSubject(peer)).toBe(`checkout: moving from main to ${arg}`);
      });
    });
  });

  describe('Given an object id switched to as typed', () => {
    describe.each([
      { label: 'in full', slug: 'oid-full', abbreviate: false },
      { label: 'abbreviated', slug: 'oid-short', abbreviate: true },
    ])('When both tools switch to it $label', ({ slug, abbreviate }) => {
      it('Then both log the argument exactly as it was handed over', async () => {
        // Arrange
        const { peer, ours, ctx } = await casePair(slug);
        const full = git(peer, 'rev-parse', 'refs/tags/release').trim();
        const arg = abbreviate ? full.slice(0, ABBREVIATED_LENGTH) : full;

        // Act
        runGit(['-C', peer, 'checkout', arg], { env: IDENTITY_ENV });
        const result = await checkout(ctx, { rev: arg });

        // Assert
        expect(result.id).toBe(full);
        expect(await readFile(path.join(ours, '.git', 'HEAD'), 'utf8')).toBe(
          await readFile(path.join(peer, '.git', 'HEAD'), 'utf8'),
        );
        expect(lastLogSubject(ours)).toBe(lastLogSubject(peer));
        expect(lastLogSubject(peer)).toBe(`checkout: moving from main to ${arg}`);
      });
    });
  });

  describe('Given a short name that is both a branch and a tag', () => {
    describe('When both tools detach onto it', () => {
      it('Then they land on the same object, the branch checkout looks at first', async () => {
        // Arrange
        const { peer, ours, ctx } = await casePair('ambiguous');

        // Act
        git(peer, 'checkout', '--detach', 'amb');
        const result = await checkout(ctx, { rev: 'amb', detach: true });

        // Assert
        expect(result.id).toBe(git(peer, 'rev-parse', 'HEAD').trim());
        expect(result.id).toBe(git(peer, 'rev-parse', 'refs/heads/amb').trim());
        expect(await headState(ours)).toEqual(await headState(peer));
      });
    });

    describe('When both tools switch to it without asking to detach', () => {
      it('Then both attach to the branch the name also carries', async () => {
        // Arrange
        const { peer, ours, ctx } = await casePair('ambiguous-attached');

        // Act
        runGit(['-C', peer, 'checkout', 'amb'], { env: IDENTITY_ENV });
        const result = await checkout(ctx, { rev: 'amb' });

        // Assert
        expect(result.detached).toBe(false);
        expect(result.branch).toBe('refs/heads/amb');
        expect(result.id).toBe(git(peer, 'rev-parse', 'refs/heads/amb').trim());
        expect(await headState(ours)).toEqual(await headState(peer));
        expect(lastLogSubject(peer)).toBe('checkout: moving from main to amb');
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

    describe.each([
      { label: 'branch', slug: 'tag-heads', target: 'heads/amb', ref: 'refs/heads/amb' },
      { label: 'tag', slug: 'tag-tags', target: 'tags/amb', ref: 'refs/tags/amb' },
    ])('When both tools tag its partially qualified $label path', (row) => {
      it('Then both tags name the ref that path picks out', async () => {
        // Arrange
        const { peer, ctx } = await casePair(row.slug);

        // Act
        runGit(['-C', peer, 'tag', 'fresh', row.target], { env: IDENTITY_ENV });
        const result = await tagCreate(ctx, { name: 'fresh', target: row.target });

        // Assert
        expect(result.id).toBe(git(peer, 'rev-parse', 'refs/tags/fresh').trim());
        expect(result.id).toBe(git(peer, 'rev-parse', row.ref).trim());
        expect(git(peer, 'rev-parse', 'refs/heads/amb').trim()).not.toBe(
          git(peer, 'rev-parse', 'refs/tags/amb').trim(),
        );
      });
    });
  });

  describe('Given a short name that only a tag carries', () => {
    describe('When both tools detach onto it', () => {
      it('Then they land on the tag', async () => {
        // Arrange
        const { peer, ours, ctx } = await casePair('tag-only');

        // Act
        git(peer, 'checkout', '--detach', 'release');
        const result = await checkout(ctx, { rev: 'release', detach: true });

        // Assert
        expect(result.id).toBe(git(peer, 'rev-parse', 'HEAD').trim());
        expect(result.id).toBe(git(peer, 'rev-parse', 'refs/tags/release').trim());
        expect(await headState(ours)).toEqual(await headState(peer));
      });
    });
  });

  describe('Given a remote-tracking ref named by its short path', () => {
    describe('When both tools detach onto it', () => {
      it('Then they land on the tracking ref', async () => {
        // Arrange
        const { peer, ours, ctx } = await casePair('remote-short');

        // Act
        git(peer, 'switch', '--detach', 'org/tgt');
        const result = await checkout(ctx, { rev: 'org/tgt', detach: true });

        // Assert
        expect(result.id).toBe(git(peer, 'rev-parse', 'HEAD').trim());
        expect(result.id).toBe(git(peer, 'rev-parse', 'refs/remotes/org/tgt').trim());
        expect(await headState(ours)).toEqual(await headState(peer));
      });
    });
  });
});
