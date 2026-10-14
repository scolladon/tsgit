/**
 * POSIX-only interop — `status` refresh against read-only locations: a
 * read-only `.git` directory degrades to a warning, while a read-only
 * `index` file in a writable directory is replaced by the lock rename.
 *
 * @proves
 *   surface:        status
 *   bucket:         platform-only
 *   unique:         status refresh degrades on a read-only git dir and replaces a read-only index file
 *   interopSurface: index
 */
import { chmod, stat, utimes, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNodeContext } from '../../../src/adapters/node/node-adapter.js';
import { status } from '../../../src/application/commands/status.js';
import type { Context } from '../../../src/ports/context.js';
import { GIT_AVAILABLE, git, makePeerPair, type PeerPair, runGit } from '../interop-helpers.js';

const IS_ROOT = process.getuid?.() === 0;
const WRITABLE_DIR = 0o755;
const WRITABLE_FILE = 0o644;

describe.skipIf(!GIT_AVAILABLE || IS_ROOT)('status refresh read-only interop', () => {
  let pair: PeerPair;
  let gitDir: string;
  let ctx: Context;

  beforeEach(async () => {
    pair = await makePeerPair('status-refresh-ro');
    const dir = pair.ours;
    runGit(['init', '-q', '-b', 'main', dir]);
    git(dir, 'config', 'user.name', 'Ada');
    git(dir, 'config', 'user.email', 'ada@example.com');
    await writeFile(path.join(dir, 'b'), 'b body\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'one');
    const when = new Date(Date.now() - 5000);
    await utimes(path.join(dir, 'b'), when, when);
    gitDir = path.join(dir, '.git');
    ctx = createNodeContext({ workDir: dir });
  });

  afterEach(async () => {
    await chmod(gitDir, WRITABLE_DIR);
    await chmod(path.join(gitDir, 'index'), WRITABLE_FILE);
    await pair.dispose();
  });

  describe('Given a read-only git directory', () => {
    describe('When status needs to refresh', () => {
      it('Then it does not throw, leaves the index and warns PERMISSION_DENIED once', async () => {
        // Arrange
        const before = (await stat(path.join(gitDir, 'index'))).ino;
        await chmod(gitDir, 0o555);
        const warn = vi.fn();
        const sut = { ...ctx, logger: { warn } } as Context;

        // Act
        const result = await status(sut);

        // Assert
        expect(result.clean).toBe(true);
        expect((await stat(path.join(gitDir, 'index'))).ino).toBe(before);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith(
          'status: index refresh skipped',
          expect.objectContaining({ code: 'PERMISSION_DENIED' }),
        );
      });
    });
  });

  describe('Given a read-only index file in a writable git directory', () => {
    describe('When status needs to refresh', () => {
      it('Then the index is replaced by the lock rename', async () => {
        // Arrange
        const index = path.join(gitDir, 'index');
        const before = (await stat(index)).ino;
        await chmod(index, 0o444);

        // Act
        await status(ctx);

        // Assert
        expect((await stat(index)).ino).not.toBe(before);
      });
    });
  });
});
