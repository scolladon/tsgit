/**
 * POSIX-only integration smoke test for `NodeHookRunner`. It spawns real child
 * processes from `#!/bin/sh` hook scripts to prove the real `child_process`
 * integration behaves as the unit test's fake assumes — exhaustive branch
 * coverage lives in `test/unit/adapters/node/node-hook-runner.test.ts`.
 *
 * Shell-script hooks are POSIX-bound (Windows needs a shell on PATH — ADR-068),
 * so this lives in `posix-only/` rather than the unit suite.
 */
import * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { NodeHookRunner } from '../../../src/adapters/node/node-hook-runner.js';
import type { HookName } from '../../../src/domain/hooks/index.js';
import type { HookRequest, HookResult } from '../../../src/ports/hook-runner.js';

const ran = (result: HookResult): Extract<HookResult, { kind: 'ran' }> => {
  if (result.kind !== 'ran') throw new Error(`expected a ran result, got ${result.kind}`);
  return result;
};

describe('NodeHookRunner (POSIX real-process smoke)', () => {
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
    const result = await new NodeHookRunner().run(request('pre-commit'));

    expect(result).toEqual({ kind: 'skipped' });
  });

  it('Given a hook file with no executable bit, When run, Then it resolves skipped', async () => {
    await writeHook('pre-commit', '#!/bin/sh\nexit 0\n', { exec: false });

    const result = await new NodeHookRunner().run(request('pre-commit'));

    expect(result).toEqual({ kind: 'skipped' });
  });

  it('Given an executable hook that exits 0, When run, Then it resolves ran with exit code 0', async () => {
    await writeHook('pre-commit', '#!/bin/sh\nexit 0\n');

    const result = await new NodeHookRunner().run(request('pre-commit'));

    expect(result).toMatchObject({ kind: 'ran', exitCode: 0 });
  });

  it('Given a hook that exits non-zero and writes stderr, When run, Then the exit code and stderr are captured', async () => {
    await writeHook('pre-commit', '#!/bin/sh\necho oops >&2\nexit 3\n');

    const result = ran(await new NodeHookRunner().run(request('pre-commit')));

    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain('oops');
  });

  it('Given a stdin payload, When run, Then the hook receives it on stdin', async () => {
    // `cat` echoes stdin straight back to stdout.
    await writeHook('pre-push', '#!/bin/sh\ncat\n');

    const result = ran(
      await new NodeHookRunner().run(request('pre-push', { stdin: 'refs-line\n' })),
    );

    expect(result.stdout).toBe('refs-line\n');
  });

  it('Given positional args, When run, Then the hook receives them in order', async () => {
    await writeHook('commit-msg', '#!/bin/sh\nfor a in "$@"; do echo "$a"; done\n');

    const result = ran(
      await new NodeHookRunner().run(request('commit-msg', { args: ['one', 'two'] })),
    );

    expect(result.stdout).toBe('one\ntwo\n');
  });

  it('Given a hook, When run, Then GIT_DIR and GIT_INDEX_FILE are set and cwd is the working tree', async () => {
    await writeHook(
      'pre-commit',
      '#!/bin/sh\necho "$GIT_DIR"\necho "$GIT_INDEX_FILE"\ntouch cwd-marker\n',
    );

    const result = ran(await new NodeHookRunner().run(request('pre-commit')));

    expect(result.stdout).toBe(`${gitDir}\n${gitDir}/index\n`);
    await expect(fsPromises.stat(nodePath.join(workDir, 'cwd-marker'))).resolves.toBeDefined();
  });
});
