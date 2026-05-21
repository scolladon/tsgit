/**
 * POSIX-only integration test for `NodeHookRunner`. It spawns real child
 * processes from `#!/bin/sh` hook scripts written into a temp directory, so it
 * is platform-bound (Windows needs a shell on PATH — ADR-068) and lives in
 * `posix-only/` rather than the unit suite.
 */
import * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { NodeHookRunner } from '../../../src/adapters/node/node-hook-runner.js';
import type { HookName } from '../../../src/domain/hooks/index.js';
import type { HookRequest, HookResult } from '../../../src/ports/hook-runner.js';

const OUTPUT_CAP_BYTES = 1024 * 1024;

const ran = (result: HookResult): Extract<HookResult, { kind: 'ran' }> => {
  if (result.kind !== 'ran') throw new Error(`expected a ran result, got ${result.kind}`);
  return result;
};

describe('NodeHookRunner (POSIX hook execution)', () => {
  let root: string;
  let hooksDir: string;
  let workDir: string;
  let gitDir: string;

  beforeEach(async () => {
    root = await fsPromises.realpath(
      await fsPromises.mkdtemp(nodePath.join(os.tmpdir(), 'tsgit-hook-')),
    );
    hooksDir = nodePath.join(root, 'hooks');
    workDir = nodePath.join(root, 'work');
    gitDir = nodePath.join(workDir, '.git');
    await fsPromises.mkdir(hooksDir);
    await fsPromises.mkdir(workDir);
    await fsPromises.mkdir(gitDir);
  });

  afterEach(async () => {
    await fsPromises.rm(root, { recursive: true, force: true });
  });

  const writeHook = async (
    name: HookName,
    body: string,
    options: { readonly exec?: boolean } = {},
  ): Promise<void> => {
    const path = nodePath.join(hooksDir, name);
    await fsPromises.writeFile(path, body);
    if (options.exec !== false) await fsPromises.chmod(path, 0o755);
  };

  const request = (name: HookName, over: Partial<HookRequest> = {}): HookRequest => ({
    name,
    hooksDir,
    workDir,
    gitDir,
    args: [],
    stdin: '',
    ...over,
  });

  it('Given no hook file, When run, Then it resolves skipped', async () => {
    // Arrange
    const sut = new NodeHookRunner();

    // Act
    const result = await sut.run(request('pre-commit'));

    // Assert
    expect(result).toEqual({ kind: 'skipped' });
  });

  it('Given a hook file with no executable bit, When run on POSIX, Then it resolves skipped', async () => {
    // Arrange
    await writeHook('pre-commit', '#!/bin/sh\nexit 0\n', { exec: false });
    const sut = new NodeHookRunner('linux');

    // Act
    const result = await sut.run(request('pre-commit'));

    // Assert
    expect(result).toEqual({ kind: 'skipped' });
  });

  it('Given a directory where the hook file is expected, When run, Then it resolves skipped', async () => {
    // Arrange
    await fsPromises.mkdir(nodePath.join(hooksDir, 'pre-commit'));
    const sut = new NodeHookRunner();

    // Act
    const result = await sut.run(request('pre-commit'));

    // Assert
    expect(result).toEqual({ kind: 'skipped' });
  });

  it('Given an executable hook that exits 0, When run, Then it resolves ran with exit code 0', async () => {
    // Arrange
    await writeHook('pre-commit', '#!/bin/sh\nexit 0\n');
    const sut = new NodeHookRunner();

    // Act
    const result = await sut.run(request('pre-commit'));

    // Assert
    expect(result).toMatchObject({ kind: 'ran', exitCode: 0 });
  });

  it('Given a hook that exits non-zero and writes stderr, When run, Then the exit code and stderr are captured', async () => {
    // Arrange
    await writeHook('pre-commit', '#!/bin/sh\necho oops >&2\nexit 3\n');
    const sut = new NodeHookRunner();

    // Act
    const result = ran(await sut.run(request('pre-commit')));

    // Assert
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain('oops');
  });

  it('Given a stdin payload, When run, Then the hook receives it on stdin', async () => {
    // Arrange — `cat` echoes stdin straight back to stdout.
    await writeHook('pre-push', '#!/bin/sh\ncat\n');
    const sut = new NodeHookRunner();

    // Act
    const result = ran(await sut.run(request('pre-push', { stdin: 'refs-line\n' })));

    // Assert
    expect(result.stdout).toBe('refs-line\n');
  });

  it('Given positional args, When run, Then the hook receives them in order', async () => {
    // Arrange
    await writeHook('commit-msg', '#!/bin/sh\nfor a in "$@"; do echo "$a"; done\n');
    const sut = new NodeHookRunner();

    // Act
    const result = ran(await sut.run(request('commit-msg', { args: ['one', 'two'] })));

    // Assert
    expect(result.stdout).toBe('one\ntwo\n');
  });

  it('Given a hook, When run, Then GIT_DIR is in its environment and cwd is the working tree', async () => {
    // Arrange — print GIT_DIR; `touch` lands in the process cwd.
    await writeHook('pre-commit', '#!/bin/sh\nprintf %s "$GIT_DIR"\ntouch cwd-marker\n');
    const sut = new NodeHookRunner();

    // Act
    const result = ran(await sut.run(request('pre-commit')));

    // Assert
    expect(result.stdout).toBe(gitDir);
    await expect(fsPromises.stat(nodePath.join(workDir, 'cwd-marker'))).resolves.toBeDefined();
  });

  it('Given a hook emitting more than the output cap, When run, Then captured stdout is bounded', async () => {
    // Arrange — emit 2 MiB; the per-stream cap is 1 MiB.
    await writeHook('pre-commit', '#!/bin/sh\nyes x | head -c 2097152\n');
    const sut = new NodeHookRunner();

    // Act
    const result = ran(await sut.run(request('pre-commit')));

    // Assert
    expect(result.stdout.length).toBe(OUTPUT_CAP_BYTES);
  });

  it('Given a long-running hook and a signal already aborted, When run, Then the child is killed (exit 128)', async () => {
    // Arrange
    await writeHook('pre-commit', '#!/bin/sh\nsleep 30\n');
    const controller = new AbortController();
    controller.abort();
    const sut = new NodeHookRunner();

    // Act
    const result = ran(await sut.run(request('pre-commit', { signal: controller.signal })));

    // Assert
    expect(result.exitCode).toBe(128);
  });

  it('Given a running hook and a signal aborted mid-run, When the signal fires, Then the child is killed', async () => {
    // Arrange
    await writeHook('pre-commit', '#!/bin/sh\nsleep 30\n');
    const controller = new AbortController();
    const sut = new NodeHookRunner();

    // Act
    const pending = sut.run(request('pre-commit', { signal: controller.signal }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();
    const result = ran(await pending);

    // Assert
    expect(result.exitCode).toBe(128);
  });

  it('Given a non-executable hook, When run on the Windows platform, Then it is not skipped (the exec bit is ignored)', async () => {
    // Arrange — same file, two platforms (ADR-068).
    await writeHook('pre-commit', '#!/bin/sh\nexit 0\n', { exec: false });

    // Act
    const windows = await new NodeHookRunner('win32').run(request('pre-commit'));
    const posix = await new NodeHookRunner('linux').run(request('pre-commit'));

    // Assert — Windows ignores the exec bit, so the spawn is attempted (and on a
    // POSIX host fails to exec → exit 126); POSIX skips outright.
    expect(windows).toMatchObject({ kind: 'ran', exitCode: 126 });
    expect(posix).toEqual({ kind: 'skipped' });
  });

  it('Given a hook that exits without draining a large stdin, When run, Then it still resolves', async () => {
    // Arrange — 2 MiB stdin to a hook that never reads it (EPIPE territory).
    await writeHook('pre-commit', '#!/bin/sh\nexit 0\n');
    const sut = new NodeHookRunner();

    // Act
    const result = await sut.run(request('pre-commit', { stdin: 'x'.repeat(2_097_152) }));

    // Assert
    expect(result).toMatchObject({ kind: 'ran', exitCode: 0 });
  });
});
