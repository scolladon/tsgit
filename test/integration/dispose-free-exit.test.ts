/**
 * A4/B8 regression — the pack registry's persistent per-pack `FileHandle`
 * (A4) must not regress the pre-existing "exit without dispose()" invariant:
 * idle Node `fs.FileHandle`s do not ref the libuv event loop, only pending
 * requests/sockets/watchers/un-`unref`'d timers do. A child process that
 * opens a repo, runs one diff against a real packed repository, and returns
 * without calling `dispose()` must still exit on its own. A second scenario
 * proves an explicit `dispose()` actually closes the persistent handle
 * (`process._getActiveHandles()` is empty afterwards), not merely that the
 * process happens to be able to exit anyway.
 *
 * Runs against the BUILT `dist/esm/index.node.js`, not `src/`: a plain
 * `node` child process cannot resolve this source tree's
 * `.js`-specifier-for-`.ts`-file imports (mirrors `tooling/profile.ts`).
 *
 * @proves
 *   surface:        pack-registry
 *   bucket:         cross-tool-interop
 *   unique:         dispose-free-exit — persistent per-pack handles never keep the event loop alive; explicit dispose() closes them
 */
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GIT_AVAILABLE, runGitAsync, runGitEnv } from './interop-helpers.js';

const execFileAsync = promisify(execFile);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DIST_ENTRY = path.join(ROOT, 'dist', 'esm', 'index.node.js');
const EXIT_TIMEOUT_MS = 5000;
const BUILD_TIMEOUT_MS = 120_000;

const IDENTITY = {
  GIT_AUTHOR_NAME: 'Ada',
  GIT_AUTHOR_EMAIL: 'ada@example.com',
  GIT_COMMITTER_NAME: 'Ada',
  GIT_COMMITTER_EMAIL: 'ada@example.com',
  GIT_AUTHOR_DATE: '1700010000 +0000',
  GIT_COMMITTER_DATE: '1700010000 +0000',
} as const;

/**
 * Child-process script body: open the repo, run one diff against packed
 * commits, and — depending on `mode` — either return without disposing (the
 * B8 regression subject) or dispose explicitly and report the DELTA in
 * active-handle count from before the repo was ever touched (the A4
 * leak-on-dispose check, via the undocumented but standard
 * `process._getActiveHandles()` introspection API). A delta, not the raw
 * count, is required: `execFile` wires the child's stdio through pipes, and
 * the stderr pipe itself is a permanently-active handle unrelated to the
 * repository — comparing against the pre-repo baseline cancels it out.
 */
const childScript = (distEntryHref: string): string => `
import { openRepository } from '${distEntryHref}';

// Touch stdout before the baseline measurement: Node lazily creates its
// underlying pipe handle on first access, and the reporting write below is
// otherwise the first access — which would misattribute that handle to the
// repo/dispose lifecycle instead of to process startup.
process.stdout;

const activeHandleCount = () =>
  (typeof process._getActiveHandles === 'function' ? process._getActiveHandles() : []).length;

const repoPath = process.argv[2];
const mode = process.argv[3];
const baseline = activeHandleCount();

const repo = await openRepository({ cwd: repoPath });
await repo.diff({ from: 'HEAD~1', to: 'HEAD' });

if (mode === 'dispose') {
  await repo.dispose();
  process.stdout.write(\`ACTIVE_HANDLES_DELTA=\${activeHandleCount() - baseline}\\n\`);
}
process.stdout.write('DONE\\n');
`;

let repoDir = '';
let scriptDir = '';
let scriptPath = '';

describe.skipIf(!GIT_AVAILABLE)('dispose-free exit (A4/B8)', () => {
  beforeAll(async () => {
    // Build the shipped Node entry point once — a plain `node` child process
    // cannot resolve `src/`'s `.js`-specifier-for-`.ts`-file imports.
    await execFileAsync('npm', ['run', 'build'], { cwd: ROOT, timeout: BUILD_TIMEOUT_MS });

    repoDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-dispose-free-'));
    await runGitAsync(['init', '-q', '-b', 'main', repoDir]);
    await runGitAsync(['-C', repoDir, 'config', 'user.name', 'Ada']);
    await runGitAsync(['-C', repoDir, 'config', 'user.email', 'ada@example.com']);
    await writeFile(path.join(repoDir, 'a.txt'), 'one\n');
    await runGitAsync(['-C', repoDir, 'add', 'a.txt']);
    await runGitAsync(['-C', repoDir, 'commit', '-q', '-m', 'first'], {
      env: { ...runGitEnv(), ...IDENTITY },
    });
    await writeFile(path.join(repoDir, 'a.txt'), 'two\n');
    await runGitAsync(['-C', repoDir, 'add', 'a.txt']);
    await runGitAsync(['-C', repoDir, 'commit', '-q', '-m', 'second'], {
      env: { ...runGitEnv(), ...IDENTITY },
    });
    // Force every object into a pack so the child's diff exercises the
    // persistent per-pack FileHandle path (A4), not a loose-object read.
    await runGitAsync(['-C', repoDir, 'gc', '--quiet']);

    scriptDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-dispose-free-script-'));
    scriptPath = path.join(scriptDir, 'child.mjs');
    await writeFile(scriptPath, childScript(pathToFileURL(DIST_ENTRY).href));
  }, BUILD_TIMEOUT_MS);

  afterAll(async () => {
    await rm(repoDir, { recursive: true, force: true });
    await rm(scriptDir, { recursive: true, force: true });
  }, 600_000);

  describe('Given a repo whose objects are packed', () => {
    describe('When a child process opens it, runs one diff, and returns without dispose()', () => {
      it('Then the process exits within the timeout', async () => {
        // Arrange
        const start = Date.now();

        // Act
        let stdout: string;
        try {
          ({ stdout } = await execFileAsync(process.execPath, [scriptPath, repoDir, 'nodispose'], {
            timeout: EXIT_TIMEOUT_MS,
          }));
        } catch (err) {
          throw new Error(
            `child process did not exit within ${EXIT_TIMEOUT_MS}ms without dispose(): ${String(err)}`,
          );
        }
        const elapsed = Date.now() - start;

        // Assert
        expect(stdout).toContain('DONE');
        expect(elapsed).toBeLessThan(EXIT_TIMEOUT_MS);
      });
    });

    describe('When a child process opens it, runs one diff, and calls dispose() explicitly', () => {
      it('Then no active handles remain after dispose (no fd leak)', async () => {
        // Arrange + Act
        const { stdout } = await execFileAsync(process.execPath, [scriptPath, repoDir, 'dispose'], {
          timeout: EXIT_TIMEOUT_MS,
        });

        // Assert
        expect(stdout).toContain('ACTIVE_HANDLES_DELTA=0');
        expect(stdout).toContain('DONE');
      });
    });
  });
});
