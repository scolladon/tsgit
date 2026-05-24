import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { MemoryHookRunner } from '../../../../src/adapters/memory/memory-hook-runner.js';
import { __resetConfigCacheForTests } from '../../../../src/application/primitives/config-read.js';
import { resolveHooksDir, runHook } from '../../../../src/application/primitives/run-hook.js';
import { TsgitError } from '../../../../src/domain/error.js';
import type { RepositoryLayout } from '../../../../src/ports/context.js';

const layout = (over: Partial<RepositoryLayout> = {}): RepositoryLayout => ({
  workDir: '/repo',
  gitDir: '/repo/.git',
  bare: false,
  ...over,
});

describe('primitives/run-hook resolveHooksDir', () => {
  it('Given no hooksPath, When resolveHooksDir, Then it defaults to <gitDir>/hooks', () => {
    // Arrange
    const sut = resolveHooksDir(undefined, layout());

    // Assert
    expect(sut).toBe('/repo/.git/hooks');
  });

  it('Given an absolute POSIX hooksPath, When resolveHooksDir, Then it is used verbatim', () => {
    // Arrange
    const sut = resolveHooksDir('/opt/githooks', layout());

    // Assert
    expect(sut).toBe('/opt/githooks');
  });

  it('Given an absolute Windows hooksPath, When resolveHooksDir, Then it is used verbatim', () => {
    // Arrange
    const sut = resolveHooksDir('C:\\githooks', layout());

    // Assert
    expect(sut).toBe('C:\\githooks');
  });

  it('Given a ~/ hooksPath with a known homeDir, When resolveHooksDir, Then it expands against homeDir', () => {
    // Arrange + Assert
    expect(resolveHooksDir('~/.githooks', layout({ homeDir: '/home/ada' }))).toBe(
      '/home/ada/.githooks',
    );
  });

  it('Given a ~/ hooksPath with no homeDir, When resolveHooksDir, Then it falls back to <gitDir>/hooks', () => {
    // Arrange
    const sut = resolveHooksDir('~/.githooks', layout());

    // Assert
    expect(sut).toBe('/repo/.git/hooks');
  });

  it('Given a relative hooksPath, When resolveHooksDir, Then it resolves against the working-tree root', () => {
    // Arrange
    const sut = resolveHooksDir('.husky', layout());

    // Assert
    expect(sut).toBe('/repo/.husky');
  });

  it('Given a relative hooksPath with a drive-letter sequence mid-string, When resolveHooksDir, Then it stays relative', () => {
    // Arrange + Assert
    // The drive-letter form is absolute only when it anchors the start.
    expect(resolveHooksDir('hooks/c:/sub', layout())).toBe('/repo/hooks/c:/sub');
  });
});

describe('primitives/run-hook runHook', () => {
  beforeEach(() => {
    __resetConfigCacheForTests();
  });

  it('Given a Context with no HookRunner, When runHook, Then it resolves without error', async () => {
    // Arrange
    const ctx = createMemoryContext();

    // Act & Assert
    await expect(runHook(ctx, 'pre-commit')).resolves.toBeUndefined();
  });

  it('Given a runner that skips the hook, When runHook, Then it resolves without throwing', async () => {
    // Arrange
    const ctx = createMemoryContext({ hooks: new MemoryHookRunner() });

    // Act & Assert
    await expect(runHook(ctx, 'pre-commit')).resolves.toBeUndefined();
  });

  it('Given a hook that exits 0, When runHook, Then it resolves without throwing', async () => {
    // Arrange
    const runner = new MemoryHookRunner({
      'pre-commit': { kind: 'ran', exitCode: 0, stdout: '', stderr: '' },
    });
    const ctx = createMemoryContext({ hooks: runner });

    // Act & Assert
    await expect(runHook(ctx, 'pre-commit')).resolves.toBeUndefined();
  });

  it('Given a hook that exits 1, When runHook, Then it throws HOOK_FAILED carrying the hook, exit code and stderr', async () => {
    // Arrange
    const runner = new MemoryHookRunner({
      'commit-msg': { kind: 'ran', exitCode: 1, stdout: '', stderr: 'bad message' },
    });
    const ctx = createMemoryContext({ hooks: runner });

    // Act
    let caught: unknown;
    try {
      await runHook(ctx, 'commit-msg');
    } catch (err) {
      caught = err;
    }

    // Assert
    expect(caught).toBeInstanceOf(TsgitError);
    expect((caught as TsgitError).data).toEqual({
      code: 'HOOK_FAILED',
      hook: 'commit-msg',
      exitCode: 1,
      stderr: 'bad message',
    });
  });

  it('Given a hook that exits with a non-1 non-zero code, When runHook, Then it still throws HOOK_FAILED', async () => {
    // Arrange
    const runner = new MemoryHookRunner({
      'pre-push': { kind: 'ran', exitCode: 2, stdout: '', stderr: 'nope' },
    });
    const ctx = createMemoryContext({ hooks: runner });

    // Act
    let caught: unknown;
    try {
      await runHook(ctx, 'pre-push');
    } catch (err) {
      caught = err;
    }

    // Assert
    expect((caught as TsgitError).data).toEqual({
      code: 'HOOK_FAILED',
      hook: 'pre-push',
      exitCode: 2,
      stderr: 'nope',
    });
  });

  it('Given args and stdin, When runHook, Then the runner receives them verbatim', async () => {
    // Arrange
    const runner = new MemoryHookRunner();
    const ctx = createMemoryContext({ hooks: runner });

    // Act
    await runHook(ctx, 'pre-push', { args: ['origin', 'https://x/r.git'], stdin: 'ref-line\n' });

    // Assert
    expect(runner.calls[0]?.args).toEqual(['origin', 'https://x/r.git']);
    expect(runner.calls[0]?.stdin).toBe('ref-line\n');
  });

  it('Given no input, When runHook, Then the runner receives empty args and stdin', async () => {
    // Arrange
    const runner = new MemoryHookRunner();
    const ctx = createMemoryContext({ hooks: runner });

    // Act
    await runHook(ctx, 'pre-commit');

    // Assert
    expect(runner.calls[0]?.args).toEqual([]);
    expect(runner.calls[0]?.stdin).toBe('');
  });

  it('Given core.hooksPath is configured, When runHook, Then the request hooksDir reflects it', async () => {
    // Arrange
    const runner = new MemoryHookRunner();
    const ctx = createMemoryContext({ hooks: runner });
    await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[core]\n  hooksPath = /opt/gh\n');

    // Act
    await runHook(ctx, 'pre-commit');

    // Assert
    expect(runner.calls[0]?.hooksDir).toBe('/opt/gh');
  });

  it('Given a Context with an abort signal, When runHook, Then the request carries that signal', async () => {
    // Arrange
    const runner = new MemoryHookRunner();
    const controller = new AbortController();
    const ctx = createMemoryContext({ hooks: runner, signal: controller.signal });

    // Act
    await runHook(ctx, 'pre-commit');

    // Assert
    expect(runner.calls[0]?.signal).toBe(controller.signal);
  });

  it('Given a Context with no abort signal, When runHook, Then the request has no signal key', async () => {
    // Arrange
    const runner = new MemoryHookRunner();
    const ctx = createMemoryContext({ hooks: runner });

    // Act
    await runHook(ctx, 'pre-commit');

    // Assert
    expect('signal' in (runner.calls[0] ?? {})).toBe(false);
  });
});
