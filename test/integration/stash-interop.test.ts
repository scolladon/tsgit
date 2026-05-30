/**
 * Cross-tool interop — `stash` porcelain. Drives `repo.stash.{push,apply}`
 * through the `openRepository` facade and the same flow via canonical
 * `git stash` on a peer repo seeded identically, then asserts the results
 * agree. The W/I/U *commits* embed a committer timestamp (so their OIDs are not
 * comparable), but the stashed *trees* are content-addressed — equal tree OIDs
 * across the two repos prove the stash captured byte-identical state. Real
 * `git` reads tsgit's `refs/stash`, which also proves the on-disk stack is
 * git-faithful.
 *
 * @proves
 *   surface:        stash
 *   bucket:         cross-tool-interop
 *   unique:         stash push/apply index+tree state matches canonical git stash
 *   interopSurface: stash
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TsgitError } from '../../src/domain/error.js';
import { openRepository } from '../../src/index.node.js';
import type { Repository } from '../../src/repository.js';
import {
  GIT_AVAILABLE,
  git,
  lsStage,
  makePeerPair,
  type PeerPair,
  runGit,
  tryRunGit,
} from './interop-helpers.js';

const AUTHOR = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
} as const;

const writeBoth = async (pair: PeerPair, rel: string, content: string): Promise<void> => {
  const parent = path.dirname(rel);
  for (const dir of [pair.peer, pair.ours]) {
    if (parent !== '.') await mkdir(path.join(dir, parent), { recursive: true });
    await writeFile(path.join(dir, rel), content);
  }
};

const readBoth = async (pair: PeerPair, rel: string): Promise<{ peer: string; ours: string }> => ({
  peer: await readFile(path.join(pair.peer, rel), 'utf8'),
  ours: await readFile(path.join(pair.ours, rel), 'utf8'),
});

describe.skipIf(!GIT_AVAILABLE)('stash porcelain interop', () => {
  let pair: PeerPair;
  let repo: Repository;

  beforeEach(async () => {
    pair = await makePeerPair('stash');
    runGit(['init', '-q', '-b', 'main', pair.peer]);
    git(pair.peer, 'config', 'user.name', 'Ada');
    git(pair.peer, 'config', 'user.email', 'ada@example.com');
    git(pair.peer, 'config', 'commit.gpgsign', 'false');
    repo = await openRepository({ cwd: pair.ours });
    await repo.init();
  });

  afterEach(async () => {
    await repo.dispose();
    await pair.dispose();
  });

  const seed = async (): Promise<void> => {
    await writeBoth(pair, 'a.txt', 'line1\n');
    git(pair.peer, 'add', 'a.txt');
    git(pair.peer, 'commit', '-q', '-m', 'seed');
    await repo.add(['a.txt']);
    await repo.commit({ message: 'seed', author: AUTHOR });
  };

  describe('Given an identical unstaged change in both repos', () => {
    describe('When stash push runs in each', () => {
      it('Then the stashed trees match and both working trees reset to HEAD', async () => {
        // Arrange
        await seed();
        await writeBoth(pair, 'a.txt', 'line1\nline2\n');

        // Act
        git(pair.peer, 'stash');
        const saved = await repo.stash.push();

        // Assert — stash saved on both
        expect(saved.kind).toBe('saved');
        // Working trees reset to the committed content.
        const after = await readBoth(pair, 'a.txt');
        expect(after.ours).toBe('line1\n');
        expect(after.peer).toBe('line1\n');
        // The stashed working-tree (W) and index (I) trees are byte-identical.
        expect(git(pair.ours, 'rev-parse', 'stash@{0}^{tree}')).toBe(
          git(pair.peer, 'rev-parse', 'stash@{0}^{tree}'),
        );
        expect(git(pair.ours, 'rev-parse', 'stash@{0}^2^{tree}')).toBe(
          git(pair.peer, 'rev-parse', 'stash@{0}^2^{tree}'),
        );
        // The post-push index reads back identically.
        expect(lsStage(pair.ours)).toBe(lsStage(pair.peer));
        // One stack entry on each side.
        expect(git(pair.ours, 'stash', 'list').trim().split('\n')).toHaveLength(1);
      });
    });
  });

  describe('Given a stash applied back onto a clean tree', () => {
    describe('When stash apply runs in each', () => {
      it('Then the change is restored identically', async () => {
        // Arrange
        await seed();
        await writeBoth(pair, 'a.txt', 'line1\nline2\n');
        git(pair.peer, 'stash');
        await repo.stash.push();

        // Act
        git(pair.peer, 'stash', 'apply');
        const applied = await repo.stash.apply();

        // Assert
        expect(applied.kind).toBe('applied');
        const after = await readBoth(pair, 'a.txt');
        expect(after.ours).toBe('line1\nline2\n');
        expect(after.peer).toBe('line1\nline2\n');
      });
    });
  });

  describe('Given an unborn branch with a staged change', () => {
    describe('When stash push runs in each', () => {
      it('Then both refuse', async () => {
        // Arrange
        await writeBoth(pair, 'a.txt', 'x\n');
        git(pair.peer, 'add', 'a.txt');
        await repo.add(['a.txt']);

        // Act — canonical git refuses on the unborn branch.
        const peerResult = tryRunGit(['-C', pair.peer, 'stash']);

        // Assert
        expect(peerResult.ok).toBe(false);
        let oursCode: string | undefined;
        await repo.stash.push().catch((err: TsgitError) => {
          oursCode = err.data.code;
        });
        expect(oursCode).toBe('NO_INITIAL_COMMIT');
      });
    });
  });

  describe('Given a dirty working file on the stashed path', () => {
    describe('When stash apply runs in each', () => {
      it('Then both refuse to overwrite the local change', async () => {
        // Arrange
        await seed();
        await writeBoth(pair, 'a.txt', 'line1\nstashed\n');
        git(pair.peer, 'stash');
        await repo.stash.push();
        await writeBoth(pair, 'a.txt', 'line1\nlocal edit\n');

        // Act — canonical git refuses ("local changes would be overwritten").
        const peerResult = tryRunGit(['-C', pair.peer, 'stash', 'apply']);

        // Assert
        expect(peerResult.ok).toBe(false);
        let oursCode: string | undefined;
        await repo.stash.apply().catch((err: TsgitError) => {
          oursCode = err.data.code;
        });
        expect(oursCode).toBe('STASH_APPLY_WOULD_OVERWRITE');
      });
    });
  });
});
