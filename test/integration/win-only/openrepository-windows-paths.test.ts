/**
 * Real-Windows integration test for `openRepository`'s path acceptance.
 * Lives in `test/integration/win-only/` — scheduled by CI only on the
 * Windows runner via the `win-integration` Vitest project. No `skipIf`
 * needed: the folder + matrix cell dictate platform.
 *
 * review pass discovered that the original `isAbsolutePath`
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
 *
 * @proves
 *   surface: openRepository.windowsPaths
 *   bucket:  platform-only
 *   unique:  openRepository accepts drive-letter and UNC paths on a real Windows runner
 */
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { openRepository } from '../../../src/index.node.js';

// Windows drive-letter path forms `validateOptions` accepts: the raw
// mkdtemp path (backslash-separated) and a forward-slash variant some
// tooling produces (`C:/…`); both must resolve to the same realpath'd cwd.
const WINDOWS_PATH_FORM_MATRIX: ReadonlyArray<{
  label: string;
  toCwd: (raw: string) => string;
}> = [
  { label: 'a drive-letter cwd produced by nodePath.resolve', toCwd: (raw) => raw },
  {
    label: 'a forward-slash variant of a Windows drive-letter path',
    toCwd: (raw) => raw.replace(/\\/g, '/'),
  },
];

describe('openRepository — Windows path handling', () => {
  it.each(WINDOWS_PATH_FORM_MATRIX)(
    'Given $label, When openRepository runs, Then it does NOT throw INVALID_OPTION',
    async ({ toCwd }) => {
      // Arrange — mkdtemp on Windows returns a `C:\Users\…\tsgit-it-xxxx` path.
      const tmp = await mkdtemp(path.join(os.tmpdir(), 'tsgit-it-'));
      const cwd = toCwd(tmp);
      const expectedCwd = await realpath(cwd);
      try {
        // Act
        const sut = await openRepository({ cwd });

        // Assert — Node shim realpaths the cwd, so ctx.cwd is the
        // canonical form (8.3 short names expanded); layout.workDir
        // mirrors it regardless of the input path-form literal.
        expect(sut.ctx.cwd).toBe(expectedCwd);
        expect(sut.ctx.layout.workDir).toBe(expectedCwd);
        await sut.dispose();
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
    },
  );
});
