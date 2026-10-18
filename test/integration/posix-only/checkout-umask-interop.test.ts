/**
 * POSIX-only interop — a path checkout creates files with git's 0666 / 0777
 * under the process umask, never chmod-ing them afterwards.
 *
 * @proves
 *   surface:        checkout
 *   bucket:         platform-only
 *   unique:         checkout creates files with the umask-derived mode git produces
 *   interopSurface: checkout
 */
import { chmod, rm, stat, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../../src/adapters/node/node-adapter.js';
import { checkout } from '../../../src/application/commands/checkout.js';
import {
  GIT_AVAILABLE,
  git,
  initBothRepos,
  makePeerPair,
  type PeerPair,
} from '../interop-helpers.js';

const PERM_MASK = 0o777;

const modeOf = async (dir: string, name: string): Promise<number> =>
  (await stat(path.join(dir, name))).mode & PERM_MASK;

const seed = async (dir: string): Promise<void> => {
  await writeFile(path.join(dir, 'f'), 'plain\n');
  await writeFile(path.join(dir, 'x'), 'exec\n');
  await chmod(path.join(dir, 'x'), 0o755);
  git(dir, 'add', 'f', 'x');
  git(dir, 'commit', '-q', '-m', 'base');
  await rm(path.join(dir, 'f'));
  await rm(path.join(dir, 'x'));
};

describe.skipIf(!GIT_AVAILABLE)('checkout umask interop', () => {
  let pair: PeerPair;
  let initialMask: number;

  beforeEach(async () => {
    initialMask = process.umask();
    pair = await makePeerPair('checkout-umask');
    initBothRepos(pair.peer, pair.ours);
    await seed(pair.peer);
    await seed(pair.ours);
  });

  afterEach(async () => {
    process.umask(initialMask);
    await pair.dispose();
  });

  describe.each([
    { mask: 0o027, plain: 0o640, exec: 0o750 },
    { mask: 0o077, plain: 0o600, exec: 0o700 },
  ])('Given umask $mask', ({ mask, plain, exec }) => {
    describe('When both tools check out f and x', () => {
      it('Then the created modes follow the umask in both twins', async () => {
        // Arrange
        process.umask(mask);
        const ctx = createNodeContext({ workDir: pair.ours });

        // Act
        git(pair.peer, 'checkout', '--', 'f', 'x');
        await checkout(ctx, { paths: ['f', 'x'] });

        // Assert
        expect(await modeOf(pair.peer, 'f')).toBe(plain);
        expect(await modeOf(pair.peer, 'x')).toBe(exec);
        expect(await modeOf(pair.ours, 'f')).toBe(plain);
        expect(await modeOf(pair.ours, 'x')).toBe(exec);
      });
    });
  });
});
