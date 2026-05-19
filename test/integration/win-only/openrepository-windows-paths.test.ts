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
 *
 * Note on `ctx.cwd` expectations: the Node shim calls `realpath()` on
 * the input cwd before threading it through the context (see
 * `src/index.node.ts`), which expands 8.3 short-name parents
 * (`RUNNER~1` → `runneradmin`) and normalises mixed separators. The
 * assertions below check that the call SUCCEEDS (no INVALID_OPTION),
 * not that the resolved `ctx.cwd` equals the raw input.
 */
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { openRepository } from '../../../src/index.node.js';

describe('openRepository — Windows path handling', () => {
  it('Given a drive-letter cwd produced by nodePath.resolve, When openRepository runs, Then it does NOT throw INVALID_OPTION', async () => {
    // Arrange — mkdtemp on Windows returns a `C:\Users\…\tsgit-it-xxxx` path.
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'tsgit-it-'));
    const expectedCwd = await realpath(cwd);
    try {
      // Act
      const sut = await openRepository({ cwd });

      // Assert — Node shim realpaths the cwd, so ctx.cwd is the
      // canonical form (8.3 short names expanded).
      expect(sut.ctx.cwd).toBe(expectedCwd);
      expect(sut.ctx.layout.workDir).toBe(expectedCwd);
      await sut.dispose();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('Given a forward-slash variant of a Windows drive-letter path, When openRepository runs, Then it is also accepted (some tooling normalizes to /)', async () => {
    // Arrange
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'tsgit-it-'));
    const cwd = tmp.replace(/\\/g, '/');
    const expectedCwd = await realpath(cwd);
    try {
      // Act
      const sut = await openRepository({ cwd });

      // Assert — `validateOptions` accepts both backslash and
      // forward-slash drive-letter forms (`C:\…` and `C:/…`); the Node
      // shim realpaths whatever form was passed.
      expect(sut.ctx.cwd).toBe(expectedCwd);
      await sut.dispose();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
