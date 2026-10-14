/**
 * Cross-tool interop — the index a clean `stash apply` (no `--index`) leaves:
 * changed or deleted paths return to their pre-apply entry with zero stat, new
 * paths stay staged, and a restored entry that collides with a new path is
 * dropped so `write-tree` still succeeds.
 *
 * @proves
 *   surface:        stash
 *   bucket:         cross-tool-interop
 *   unique:         stash apply leaves the index git leaves, zero-stat entries and file-to-directory collisions included
 *   interopSurface: stash
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { stashApply, stashPush } from '../../src/application/commands/stash.js';
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
const ZERO_STAT_LINE = '  ctime: 0:0';

interface Row {
  readonly title: string;
  readonly stage: (dir: string) => Promise<void>;
}

const put = async (dir: string, rel: string, body: string): Promise<void> => {
  await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
  await writeFile(path.join(dir, rel), body);
};

const seed = async (dir: string): Promise<void> => {
  await put(dir, 'm', '1\n');
  await put(dir, 'k', '1\n');
  await put(dir, 'd', 'f\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'base');
};

const ROWS: ReadonlyArray<Row> = [
  {
    title: 'a staged edit and a staged new file',
    stage: async (dir) => {
      await put(dir, 'm', '2\n');
      await put(dir, 'n', 'new\n');
      git(dir, 'add', 'm', 'n');
    },
  },
  {
    title: 'a file replaced by a directory',
    stage: async (dir) => {
      await rm(path.join(dir, 'd'));
      await put(dir, 'd/x', 'x\n');
      git(dir, 'add', '-A');
    },
  },
];

const zeroStatPaths = (dir: string): string[] => {
  const lines = git(dir, 'ls-files', '--debug').split('\n');
  return lines.flatMap((line, at) =>
    line !== '' && !line.startsWith(' ') && lines[at + 1] === ZERO_STAT_LINE ? [line] : [],
  );
};

describe.skipIf(!GIT_AVAILABLE)('stash apply index interop', () => {
  for (const row of ROWS) {
    describe(`Given a stash of ${row.title}`, () => {
      describe('When stash apply runs without the index flag in git and in tsgit on a twin', () => {
        let pair: PeerPair;

        beforeAll(async () => {
          pair = await makePeerPair('stash-apply-index');
          initBothRepos(pair.peer, pair.ours);
          for (const dir of [pair.peer, pair.ours]) {
            await seed(dir);
            await row.stage(dir);
          }
          git(pair.peer, 'stash', 'push', '-q');
          git(pair.peer, 'stash', 'apply', '-q');
          const ctx = createNodeContext({ workDir: pair.ours });
          await stashPush(ctx, {});
          const sut = stashApply;
          await sut(ctx, {});
        }, ROW_TIMEOUT_MS);

        afterAll(async () => {
          await pair.dispose();
        });

        it('Then the staged entries agree with git', () => {
          // Arrange + Assert
          expect(lsStage(pair.ours)).toBe(lsStage(pair.peer));
        });

        it('Then the same paths carry a zero stat as in git', () => {
          // Arrange + Assert
          expect(zeroStatPaths(pair.ours)).toEqual(zeroStatPaths(pair.peer));
        });

        it('Then git write-tree succeeds', () => {
          // Arrange + Assert
          expect(tryRunGitWithExit(['-C', pair.ours, 'write-tree']).exitCode).toBe(0);
        });
      });
    });
  }
});
