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
 * Phase 14.4.
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

  it('Given rmRecursive descent into a directory whose lstat surfaces a non-ENOENT error (EACCES via chmod 0o000), When removing, Then the mapped TsgitError propagates', async () => {
    // Arrange — chmod a subdirectory to 000 so its readdir/lstat fails with EACCES.
    // This exercises the `throw err` branch in removeTree's catch (anything
    // other than FILE_NOT_FOUND must propagate; without it errors would be
    // silently swallowed).
    const sealed = nodePath.join(env.rootDir, 'sealed');
    await fsPromises.mkdir(sealed);
    await fsPromises.writeFile(nodePath.join(sealed, 'inside.txt'), Buffer.from([1]));
    await fsPromises.chmod(sealed, 0o000);

    // Act
    let caught: unknown;
    try {
      await env.fs.rmRecursive(sealed);
    } catch (err) {
      caught = err;
    } finally {
      // Restore mode so cleanup can proceed.
      await fsPromises.chmod(sealed, 0o755);
    }

    // Assert — must surface a TsgitError (not silently succeed and not a raw errno).
    expect(caught).toBeInstanceOf(TsgitError);
    expect((caught as TsgitError).data.code).not.toBe('FILE_NOT_FOUND');
  });

  it('Given openWithNoFollow with non-ELOOP errno (EISDIR), When opening, Then propagates the mapped TsgitError unchanged', async () => {
    // Arrange — open a directory in write mode triggers EISDIR which is NOT
    // remapped to PERMISSION_DENIED; this exercises the catch-block
    // re-throw branch.
    const dir = nodePath.join(env.rootDir, 'just-a-dir');
    await fsPromises.mkdir(dir);

    // Act
    let caught: unknown;
    try {
      await env.fs.openWithNoFollow(dir, 'write');
    } catch (err) {
      caught = err;
    }

    // Assert — EISDIR maps to UNSUPPORTED_OPERATION (per mapErrno default arm).
    expect(caught).toBeInstanceOf(TsgitError);
    expect((caught as TsgitError).data.code).not.toBe('PERMISSION_DENIED');
  });
});
