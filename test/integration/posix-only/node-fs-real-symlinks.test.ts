/**
 * POSIX-only integration tests covering real symlink behaviour through
 * `NodeFileSystem`. On Windows, `fs.symlink` requires developer-mode or
 * admin and `O_NOFOLLOW` is silently ignored — both make these
 * assertions impossible to verify on the Windows runner. The adapter's
 * Windows symlink discriminator is covered by mocked DI tests in
 * `test/unit/adapters/node/node-file-system-injected.test.ts`.
 *
 * @proves
 *   surface: nodeFs.symlinks
 *   bucket:  platform-only
 *   unique:  POSIX symlink creation and O_NOFOLLOW semantics through NodeFileSystem
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
  const tempRoot = await fsPromises.mkdtemp(nodePath.join(os.tmpdir(), 'tsgit-symlink-'));
  const rootDir = await fsPromises.realpath(tempRoot);
  const fs = new NodeFileSystem(rootDir);
  return {
    fs,
    rootDir,
    cleanup: async () => fsPromises.rm(rootDir, { recursive: true, force: true }),
  };
};

describe('NodeFileSystem — real symlink behaviour (POSIX)', () => {
  let env: Awaited<ReturnType<typeof makeFs>>;

  beforeEach(async () => {
    env = await makeFs();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it('Given broken in-root symlink leaf, When write, Then throws PERMISSION_DENIED', async () => {
    // Arrange — broken symlink: realpath returns ENOENT for the leaf, parent
    // resolves, then lstat sees the link itself and isSymbolicLink() is true.
    const sut = env.fs;
    const brokenLink = nodePath.join(env.rootDir, 'broken-link');
    await fsPromises.symlink(nodePath.join(env.rootDir, 'missing-target'), brokenLink);

    // Act
    let caught: unknown;
    try {
      await sut.write(brokenLink, new Uint8Array([9]));
    } catch (err) {
      caught = err;
    }

    // Assert
    expect(caught).toBeInstanceOf(TsgitError);
    expect((caught as TsgitError).data.code).toBe('PERMISSION_DENIED');
  });

  it('Given valid symlink, When readlink, Then returns the target path', async () => {
    // Arrange
    const sut = env.fs;
    const target = nodePath.join(env.rootDir, 'target.txt');
    const link = nodePath.join(env.rootDir, 'link.txt');
    await fsPromises.writeFile(target, Buffer.from([1]));
    await fsPromises.symlink(target, link);

    // Act
    const result = await sut.readlink(link);

    // Assert
    expect(result).toBe(target);
  });

  it('Given symlink leaf, When openWithNoFollow(read), Then throws PERMISSION_DENIED (O_NOFOLLOW)', async () => {
    // Arrange — POSIX open with O_NOFOLLOW errors with ELOOP on a symlink leaf;
    // the adapter rewraps that as PERMISSION_DENIED for cross-adapter parity.
    const sut = env.fs;
    const target = nodePath.join(env.rootDir, 'target.txt');
    const link = nodePath.join(env.rootDir, 'follow-link.txt');
    await fsPromises.writeFile(target, Buffer.from([1]));
    await fsPromises.symlink(target, link);

    // Act
    let caught: unknown;
    try {
      await sut.openWithNoFollow(link, 'read');
    } catch (err) {
      caught = err;
    }

    // Assert
    expect(caught).toBeInstanceOf(TsgitError);
    expect((caught as TsgitError).data.code).toBe('PERMISSION_DENIED');
  });

  it('Given directory containing a symlink, When rmRecursive, Then symlink is removed but its target is untouched', async () => {
    // Arrange — without lstat-based descent, fs.rm({recursive,force}) would
    // walk the link. Plant a target file outside the doomed tree and assert
    // it survives.
    const sut = env.fs;
    const doomed = nodePath.join(env.rootDir, 'doomed');
    const survivor = nodePath.join(env.rootDir, 'survivor.txt');
    await fsPromises.mkdir(doomed);
    await fsPromises.writeFile(survivor, Buffer.from([42]));
    const link = nodePath.join(doomed, 'link-to-survivor');
    await fsPromises.symlink(survivor, link);

    // Act
    await sut.rmRecursive(doomed);

    // Assert
    expect(await sut.exists(doomed)).toBe(false);
    expect(await sut.exists(survivor)).toBe(true);
    const survivorBytes = await sut.read(survivor);
    expect(survivorBytes).toEqual(new Uint8Array([42]));
  });
});
