/**
 * Cross-tool interop — a path restore leaves the conflict stages of every
 * other path in place. A merge conflicts on `c`, `a` is dirty, and a restore
 * of `a` alone runs in tsgit and in canonical git on twin repositories.
 *
 * @proves
 *   surface:        checkout
 *   bucket:         cross-tool-interop
 *   unique:         checkout path restore keeps the other paths' conflict stages as git does
 *   interopSurface: checkout
 */
import { writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { checkout } from '../../src/application/commands/checkout.js';
import {
  GIT_AVAILABLE,
  git,
  initBothRepos,
  lsStage,
  makePeerPair,
  type PeerPair,
  tryRunGitWithExit,
} from './interop-helpers.js';

const ROW_TIMEOUT_MS = 60_000;

const buildConflictedTwin = async (dir: string): Promise<void> => {
  await writeFile(path.join(dir, 'a'), '1\n');
  await writeFile(path.join(dir, 'c'), 'base\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'base');
  git(dir, 'checkout', '-q', '-b', 'other');
  await writeFile(path.join(dir, 'c'), 'other\n');
  git(dir, 'commit', '-q', '-a', '-m', 'other');
  git(dir, 'checkout', '-q', 'main');
  await writeFile(path.join(dir, 'c'), 'main\n');
  git(dir, 'commit', '-q', '-a', '-m', 'main');
  tryRunGitWithExit(['-C', dir, 'merge', 'other']);
  await writeFile(path.join(dir, 'a'), 'dirty\n');
};

const ROWS = [
  { title: 'checkout -- a', gitArgs: ['checkout', '--', 'a'], options: { paths: ['a'] } },
  {
    title: 'checkout HEAD -- a',
    gitArgs: ['checkout', 'HEAD', '--', 'a'],
    options: { paths: ['a'], source: 'HEAD' },
  },
] as const;

describe.skipIf(!GIT_AVAILABLE)('checkout path restore conflict stages interop', () => {
  for (const row of ROWS) {
    describe('Given a conflicted merge on c and a dirty a', () => {
      describe(`When ${row.title} runs in git and in tsgit on a twin`, () => {
        let pair: PeerPair;

        beforeAll(async () => {
          pair = await makePeerPair('checkout-stages');
          initBothRepos(pair.peer, pair.ours);
          await buildConflictedTwin(pair.peer);
          await buildConflictedTwin(pair.ours);
          git(pair.peer, ...row.gitArgs);
          const sut = checkout;
          await sut(createNodeContext({ workDir: pair.ours }), row.options);
        }, ROW_TIMEOUT_MS);

        afterAll(async () => {
          await pair.dispose();
        });

        it('Then the staged entries agree with git, stages 1 to 3 of c included', () => {
          // Arrange + Assert
          expect(lsStage(pair.ours)).toBe(lsStage(pair.peer));
          expect(lsStage(pair.ours)).toContain(' 3\tc');
        });
      });
    });
  }
});
