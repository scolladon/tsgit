/**
 * Cross-tool interop — a merge that deletes a path beyond a symlinked leading
 * directory leaves the link and the files behind it alone. The same history is
 * built with canonical git in a peer and a tsgit repo, the directory `a` is
 * then replaced by a symlink to a real directory, and both tools merge; the
 * work tree left behind is compared. Git refuses the whole merge here (it cannot
 * stash the path it sees as deleted); only the shared invariant is pinned.
 *
 * @proves
 *   surface:        repo.merge
 *   bucket:         cross-tool-interop
 *   unique:         merge-side delete beyond a symlink runs against git
 *   interopSurface: merge
 */
import { existsSync, lstatSync, readlinkSync, symlinkSync } from 'node:fs';
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
  tryRunGit,
} from './interop-helpers.js';

const AUTHOR: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};
const OURS_B = 'ours\n';
const THEIRS_B = 'theirs\n';

/** `a/x` is tracked on base and ours and deleted by theirs. */
const buildTrackedBeneathA = async (dir: string): Promise<void> => {
  await writeFile(path.join(dir, 'b'), 'base\n');
  await mkdir(path.join(dir, 'a'));
  await writeFile(path.join(dir, 'a', 'x'), 'x\n');
  git(dir, 'add', 'b', 'a/x');
  git(dir, 'commit', '-q', '-m', 'base');
  git(dir, 'checkout', '-q', '-b', 'theirs');
  git(dir, 'rm', '-q', 'a/x');
  await writeFile(path.join(dir, 'b'), THEIRS_B);
  git(dir, 'commit', '-q', '-am', 'theirs');
  git(dir, 'checkout', '-q', 'main');
  await writeFile(path.join(dir, 'b'), OURS_B);
  git(dir, 'commit', '-q', '-am', 'ours');
};

const replaceAWithLinkToReal = async (dir: string): Promise<void> => {
  await rename(path.join(dir, 'a'), path.join(dir, 'real'));
  symlinkSync('real', path.join(dir, 'a'));
  await writeFile(path.join(dir, 'real', 'survivor'), 'survivor\n');
};

const snapshot = (dir: string): Record<string, unknown> => ({
  link: lstatSync(path.join(dir, 'a')).isSymbolicLink() ? readlinkSync(path.join(dir, 'a')) : null,
  behindLink: existsSync(path.join(dir, 'real', 'x')),
  survivor: existsSync(path.join(dir, 'real', 'survivor')),
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

    describe('Given theirs deletes a/x, a is now a symlink to real and b conflicts', () => {
      describe('When both tools merge theirs', () => {
        it('Then the link and the files behind it survive on both tools, as in git', async () => {
          // Arrange
          for (const dir of [pair.peer, pair.ours]) {
            await buildTrackedBeneathA(dir);
            await replaceAWithLinkToReal(dir);
          }
          repo = await openRepository({ cwd: pair.ours });

          // Act
          const peerRun = tryRunGit(['-C', pair.peer, 'merge', 'theirs']);
          await repo.merge
            .run({ rev: 'theirs', message: 'm', author: AUTHOR })
            .catch((error: unknown) => error);

          // Assert
          expect(peerRun.ok).toBe(false);
          expect(snapshot(pair.ours)).toEqual(snapshot(pair.peer));
          expect(snapshot(pair.ours)).toEqual({ link: 'real', behindLink: true, survivor: true });
        });
      });
    });
  },
);
