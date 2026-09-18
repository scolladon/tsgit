/**
 * Cross-tool interop — which reference `branch -d`'s safety valve measures a
 * tip against once `branch.<n>.remote` and `branch.<n>.merge` are configured.
 * Every row builds two repositories of the same shape, runs canonical git's
 * `branch -d` against one and tsgit's `branchDelete` against the other, and
 * compares the exit code and the `error:` line against the refusal (or the
 * deletion) tsgit produces. Covers the fetch-refspec shapes `query_refspecs`
 * skips rather than maps — a colon-free spec, an empty destination, a negative
 * spec — the spec shape git's remote table refuses outright, and the
 * pseudo-remote `.` whose merge value git resolves before storing it.
 *
 * @proves
 *   surface:        branch.delete
 *   bucket:         cross-tool-interop
 *   unique:         branch.delete picks the same merge reference git does for
 *                    every configured-upstream shape, refspecs included
 *   interopSurface: branch
 */
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { branchDelete } from '../../src/application/commands/branch.js';
import { TsgitError } from '../../src/domain/error.js';
import { openRepository } from '../../src/index.node.js';
import {
  disableAutoMaintenance,
  GIT_AVAILABLE,
  git,
  runGit,
  tryRunGitWithExit,
} from './interop-helpers.js';

const ROW_TIMEOUT = 60_000;

/** git's unforced refusal, with `advice.forceDeleteBranch` off so the two hint
 *  lines it would otherwise append never enter the comparison. */
const unmergedLine = (branch: string): string =>
  `error: the branch '${branch}' is not fully merged\n`;

const quietDelete = (dir: string, ...args: ReadonlyArray<string>) =>
  tryRunGitWithExit(['-C', dir, '-c', 'advice.forceDeleteBranch=false', 'branch', ...args]);

describe.skipIf(!GIT_AVAILABLE)('branch delete — configured-upstream interop', () => {
  const caseRoots: string[] = [];

  /**
   * A repository with `main` at the root commit, `topic` one commit ahead of
   * it, and `feature` standing on `topic`'s tip — so `feature` is merged into
   * `topic` and NOT into HEAD. Which of the two the valve picks is the whole
   * question every row below asks.
   */
  const caseRepo = async (
    slug: string,
    entries: ReadonlyArray<readonly [string, string]>,
  ): Promise<string> => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), `tsgit-branch-up-${slug}-`)));
    caseRoots.push(root);
    const dir = path.join(root, 'repo');
    runGit(['init', '-q', '-b', 'main', dir]);
    git(dir, 'config', 'user.name', 'Ada');
    git(dir, 'config', 'user.email', 'ada@example.com');
    disableAutoMaintenance(dir);
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'root');
    git(dir, 'checkout', '-q', '-b', 'topic');
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'ahead');
    git(dir, 'checkout', '-q', 'main');
    git(dir, 'branch', 'feature', 'topic');
    git(dir, 'update-ref', 'refs/remotes/origin/topic', 'topic');
    for (const [key, value] of entries) git(dir, 'config', '--add', key, value);
    return dir;
  };

  const deleteWithTsgit = async (dir: string): Promise<TsgitError | undefined> => {
    const repo = await openRepository({ cwd: dir });
    try {
      await branchDelete(repo.ctx, { name: 'feature' });
      return undefined;
    } catch (error) {
      expect(error).toBeInstanceOf(TsgitError);
      return error as TsgitError;
    } finally {
      await repo.dispose();
    }
  };

  afterAll(async () => {
    await Promise.all(
      caseRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  const UPSTREAM_ON_ORIGIN: ReadonlyArray<readonly [string, string]> = [
    ['branch.feature.remote', 'origin'],
    ['branch.feature.merge', 'refs/heads/topic'],
    ['remote.origin.url', '.'],
  ];

  describe.each([
    { slug: 'no-colon', spec: 'refs/heads/topic', label: 'a colon-free spec' },
    { slug: 'empty-dst', spec: 'refs/heads/topic:', label: 'an empty destination' },
    { slug: 'negative', spec: '^refs/heads/topic', label: 'a negative spec' },
  ])('Given a fetch refspec that maps nothing — $label', (row) => {
    describe('When git branch -d and tsgit branchDelete both target the branch', () => {
      it(
        'Then both fall back to HEAD and refuse the unmerged tip',
        async () => {
          // Arrange
          const peer = await caseRepo(`${row.slug}-peer`, [
            ...UPSTREAM_ON_ORIGIN,
            ['remote.origin.fetch', row.spec],
          ]);
          const dir = await caseRepo(row.slug, [
            ...UPSTREAM_ON_ORIGIN,
            ['remote.origin.fetch', row.spec],
          ]);

          // Act
          const gitResult = quietDelete(peer, '-d', 'feature');
          const err = await deleteWithTsgit(dir);

          // Assert
          expect(gitResult.exitCode).toBe(1);
          expect(gitResult.stderr).toBe(unmergedLine('feature'));
          expect(err?.data).toEqual({
            code: 'BRANCH_NOT_FULLY_MERGED',
            name: 'refs/heads/feature',
          });
        },
        ROW_TIMEOUT,
      );
    });
  });

  describe('Given a negative refspec ahead of one that does map the upstream', () => {
    describe('When git branch -d and tsgit branchDelete both target the branch', () => {
      it(
        'Then both skip the negative one and measure against the tracking ref',
        async () => {
          // Arrange
          const entries: ReadonlyArray<readonly [string, string]> = [
            ...UPSTREAM_ON_ORIGIN,
            ['remote.origin.fetch', '^refs/heads/topic'],
            ['remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'],
          ];
          const peer = await caseRepo('negative-then-map-peer', entries);
          const dir = await caseRepo('negative-then-map', entries);

          // Act
          const gitResult = quietDelete(peer, '-d', 'feature');
          const err = await deleteWithTsgit(dir);

          // Assert
          expect(gitResult.exitCode).toBe(0);
          expect(err).toBeUndefined();
        },
        ROW_TIMEOUT,
      );
    });
  });

  describe('Given a fetch refspec the remote table refuses outright', () => {
    describe('When git branch -d and tsgit branchDelete both target the branch', () => {
      it(
        'Then both refuse before the valve decides anything',
        async () => {
          // Arrange
          const entries: ReadonlyArray<readonly [string, string]> = [
            ...UPSTREAM_ON_ORIGIN,
            ['remote.origin.fetch', 'refs/heads/*'],
          ];
          const peer = await caseRepo('bad-spec-peer', entries);
          const dir = await caseRepo('bad-spec', entries);

          // Act
          const gitResult = quietDelete(peer, '-d', 'feature');
          const err = await deleteWithTsgit(dir);

          // Assert
          expect(gitResult.exitCode).toBe(128);
          expect(gitResult.stderr).toContain("fatal: invalid refspec 'refs/heads/*'");
          expect(err?.data).toMatchObject({ code: 'REFSPEC_INVALID' });
        },
        ROW_TIMEOUT,
      );
    });
  });

  describe.each([{ slug: 'dot-full', merge: 'refs/heads/topic', label: 'a full ref name' }])(
    'Given the pseudo-remote "." and a merge value holding $label',
    (row) => {
      describe('When git branch -d and tsgit branchDelete both target the branch', () => {
        it(
          'Then both measure against that branch and delete',
          async () => {
            // Arrange
            const entries: ReadonlyArray<readonly [string, string]> = [
              ['branch.feature.remote', '.'],
              ['branch.feature.merge', row.merge],
            ];
            const peer = await caseRepo(`${row.slug}-peer`, entries);
            const dir = await caseRepo(row.slug, entries);

            // Act
            const gitResult = quietDelete(peer, '-d', 'feature');
            const err = await deleteWithTsgit(dir);

            // Assert
            expect(gitResult.exitCode).toBe(0);
            expect(err).toBeUndefined();
          },
          ROW_TIMEOUT,
        );
      });
    },
  );

  describe('Given the pseudo-remote "." and a merge value naming nothing', () => {
    describe('When git branch -d and tsgit branchDelete both target the branch', () => {
      it(
        'Then both fall back to HEAD and refuse the unmerged tip',
        async () => {
          // Arrange
          const entries: ReadonlyArray<readonly [string, string]> = [
            ['branch.feature.remote', '.'],
            ['branch.feature.merge', 'nowhere'],
          ];
          const peer = await caseRepo('dot-missing-peer', entries);
          const dir = await caseRepo('dot-missing', entries);

          // Act
          const gitResult = quietDelete(peer, '-d', 'feature');
          const err = await deleteWithTsgit(dir);

          // Assert
          expect(gitResult.exitCode).toBe(1);
          expect(gitResult.stderr).toBe(unmergedLine('feature'));
          expect(err?.data).toEqual({
            code: 'BRANCH_NOT_FULLY_MERGED',
            name: 'refs/heads/feature',
          });
        },
        ROW_TIMEOUT,
      );
    });
  });
});
