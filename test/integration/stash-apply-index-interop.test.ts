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
import { stashApply, stashPop, stashPush } from '../../src/application/commands/stash.js';
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

  describe('Given a keep-index stash whose staged state the index still holds', () => {
    describe('When stash pop with the index flag runs in git and in tsgit on a twin', () => {
      let pair: PeerPair;

      beforeAll(async () => {
        pair = await makePeerPair('stash-pop-keep-index');
        initBothRepos(pair.peer, pair.ours);
        for (const dir of [pair.peer, pair.ours]) {
          await put(dir, 'a', '1\n');
          await put(dir, 'b', '1\n');
          git(dir, 'add', '.');
          git(dir, 'commit', '-q', '-m', 'base');
          await put(dir, 'a', '2\n');
          git(dir, 'add', 'a');
          await put(dir, 'b', '2\n');
        }
        git(pair.peer, 'stash', 'push', '-q', '--keep-index');
        git(pair.peer, 'stash', 'pop', '-q', '--index');
        const ctx = createNodeContext({ workDir: pair.ours });
        await stashPush(ctx, { keepIndex: true });
        const sut = stashPop;
        await sut(ctx, { restoreIndex: true });
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
    });
  });
  describe('Given a stash and an index holding conflict stages', () => {
    describe('When stash apply runs in git and in tsgit on a twin', () => {
      let pair: PeerPair;
      let before: string;
      let gitExit: number;
      let refusal: unknown;

      beforeAll(async () => {
        pair = await makePeerPair('stash-apply-unmerged');
        initBothRepos(pair.peer, pair.ours);
        for (const dir of [pair.peer, pair.ours]) {
          await put(dir, 'c', 'a\nb\nc\n');
          await put(dir, 'o', 'o\n');
          git(dir, 'add', '.');
          git(dir, 'commit', '-q', '-m', 'base');
          git(dir, 'branch', 'theirs');
          await put(dir, 'c', 'a\nX\nc\n');
          git(dir, 'commit', '-q', '-am', 'ours');
          git(dir, 'checkout', '-q', 'theirs');
          await put(dir, 'c', 'a\nY\nc\n');
          git(dir, 'commit', '-q', '-am', 'theirs');
          git(dir, 'checkout', '-q', 'main');
          await put(dir, 'o', 'dirty\n');
          git(dir, 'stash', 'push', '-q');
          tryRunGitWithExit(['-C', dir, 'merge', '-q', 'theirs']);
          await rm(path.join(dir, '.git', 'MERGE_HEAD'));
        }
        before = lsStage(pair.peer);
        gitExit = tryRunGitWithExit(['-C', pair.peer, 'stash', 'apply']).exitCode;
        const ctx = createNodeContext({ workDir: pair.ours });
        const sut = stashApply;
        try {
          await sut(ctx, {});
        } catch (caught) {
          refusal = (caught as { readonly data?: unknown }).data;
        }
      }, ROW_TIMEOUT_MS);

      afterAll(async () => {
        await pair.dispose();
      });

      it('Then git exits non-zero and tsgit refuses naming the unmerged path', () => {
        // Arrange + Assert
        expect(gitExit).not.toBe(0);
        expect(refusal).toMatchObject({ code: 'MERGE_HAS_CONFLICTS', count: 1, paths: ['c'] });
      });

      it('Then both indexes still equal the pre-apply listing', () => {
        // Arrange + Assert
        expect(lsStage(pair.peer)).toBe(before);
        expect(lsStage(pair.ours)).toBe(before);
      });
    });
  });
});
