/**
 * Real-Windows unit tests for `NodeFileSystem`. Skipped on non-Windows
 * hosts via `describe.skipIf`. These live under `test/unit/` (not
 * `test/integration/`) so they are scheduled on the `unit-tests` matrix
 * cell that includes `windows-latest` — the integration job is
 * Linux-only by ADR-044. Phase 14.4.
 */
import * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { describe, expect, it } from 'vitest';

import { NodeFileSystem } from '../../../../src/adapters/node/node-file-system.js';
import { TsgitError } from '../../../../src/domain/index.js';

const isWindowsHost = process.platform === 'win32';

/**
 * Probes whether the runner can create symlinks. `fs.symlink` requires
 * developer-mode or admin on Windows; GitHub Actions' `windows-latest`
 * image has developer-mode enabled but we don't bet the suite on it.
 */
const canCreateSymlinks = async (): Promise<boolean> => {
  if (!isWindowsHost) return false;
  const probeRoot = await fsPromises.mkdtemp(nodePath.join(os.tmpdir(), 'tsgit-symprobe-'));
  try {
    const target = nodePath.join(probeRoot, 'target.bin');
    const link = nodePath.join(probeRoot, 'link.bin');
    await fsPromises.writeFile(target, Buffer.from([1]));
    try {
      await fsPromises.symlink(target, link);
      return true;
    } catch {
      return false;
    }
  } finally {
    await fsPromises.rm(probeRoot, { recursive: true, force: true });
  }
};

describe.skipIf(!isWindowsHost)('NodeFileSystem — Windows real-runner', () => {
  it('Given a fresh mkdtemp working tree, When write/read round-trips, Then the canonical-root reconciliation succeeds (8.3 short-name parent)', async () => {
    // Arrange — the GHA Windows runner's TEMP path goes through `RUNNER~1`
    // which is an 8.3 short-name alias of `runneradmin`. mkdtemp gives us a
    // path under that parent naturally.
    const rootDir = await fsPromises.mkdtemp(nodePath.join(os.tmpdir(), 'tsgit-win-'));
    const sut = new NodeFileSystem(rootDir);
    const filePath = nodePath.join(rootDir, 'a.bin');
    const data = new Uint8Array([1, 2, 3, 4, 5]);

    try {
      // Act
      await sut.write(filePath, data);
      const result = await sut.read(filePath);

      // Assert
      expect(result).toEqual(data);
    } finally {
      await fsPromises.rm(rootDir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!isWindowsHost)('NodeFileSystem — Windows symlink refusal', () => {
  it('Given a symlink leaf inside the working tree, When openWithNoFollow is called, Then PERMISSION_DENIED is thrown', async ({
    skip,
  }) => {
    const symlinksAvailable = await canCreateSymlinks();
    if (!symlinksAvailable) {
      // Developer mode not enabled on the runner image — Vitest's `skip` call
      // shows the test as skipped (not silently green) so CI output is honest.
      skip();
      return;
    }

    // Arrange
    const rootDir = await fsPromises.mkdtemp(nodePath.join(os.tmpdir(), 'tsgit-winlink-'));
    const target = nodePath.join(rootDir, 'target.bin');
    const link = nodePath.join(rootDir, 'link.bin');
    await fsPromises.writeFile(target, Buffer.from([1]));
    await fsPromises.symlink(target, link);

    const sut = new NodeFileSystem(rootDir);

    try {
      // Act + Assert
      let caught: unknown;
      try {
        const handle = await sut.openWithNoFollow(link, 'read');
        await handle.close();
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(TsgitError);
      expect((caught as InstanceType<typeof TsgitError>).data.code).toBe('PERMISSION_DENIED');
    } finally {
      await fsPromises.rm(rootDir, { recursive: true, force: true });
    }
  });
});
