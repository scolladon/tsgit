import { EventEmitter } from 'node:events';
import * as nodePath from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  type HookRunnerOps,
  NodeHookRunner,
} from '../../../../src/adapters/node/node-hook-runner.js';
import type { HookName } from '../../../../src/domain/hooks/index.js';
import type { HookRequest, HookResult } from '../../../../src/ports/hook-runner.js';

/**
 * Controllable fake child process. Structurally satisfies the `HookChild`
 * surface `NodeHookRunner` consumes; the test drives its events directly.
 */
class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  stdinData: string | undefined;
  killed = false;
  readonly stdin = Object.assign(new EventEmitter(), {
    end: (data: string): void => {
      this.stdinData = data;
    },
  });

  kill(): void {
    this.killed = true;
  }
}

interface SpawnCall {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

const ran = (result: HookResult): Extract<HookResult, { kind: 'ran' }> => {
  if (result.kind !== 'ran') throw new Error(`expected a ran result, got ${result.kind}`);
  return result;
};

const baseRequest = (name: HookName, over: Partial<HookRequest> = {}): HookRequest => ({
  name,
  hooksDir: '/repo/.git/hooks',
  workDir: '/repo',
  gitDir: '/repo/.git',
  args: [],
  stdin: '',
  ...over,
});

const makeHarness = (
  opts: { readonly platform?: NodeJS.Platform; readonly stat?: HookRunnerOps['stat'] } = {},
): { runner: NodeHookRunner; child: FakeChild; calls: SpawnCall[] } => {
  const child = new FakeChild();
  const calls: SpawnCall[] = [];
  const ops: HookRunnerOps = {
    stat: opts.stat ?? (() => Promise.resolve({ mode: 0o755, isFile: () => true })),
    spawn: (command, args, options) => {
      calls.push({ command, args, cwd: options.cwd, env: options.env });
      return child;
    },
  };
  return { runner: new NodeHookRunner(opts.platform ?? 'linux', ops), child, calls };
};

/**
 * Invoke `run`, wait for `isRunnable` + the spawn executor to register the
 * child listeners, then let `interact` drive the fake child's events.
 */
const runWithChild = async (
  runner: NodeHookRunner,
  child: FakeChild,
  request: HookRequest,
  interact: (child: FakeChild) => void,
): Promise<HookResult> => {
  const pending = runner.run(request);
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
  interact(child);
  return pending;
};

describe('adapters/node NodeHookRunner — isRunnable', () => {
  it('Given stat rejects (no such file), When run, Then it resolves skipped', async () => {
    // Arrange
    const { runner } = makeHarness({ stat: () => Promise.reject(new Error('ENOENT')) });

    // Act & Assert
    // Assert
    expect(await runner.run(baseRequest('pre-commit'))).toEqual({ kind: 'skipped' });
  });

  it('Given the path is not a regular file, When run, Then it resolves skipped', async () => {
    // Arrange
    const { runner } = makeHarness({
      stat: () => Promise.resolve({ mode: 0o755, isFile: () => false }),
    });

    // Act & Assert
    // Assert
    expect(await runner.run(baseRequest('pre-commit'))).toEqual({ kind: 'skipped' });
  });

  it('Given a regular file with no executable bit on POSIX, When run, Then it resolves skipped', async () => {
    // Arrange
    const { runner } = makeHarness({
      platform: 'linux',
      stat: () => Promise.resolve({ mode: 0o644, isFile: () => true }),
    });

    // Act & Assert
    // Assert
    expect(await runner.run(baseRequest('pre-commit'))).toEqual({ kind: 'skipped' });
  });

  it('Given a regular file with no executable bit on Windows, When run, Then the hook is spawned', async () => {
    // Arrange — Windows has no executable bit (ADR-068).
    const { runner, child, calls } = makeHarness({
      platform: 'win32',
      stat: () => Promise.resolve({ mode: 0o644, isFile: () => true }),
    });

    // Act
    const result = await runWithChild(runner, child, baseRequest('pre-commit'), (c) => {
      c.emit('close', 0);
    });

    // Assert
    expect(calls).toHaveLength(1);
    expect(ran(result).exitCode).toBe(0);
  });
});

describe('adapters/node NodeHookRunner — spawn wiring', () => {
  it('Given an executable hook, When run, Then spawn receives the path, args, cwd and git env', async () => {
    // Arrange
    const { runner, child, calls } = makeHarness();

    // Act
    await runWithChild(
      runner,
      child,
      baseRequest('pre-push', { args: ['origin', 'url'], stdin: 'payload' }),
      (c) => {
        c.emit('close', 0);
      },
    );

    // Assert
    // `run` joins hooksDir + name with `nodePath.join`, so the separator is
    // platform-native — compute the expectation the same way.
    expect(calls[0]?.command).toBe(nodePath.join('/repo/.git/hooks', 'pre-push'));
    expect(calls[0]?.args).toEqual(['origin', 'url']);
    expect(calls[0]?.cwd).toBe('/repo');
    expect(calls[0]?.env['GIT_DIR']).toBe('/repo/.git');
    expect(calls[0]?.env['GIT_INDEX_FILE']).toBe('/repo/.git/index');
    expect(child.stdinData).toBe('payload');
  });

  it('Given a hook that exits 0 with output, When run, Then stdout and stderr are captured', async () => {
    // Arrange
    const { runner, child } = makeHarness();

    // Act
    const result = ran(
      await runWithChild(runner, child, baseRequest('pre-commit'), (c) => {
        c.stdout.emit('data', Buffer.from('out-text'));
        c.stderr.emit('data', Buffer.from('err-text'));
        c.emit('close', 0);
      }),
    );

    // Assert
    expect(result).toEqual({ kind: 'ran', exitCode: 0, stdout: 'out-text', stderr: 'err-text' });
  });

  it('Given a hook that exits non-zero, When run, Then the exit code is reported', async () => {
    // Arrange
    const { runner, child } = makeHarness();

    // Act
    const result = ran(
      await runWithChild(runner, child, baseRequest('pre-commit'), (c) => {
        c.emit('close', 7);
      }),
    );

    // Assert
    expect(result.exitCode).toBe(7);
  });

  it('Given the child closes with a null code (signal-killed), When run, Then exit code 128 is reported', async () => {
    // Arrange
    const { runner, child } = makeHarness();

    // Act
    const result = ran(
      await runWithChild(runner, child, baseRequest('pre-commit'), (c) => {
        c.emit('close', null);
      }),
    );

    // Assert
    expect(result.exitCode).toBe(128);
  });

  it('Given the spawn emits an error, When run, Then exit code 126 with the error text is reported', async () => {
    // Arrange
    const { runner, child } = makeHarness();

    // Act
    const result = ran(
      await runWithChild(runner, child, baseRequest('pre-commit'), (c) => {
        c.emit('error', new Error('spawn ENOENT'));
      }),
    );

    // Assert
    expect(result.exitCode).toBe(126);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('spawn ENOENT');
  });

  it('Given both error and close fire, When error fires first, Then the error result wins', async () => {
    // Arrange
    const { runner, child } = makeHarness();

    // Act
    const result = ran(
      await runWithChild(runner, child, baseRequest('pre-commit'), (c) => {
        c.emit('error', new Error('boom'));
        c.emit('close', 0);
      }),
    );

    // Assert — resolve() is idempotent, so the first (error) result wins.
    expect(result.exitCode).toBe(126);
  });

  it('Given both close and error fire, When close fires first, Then the close result wins', async () => {
    // Arrange
    const { runner, child } = makeHarness();

    // Act
    const result = ran(
      await runWithChild(runner, child, baseRequest('pre-commit'), (c) => {
        c.emit('close', 4);
        c.emit('error', new Error('boom'));
      }),
    );

    // Assert
    expect(result.exitCode).toBe(4);
  });

  it('Given a hook that emits more than the output cap, When run, Then captured stdout is bounded', async () => {
    // Arrange
    const { runner, child } = makeHarness();

    // Act — three chunks: under cap, crossing the cap, then past it.
    const result = ran(
      await runWithChild(runner, child, baseRequest('pre-commit'), (c) => {
        c.stdout.emit('data', Buffer.alloc(700_000, 0x78));
        c.stdout.emit('data', Buffer.alloc(700_000, 0x79));
        c.stdout.emit('data', Buffer.alloc(50_000, 0x7a));
        c.emit('close', 0);
      }),
    );

    // Assert — capped at exactly 1 MiB.
    expect(result.stdout.length).toBe(1024 * 1024);
  });

  it('Given a hook that errors on stdin (EPIPE), When run, Then it still resolves', async () => {
    // Arrange
    const { runner, child } = makeHarness();

    // Act — the hook closes stdin early; the stdin error must be swallowed.
    const result = await runWithChild(runner, child, baseRequest('pre-commit'), (c) => {
      c.stdin.emit('error', new Error('EPIPE'));
      c.emit('close', 0);
    });

    // Assert
    expect(ran(result).exitCode).toBe(0);
  });
});

describe('adapters/node NodeHookRunner — abort handling', () => {
  it('Given a signal already aborted, When run, Then the child is killed', async () => {
    // Arrange
    const controller = new AbortController();
    controller.abort();
    const { runner, child } = makeHarness();

    // Act
    await runWithChild(
      runner,
      child,
      baseRequest('pre-commit', { signal: controller.signal }),
      (c) => {
        c.emit('close', null);
      },
    );

    // Assert
    expect(child.killed).toBe(true);
  });

  it('Given a signal that aborts mid-run, When the signal fires, Then the child is killed', async () => {
    // Arrange
    const controller = new AbortController();
    const { runner, child } = makeHarness();

    // Act
    await runWithChild(
      runner,
      child,
      baseRequest('pre-commit', { signal: controller.signal }),
      (c) => {
        controller.abort();
        c.emit('close', null);
      },
    );

    // Assert
    expect(child.killed).toBe(true);
  });

  it('Given no signal, When run, Then the child is not killed', async () => {
    // Arrange
    const { runner, child } = makeHarness();

    // Act
    await runWithChild(runner, child, baseRequest('pre-commit'), (c) => {
      c.emit('close', 0);
    });

    // Assert
    expect(child.killed).toBe(false);
  });

  it('Given a signal, When the hook completes before any abort, Then a later abort does not kill the child', async () => {
    // Arrange
    const controller = new AbortController();
    const { runner, child } = makeHarness();

    // Act — the hook finishes, then the signal aborts afterwards.
    await runWithChild(
      runner,
      child,
      baseRequest('pre-commit', { signal: controller.signal }),
      (c) => {
        c.emit('close', 0);
      },
    );
    controller.abort();

    // Assert — `finish` removed the abort listener, so the late abort is inert.
    expect(child.killed).toBe(false);
  });
});
