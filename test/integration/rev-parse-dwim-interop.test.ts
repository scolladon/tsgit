/**
 * Cross-tool interop — `revParse`'s ref DWIM over a candidate git's reading
 * walk does not resolve: a symbolic chain deeper than its cap, a cycle, or a
 * dangling link. One repository is built once with canonical git; each row
 * runs `git rev-parse` and tsgit's `revParse` on the same argument against it
 * and compares the resolved object id, or that neither resolves.
 *
 * @proves
 *   surface:        revParse
 *   bucket:         cross-tool-interop
 *   unique:         ref DWIM skips a candidate git's reading walk cannot resolve and tries the next
 *   interopSurface: revParse
 */
import { cp, mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { branchCreate } from '../../src/application/commands/branch.js';
import { checkout } from '../../src/application/commands/checkout.js';
import { log } from '../../src/application/commands/log.js';
import { reset } from '../../src/application/commands/reset.js';
import { revParse } from '../../src/application/commands/rev-parse.js';
import { mergeBase } from '../../src/application/primitives/merge-base.js';
import type { TsgitError } from '../../src/domain/error.js';
import type { ObjectId } from '../../src/domain/objects/index.js';
import {
  disableAutoMaintenance,
  GIT_AVAILABLE,
  git,
  runGit,
  runGitEnv,
  tryRunGitWithExit,
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

/** `refs/<namespace>/<base>` and `hops - 1` further links, the last naming `tip`. */
const plantChain = (
  dir: string,
  namespace: string,
  base: string,
  hops: number,
  tip: string,
): void => {
  const link = (index: number): string =>
    `refs/${namespace}/${index === 0 ? base : `${base}-${index}`}`;
  for (let index = 0; index < hops; index += 1) {
    git(dir, 'symbolic-ref', link(index), link(index + 1));
  }
  git(dir, 'update-ref', link(hops), tip);
};

describe.skipIf(!GIT_AVAILABLE)('integration — revParse ref DWIM parity with canonical git', () => {
  let repo = '';
  let first = '';
  let second = '';
  const caseRoots: string[] = [];

  beforeAll(async () => {
    repo = await mkdtemp(path.join(os.tmpdir(), 'tsgit-rev-parse-dwim-interop-'));
    runGit(['init', '-q', '-b', 'main', repo]);
    git(repo, 'config', 'commit.gpgsign', 'false');
    git(repo, 'config', 'tag.gpgsign', 'false');
    disableAutoMaintenance(repo);
    runGit(['-C', repo, 'commit', '-q', '--allow-empty', '-m', 'c1'], { env: IDENTITY_ENV });
    first = git(repo, 'rev-parse', 'HEAD').trim();
    runGit(['-C', repo, 'commit', '-q', '--allow-empty', '-m', 'c2'], { env: IDENTITY_ENV });
    second = git(repo, 'rev-parse', 'HEAD').trim();
    plantChain(repo, 'heads', 'x', 5, second);
    git(repo, 'update-ref', 'refs/tags/x', first);
    plantChain(repo, 'heads', 'four', 4, second);
    plantChain(repo, 'tags', 'y', 5, second);
    git(repo, 'update-ref', 'refs/heads/y', first);
    git(repo, 'symbolic-ref', 'refs/tags/cy', 'refs/tags/cy2');
    git(repo, 'symbolic-ref', 'refs/tags/cy2', 'refs/tags/cy');
    git(repo, 'update-ref', 'refs/heads/cy', first);
    git(repo, 'symbolic-ref', 'refs/tags/dg', 'refs/tags/nope');
    git(repo, 'update-ref', 'refs/heads/dg', first);
    // A short name two namespaces carry, the tag on the newer commit.
    git(repo, 'update-ref', 'refs/heads/amb', first);
    git(repo, 'update-ref', 'refs/tags/amb', second);
  }, SETUP_TIMEOUT);

  afterAll(async () => {
    await rm(repo, { recursive: true, force: true });
    await Promise.all(
      caseRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  /** A private copy of the shared fixture, for the rows that write. */
  const caseRepo = async (slug: string): Promise<string> => {
    const root = await mkdtemp(path.join(os.tmpdir(), `tsgit-rev-parse-dwim-${slug}-`));
    caseRoots.push(root);
    const dir = path.join(root, 'repo');
    await cp(repo, dir, { recursive: true });
    return dir;
  };

  describe('Given candidates git skips ahead of one it resolves', () => {
    describe('When git rev-parse and revParse resolve the short name', () => {
      it.each([
        {
          label: 'a five-hop refs/heads/x behind a valid refs/tags/x',
          argument: 'x',
          expected: () => first,
        },
        {
          label: 'a five-hop refs/tags/y ahead of a valid refs/heads/y',
          argument: 'y',
          expected: () => first,
        },
        {
          label: 'a refs/tags/cy cycle ahead of a valid refs/heads/cy',
          argument: 'cy',
          expected: () => first,
        },
        {
          label: 'a dangling refs/tags/dg ahead of a valid refs/heads/dg',
          argument: 'dg',
          expected: () => first,
        },
        { label: 'a four-hop chain, within the cap', argument: 'four', expected: () => second },
      ])('Then both resolve $label to the same object', async ({ argument, expected }) => {
        // Arrange
        const sut = revParse;
        const ctx = createNodeContext({ workDir: repo });

        // Act
        const result = await sut(ctx, argument);

        // Assert
        const gitResult = tryRunGitWithExit(['-C', repo, 'rev-parse', argument], {
          env: runGitEnv(),
        });
        expect(gitResult.exitCode).toBe(0);
        expect(gitResult.stdout.trim()).toBe(expected());
        expect(result).toBe(expected());
      });
    });
  });

  describe('Given a five-hop chain', () => {
    describe('When both resolve it named in full or through a partial prefix', () => {
      it.each([
        { argument: 'refs/heads/x', verify: true },
        { argument: 'heads/x', verify: true },
        { argument: 'refs/heads/x', verify: false },
        { argument: 'heads/x', verify: false },
      ])('Then neither resolves $argument (--verify: $verify)', async ({ argument, verify }) => {
        // Arrange — both forms refuse; only the wording git prints differs,
        // so the row runs each one rather than assuming they agree.
        const sut = revParse;
        const ctx = createNodeContext({ workDir: repo });

        // Act
        let caught: unknown;
        try {
          await sut(ctx, argument);
        } catch (err) {
          caught = err;
        }

        // Assert
        const gitResult = tryRunGitWithExit(
          ['-C', repo, 'rev-parse', ...(verify ? ['--verify'] : []), argument],
          { env: runGitEnv() },
        );
        expect(gitResult.exitCode).toBe(128);
        expect(gitResult.stderr).toContain('ignoring dangling symref refs/heads/x');
        expect(gitResult.stderr).toContain(
          verify ? 'Needed a single revision' : 'ambiguous argument',
        );
        expect((caught as TsgitError).data).toEqual({ code: 'OBJECT_NOT_FOUND', id: argument });
      });
    });
  });

  describe('Given a short name a branch and a tag both carry', () => {
    describe('When git rev-parse and revParse both resolve it', () => {
      it('Then both take the tag, which the ladder reaches first', async () => {
        // Arrange
        const sut = revParse;
        const ctx = createNodeContext({ workDir: repo });

        // Act
        const result = await sut(ctx, 'amb');

        // Assert
        const gitResult = tryRunGitWithExit(['-C', repo, 'rev-parse', 'amb'], { env: runGitEnv() });
        expect(gitResult.exitCode).toBe(0);
        expect(gitResult.stderr).toBe("warning: refname 'amb' is ambiguous.\n");
        expect(gitResult.stdout.trim()).toBe(second);
        expect(result).toBe(second);
        expect(git(repo, 'rev-parse', 'refs/heads/amb').trim()).toBe(first);
      });
    });
  });

  describe('Given a short name whose earlier candidate git cannot walk', () => {
    describe('When the surfaces that take a name, other than rev-parse, resolve it', () => {
      it('Then every one of them lands on the later candidate, on both tools', async () => {
        // Arrange — one copy per tool: four of these five surfaces write.
        const peer = await caseRepo('dw4-peer');
        const ours = await caseRepo('dw4-ours');
        const ctx = createNodeContext({ workDir: ours });

        // Act — git's five
        const gitLog = tryRunGitWithExit(['-C', peer, 'log', '-1', '--format=%H', 'y'], {
          env: runGitEnv(),
        });
        const gitMergeBase = tryRunGitWithExit(['-C', peer, 'merge-base', 'y', 'main'], {
          env: runGitEnv(),
        });
        runGit(['-C', peer, 'branch', 'fresh-branch', 'y'], { env: IDENTITY_ENV });
        runGit(['-C', peer, 'reset', '--soft', 'y'], { env: IDENTITY_ENV });
        runGit(['-C', peer, 'checkout', '--detach', 'y'], { env: IDENTITY_ENV });

        // Act — tsgit's four name-taking equivalents; `mergeBase` takes
        // resolved ids, so its DWIM is `revParse`'s, run here explicitly.
        const entries = await log(ctx, { rev: 'y', limit: 1 });
        const bases = await mergeBase(ctx, [
          (await revParse(ctx, 'y')) as ObjectId,
          (await revParse(ctx, 'main')) as ObjectId,
        ]);
        const created = await branchCreate(ctx, { name: 'fresh-branch', startPoint: 'y' });
        const resetResult = await reset(ctx, { mode: 'soft', rev: 'y' });
        const detached = await checkout(ctx, { rev: 'y', detach: true });

        // Assert
        expect(gitLog.stdout.trim()).toBe(first);
        expect(gitMergeBase.stdout.trim()).toBe(first);
        expect(git(peer, 'rev-parse', 'refs/heads/fresh-branch').trim()).toBe(first);
        expect(git(peer, 'rev-parse', 'HEAD').trim()).toBe(first);
        expect(entries[0]?.id).toBe(first);
        expect(bases).toEqual([first]);
        expect(created.id).toBe(first);
        expect(resetResult.id).toBe(first);
        expect(detached.id).toBe(first);
        expect(git(ours, 'rev-parse', 'HEAD').trim()).toBe(git(peer, 'rev-parse', 'HEAD').trim());
      });
    });
  });
});
