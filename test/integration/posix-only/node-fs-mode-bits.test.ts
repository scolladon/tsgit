/**
 * POSIX-only integration test for `NodeFileSystem.chmod` mode-bit semantics.
 *
 * Asserts that `chmod(0o600)` actually changes the file's mode-bit
 * representation reported by `stat`. NTFS doesn't have POSIX mode bits
 * (Windows `fs.chmod` only honours the read-only bit) so this is
 * fundamentally platform-bound — it lives in `posix-only/` rather than
 * being a `skipIf` in the unit suite.
 *
 * @proves
 *   surface: nodeFs.chmod
 *   bucket:  platform-only
 *   unique:  chmod(0o600) actually changes POSIX mode bits as reported by stat
 */
import * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { describe, expect, it } from 'vitest';

import { NodeFileSystem } from '../../../src/adapters/node/node-file-system.js';

describe('NodeFileSystem.chmod (POSIX mode bits)', () => {
  it('Given chmod on a valid contained file, When called, Then the file mode is updated', async () => {
    // Arrange
    const tempRoot = await fsPromises.mkdtemp(nodePath.join(os.tmpdir(), 'tsgit-chmod-'));
    const rootDir = await fsPromises.realpath(tempRoot);
    const sut = new NodeFileSystem(rootDir);
    const path = nodePath.join(rootDir, 'perm.bin');
    await fsPromises.writeFile(path, Buffer.from([1]));

    try {
      // Act
      await sut.chmod(path, 0o600);

      // Assert
      const stat = await fsPromises.stat(path);
      expect(stat.mode & 0o777).toBe(0o600);
    } finally {
      await fsPromises.rm(rootDir, { recursive: true, force: true });
    }
  });
});
