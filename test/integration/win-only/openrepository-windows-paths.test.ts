/**
 * Real-Windows integration test for `openRepository`'s path acceptance.
 * Lives in `test/integration/win-only/` — scheduled by CI only on the
 * Windows runner via the `win-integration` Vitest project. No `skipIf`
 * needed: the folder + matrix cell dictate platform.
 *
 * Phase 10's review pass discovered that the original `isAbsolutePath`
 * rejected Windows drive-letter paths (`C:\…`) because it only accepted
 * POSIX `/`-rooted paths. The fix added drive-letter and UNC support;
 * this test asserts the fix holds on a real Windows runner.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { openRepository } from '../../../src/index.node.js';

describe('openRepository — Windows path handling', () => {
  it('Given a drive-letter cwd produced by nodePath.resolve, When openRepository runs, Then it does NOT throw INVALID_OPTION', async () => {
    // Arrange — mkdtemp on Windows returns a `C:\Users\…\tsgit-it-xxxx` path.
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'tsgit-it-'));
    try {
      // Act
      const sut = await openRepository({ cwd });

      // Assert
      expect(sut.ctx.cwd).toBe(cwd);
      expect(sut.ctx.layout.workDir).toBe(cwd);
      await sut.dispose();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('Given a forward-slash variant of a Windows drive-letter path, When openRepository runs, Then it is also accepted (some tooling normalizes to /)', async () => {
    // Arrange
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'tsgit-it-'));
    const cwd = tmp.replace(/\\/g, '/');
    try {
      // Act
      const sut = await openRepository({ cwd });

      // Assert — the validateOptions check accepts both backslash and
      // forward-slash drive-letter forms (`C:\…` and `C:/…`).
      expect(sut.ctx.cwd).toBe(cwd);
      await sut.dispose();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
