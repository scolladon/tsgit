/**
 * Cross-tool interop — a merge that deletes a path beyond a symlinked leading
 * directory leaves the link and the files behind it alone. The same history is
 * built with canonical git in a peer and a tsgit repo, the directory `a` is
 * then replaced by a symlink to a real directory, and both tools merge. Git
 * refuses the whole merge here (it cannot save the path it sees as deleted),
 * with or without a conflict elsewhere: both tools must refuse and leave HEAD,
 * the index, the merge state and the work tree exactly as they were.
 *
 * @proves
 *   surface:        repo.merge
 *   bucket:         cross-tool-interop
 *   unique:         merge-side delete beyond a symlink runs against git
 *   interopSurface: merge
 */
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
} from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AuthorIdentity } from '../../src/domain/objects/index.js';
import { openRepository } from '../../src/index.node.js';
import type { Repository } from '../../src/repository.js';
import {
  GIT_AVAILABLE,
  git,
  initBothRepos,
  makePeerPair,
  type PeerPair,
  runGit,
  runGitEnv,
  tryRunGit,
} from './interop-helpers.js';

const AUTHOR: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};
const OURS_B = 'ours\n';
// Both twins must commit to identical ids, whichever second each build lands in.
const FIXED_DATE = '1700000000 +0000';
const gitAtFixedDate = (dir: string, ...args: ReadonlyArray<string>): string =>
  runGit(['-C', dir, ...args], {
    env: { ...runGitEnv(), GIT_AUTHOR_DATE: FIXED_DATE, GIT_COMMITTER_DATE: FIXED_DATE },
  });
const THEIRS_B = 'theirs\n';

/** `a/x` is tracked on base and ours and deleted by theirs; `b` is edited by theirs and, when `conflicting`, by ours. */
const buildTrackedBeneathA = async (dir: string, conflicting: boolean): Promise<void> => {
  await writeFile(path.join(dir, 'b'), 'base\n');
  await mkdir(path.join(dir, 'a'));
  await writeFile(path.join(dir, 'a', 'x'), 'x\n');
  git(dir, 'add', 'b', 'a/x');
  gitAtFixedDate(dir, 'commit', '-q', '-m', 'base');
  git(dir, 'checkout', '-q', '-b', 'theirs');
  git(dir, 'rm', '-q', 'a/x');
  await writeFile(path.join(dir, 'b'), THEIRS_B);
  gitAtFixedDate(dir, 'commit', '-q', '-am', 'theirs');
  git(dir, 'checkout', '-q', 'main');
  await writeFile(path.join(dir, conflicting ? 'b' : 'c'), OURS_B);
  git(dir, 'add', '-A');
  gitAtFixedDate(dir, 'commit', '-q', '-m', 'ours');
};

const replaceAWithLinkToReal = async (dir: string): Promise<void> => {
  await rename(path.join(dir, 'a'), path.join(dir, 'real'));
  symlinkSync('real', path.join(dir, 'a'));
  await writeFile(path.join(dir, 'real', 'survivor'), 'survivor\n');
};

const snapshot = (dir: string): Record<string, unknown> => ({
  head: git(dir, 'rev-parse', 'HEAD'),
  index: git(dir, 'ls-files', '-s'),
  mergeHead: existsSync(path.join(dir, '.git', 'MERGE_HEAD')),
  b: readFileSync(path.join(dir, 'b'), 'utf8'),
  link: lstatSync(path.join(dir, 'a')).isSymbolicLink() ? readlinkSync(path.join(dir, 'a')) : null,
  behindLink: readdirSync(path.join(dir, 'real')).sort(),
});

describe.skipIf(!GIT_AVAILABLE)(
  'merge interop — delete beyond a symlinked leading directory',
  { timeout: 60_000 },
  () => {
    let pair: PeerPair;
    let repo: Repository | undefined;

    beforeEach(async () => {
      pair = await makePeerPair('merge-delete-beyond-symlink');
      initBothRepos(pair.peer, pair.ours);
      repo = undefined;
    });

    afterEach(async () => {
      await repo?.dispose();
      await pair.dispose();
    });

    describe.each([
      ['b conflicts', true],
      ['the merge is otherwise clean', false],
    ] as const)(
      'Given theirs deletes a/x, a is now a symlink to real and %s',
      (_title, conflicting) => {
        describe('When both tools merge theirs', () => {
          it('Then both refuse and leave HEAD, the index and the work tree untouched', async () => {
            // Arrange
            for (const dir of [pair.peer, pair.ours]) {
              await buildTrackedBeneathA(dir, conflicting);
              await replaceAWithLinkToReal(dir);
            }
            const before = snapshot(pair.ours);
            expect(snapshot(pair.peer)).toEqual(before);
            repo = await openRepository({ cwd: pair.ours });

            // Act
            const peerRun = tryRunGit(['-C', pair.peer, 'merge', 'theirs']);
            const oursError = await repo.merge
              .run({ rev: 'theirs', message: 'm', author: AUTHOR })
              .catch((error: unknown) => error);

            // Assert
            expect(peerRun.ok).toBe(false);
            expect(oursError).toMatchObject({ data: { code: 'WORKING_TREE_DIRTY' } });
            expect(snapshot(pair.peer)).toEqual(before);
            expect(snapshot(pair.ours)).toEqual(before);
          });
        });
      },
    );
  },
);
