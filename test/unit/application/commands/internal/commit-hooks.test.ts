import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { MemoryHookRunner } from '../../../../../src/adapters/memory/memory-hook-runner.js';
import {
  applyCommitMsgHook,
  runPreCommitHook,
} from '../../../../../src/application/commands/internal/commit-hooks.js';
import type { TsgitError } from '../../../../../src/domain/error.js';
import type { Context } from '../../../../../src/ports/context.js';
import type { HookRunner } from '../../../../../src/ports/hook-runner.js';

/**
 * Build a memory Context whose `commit-msg` hook optionally overwrites
 * `.git/COMMIT_EDITMSG` with `commitMsgRewrite` — the only way to simulate a
 * message-rewriting hook, since a hook signals a rewrite via the file.
 */
const hookedContext = (commitMsgRewrite?: string): Context => {
  let ctx!: Context;
  const runner: HookRunner = {
    run: async (request) => {
      if (request.name === 'commit-msg' && commitMsgRewrite !== undefined) {
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/COMMIT_EDITMSG`, commitMsgRewrite);
      }
      return { kind: 'ran', exitCode: 0, stdout: '', stderr: '' };
    },
  };
  ctx = createMemoryContext({ hooks: runner });
  return ctx;
};

const opts = { noVerify: false, allowEmptyMessage: false };

describe('commands/internal commit-hooks runPreCommitHook', () => {
  it('Given noVerify true, When runPreCommitHook, Then it is a no-op despite a failing hook', async () => {
    // Arrange
    const ctx = createMemoryContext({
      hooks: new MemoryHookRunner({
        'pre-commit': { kind: 'ran', exitCode: 1, stdout: '', stderr: 'lint' },
      }),
    });

    // Act & Assert
    await expect(runPreCommitHook(ctx, true)).resolves.toBeUndefined();
  });

  it('Given noVerify false and a pre-commit hook that fails, When runPreCommitHook, Then it throws HOOK_FAILED', async () => {
    // Arrange
    const ctx = createMemoryContext({
      hooks: new MemoryHookRunner({
        'pre-commit': { kind: 'ran', exitCode: 1, stdout: '', stderr: 'lint' },
      }),
    });

    // Act
    let caught: unknown;
    try {
      await runPreCommitHook(ctx, false);
    } catch (err) {
      caught = err;
    }

    // Assert
    expect((caught as TsgitError).data).toEqual({
      code: 'HOOK_FAILED',
      hook: 'pre-commit',
      exitCode: 1,
      stderr: 'lint',
    });
  });

  it('Given noVerify false and no hook, When runPreCommitHook, Then it resolves', async () => {
    // Arrange
    const ctx = createMemoryContext({ hooks: new MemoryHookRunner() });

    // Act & Assert
    await expect(runPreCommitHook(ctx, false)).resolves.toBeUndefined();
  });
});

describe('commands/internal commit-hooks applyCommitMsgHook', () => {
  it('Given noVerify true, When applyCommitMsgHook, Then it returns the message unchanged and writes no editmsg file', async () => {
    // Arrange
    const ctx = createMemoryContext({ hooks: new MemoryHookRunner() });

    // Act
    const result = await applyCommitMsgHook(ctx, 'original', { ...opts, noVerify: true });

    // Assert
    expect(result).toBe('original');
    expect(await ctx.fs.exists(`${ctx.layout.gitDir}/COMMIT_EDITMSG`)).toBe(false);
  });

  it('Given no hook runner, When applyCommitMsgHook, Then it returns the message unchanged without writing the editmsg file', async () => {
    // Arrange
    const ctx = createMemoryContext();

    // Act
    const result = await applyCommitMsgHook(ctx, 'original', opts);

    // Assert — no runner ⇒ the round-trip is skipped entirely.
    expect(result).toBe('original');
    expect(await ctx.fs.exists(`${ctx.layout.gitDir}/COMMIT_EDITMSG`)).toBe(false);
  });

  it('Given a hook that does not touch the file, When applyCommitMsgHook, Then it returns the sanitised message', async () => {
    // Arrange
    const ctx = hookedContext();

    // Act
    const result = await applyCommitMsgHook(ctx, '  spaced  ', opts);

    // Assert — the round-trip re-sanitises (trims) the message.
    expect(result).toBe('spaced');
  });

  it('Given a commit-msg hook that rewrites COMMIT_EDITMSG, When applyCommitMsgHook, Then it returns the rewritten message', async () => {
    // Arrange
    const ctx = hookedContext('rewritten by hook');

    // Act
    const result = await applyCommitMsgHook(ctx, 'original', opts);

    // Assert
    expect(result).toBe('rewritten by hook');
  });

  it('Given a commit-msg hook that empties the message and allowEmptyMessage false, When applyCommitMsgHook, Then it throws EMPTY_COMMIT_MESSAGE', async () => {
    // Arrange
    const ctx = hookedContext('   ');

    // Act
    let caught: unknown;
    try {
      await applyCommitMsgHook(ctx, 'original', opts);
    } catch (err) {
      caught = err;
    }

    // Assert
    expect((caught as TsgitError).data.code).toBe('EMPTY_COMMIT_MESSAGE');
  });

  it('Given a commit-msg hook that empties the message and allowEmptyMessage true, When applyCommitMsgHook, Then it returns an empty string', async () => {
    // Arrange
    const ctx = hookedContext('   ');

    // Act
    const result = await applyCommitMsgHook(ctx, 'original', { ...opts, allowEmptyMessage: true });

    // Assert
    expect(result).toBe('');
  });

  it('Given a commit-msg hook that exits non-zero, When applyCommitMsgHook, Then it throws HOOK_FAILED', async () => {
    // Arrange
    const ctx = createMemoryContext({
      hooks: new MemoryHookRunner({
        'commit-msg': { kind: 'ran', exitCode: 1, stdout: '', stderr: 'bad' },
      }),
    });

    // Act
    let caught: unknown;
    try {
      await applyCommitMsgHook(ctx, 'original', opts);
    } catch (err) {
      caught = err;
    }

    // Assert
    expect((caught as TsgitError).data).toEqual({
      code: 'HOOK_FAILED',
      hook: 'commit-msg',
      exitCode: 1,
      stderr: 'bad',
    });
  });

  it('Given a hook runner, When applyCommitMsgHook, Then the commit-msg hook receives the COMMIT_EDITMSG path as its only argument', async () => {
    // Arrange
    const runner = new MemoryHookRunner();
    const ctx = createMemoryContext({ hooks: runner });

    // Act
    await applyCommitMsgHook(ctx, 'msg', opts);

    // Assert
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.name).toBe('commit-msg');
    expect(runner.calls[0]?.args).toEqual([`${ctx.layout.gitDir}/COMMIT_EDITMSG`]);
  });
});
