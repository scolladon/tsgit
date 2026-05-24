/**
 * POSIX-only integration test for `NodeFileSystem.rmRecursive` against a
 * `chmod 0o000`-locked directory + `openWithNoFollow` against a directory
 * (POSIX EISDIR errno).
 *
 * On Windows `fs.chmod` doesn't lock a directory the POSIX way, and
 * opening a directory in write mode doesn't produce EISDIR — these tests
 * are platform-bound by design. The adapter's `removeTree` errno
 * propagation behaviour is covered cross-platform in
 * `test/unit/adapters/node/node-file-system-injected.test.ts`.
 *
 * @proves
 *   surface: nodeFs.lockedDir
 *   bucket:  platform-only
 *   unique:  rmRecursive and openWithNoFollow honour POSIX EISDIR and locked-directory semantics
 */
import * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { NodeFileSystem } from '../../../src/adapters/node/node-file-system.js';
import { TsgitError } from '../../../src/domain/index.js';

const makeFs = async (): Promise<{
  fs: NodeFileSystem;
  rootDir: string;
  cleanup: () => Promise<void>;
}> => {
  const tempRoot = await fsPromises.mkdtemp(nodePath.join(os.tmpdir(), 'tsgit-locked-'));
  const rootDir = await fsPromises.realpath(tempRoot);
  const fs = new NodeFileSystem(rootDir);
  return {
    fs,
    rootDir,
    cleanup: async () => fsPromises.rm(rootDir, { recursive: true, force: true }),
  };
};

describe('NodeFileSystem — POSIX-locked filesystem semantics', () => {
  let env: Awaited<ReturnType<typeof makeFs>>;

  beforeEach(async () => {
    env = await makeFs();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it('Given rmRecursive descent into a directory whose lstat surfaces a non-ENOENT error (EACCES via chmod 0o000), When removing, Then the mapped TsgitError propagates as PERMISSION_DENIED', async () => {
    // Arrange — chmod a subdirectory to 000 so its readdir/lstat fails with EACCES.
    // This exercises the `throw err` branch in removeTree's catch (anything
    // other than FILE_NOT_FOUND must propagate; without it errors would be
    // silently swallowed).
    const sut = env.fs;
    const sealed = nodePath.join(env.rootDir, 'sealed');
    await fsPromises.mkdir(sealed);
    await fsPromises.writeFile(nodePath.join(sealed, 'inside.txt'), Buffer.from([1]));
    await fsPromises.chmod(sealed, 0o000);

    // Act
    let caught: unknown;
    try {
      await sut.rmRecursive(sealed);
    } catch (err) {
      caught = err;
    } finally {
      // Restore mode so cleanup can proceed.
      await fsPromises.chmod(sealed, 0o755);
    }

    // Assert — EACCES maps to PERMISSION_DENIED (positive assertion kills
    // StringLiteral mutants that would otherwise survive a `not.toBe(…)` check).
    expect(caught).toBeInstanceOf(TsgitError);
    expect((caught as TsgitError).data.code).toBe('PERMISSION_DENIED');
  });

  it('Given openWithNoFollow on a directory (EISDIR), When opening in write mode, Then propagates as PERMISSION_DENIED', async () => {
    // Arrange — open a directory in write mode triggers EISDIR. The
    // dedicated mapErrno arm surfaces PERMISSION_DENIED on both POSIX
    // and Windows; without it POSIX would see UNSUPPORTED_OPERATION
    // because the Windows-only discriminator rewrap never fires.
    const sut = env.fs;
    const dir = nodePath.join(env.rootDir, 'just-a-dir');
    await fsPromises.mkdir(dir);

    // Act
    let caught: unknown;
    try {
      await sut.openWithNoFollow(dir, 'write');
    } catch (err) {
      caught = err;
    }

    // Assert
    expect(caught).toBeInstanceOf(TsgitError);
    expect((caught as TsgitError).data.code).toBe('PERMISSION_DENIED');
  });
});
