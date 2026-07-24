import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { MemoryHookRunner } from '../../../../../src/adapters/memory/memory-hook-runner.js';
import {
  applyCommitMessageHooks,
  runPreCommitHook,
} from '../../../../../src/application/commands/internal/commit-hooks.js';
import type { TsgitError } from '../../../../../src/domain/error.js';
import type { HookName } from '../../../../../src/domain/hooks/index.js';
import type { Context } from '../../../../../src/ports/context.js';
import type { HookRunner } from '../../../../../src/ports/hook-runner.js';

/**
 * Build a memory Context whose message hooks optionally overwrite
 * `.git/COMMIT_EDITMSG` with the given replacement — the only way to simulate a
 * message-rewriting hook, since a hook signals a rewrite via the file. A
 * rewrite map keyed by hook name lets a test compose prepare-commit-msg and
 * commit-msg edits in order.
 */
const hookedContext = (rewrites: Partial<Record<HookName, string>> = {}): Context => {
  let ctx!: Context;
  const runner: HookRunner = {
    run: async (request) => {
      const replacement = rewrites[request.name];
      if (replacement !== undefined) {
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/COMMIT_EDITMSG`, replacement);
      }
      return { kind: 'ran', exitCode: 0, stdout: '', stderr: '' };
    },
  };
  ctx = createMemoryContext({ hooks: runner });
  return ctx;
};

const opts = { noVerify: false, allowEmptyMessage: false, source: 'message' as const };

describe('commands/internal commit-hooks runPreCommitHook', () => {
  describe('Given noVerify true', () => {
    describe('When runPreCommitHook', () => {
      it('Then it is a no-op despite a failing hook', async () => {
        // Arrange
        const ctx = createMemoryContext({
          hooks: new MemoryHookRunner({
            'pre-commit': { kind: 'ran', exitCode: 1, stdout: '', stderr: 'lint' },
          }),
        });

        // Act & Assert
        await expect(runPreCommitHook(ctx, true)).resolves.toBeUndefined();
      });
    });
  });

  describe('Given noVerify false and a pre-commit hook that fails', () => {
    describe('When runPreCommitHook', () => {
      it('Then it throws HOOK_FAILED', async () => {
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
    });
  });

  describe('Given noVerify false and no hook', () => {
    describe('When runPreCommitHook', () => {
      it('Then it resolves', async () => {
        // Arrange
        const ctx = createMemoryContext({ hooks: new MemoryHookRunner() });

        // Act & Assert
        await expect(runPreCommitHook(ctx, false)).resolves.toBeUndefined();
      });
    });
  });
});

describe('commands/internal commit-hooks applyCommitMessageHooks', () => {
  describe('Given a runner and source message', () => {
    describe('When applyCommitMessageHooks', () => {
      it('Then prepare-commit-msg fires before commit-msg with the editmsg path and source', async () => {
        // Arrange
        const runner = new MemoryHookRunner();
        const ctx = createMemoryContext({ hooks: runner });
        const editMsg = `${ctx.layout.gitDir}/COMMIT_EDITMSG`;

        // Act
        await applyCommitMessageHooks(ctx, 'msg', opts);

        // Assert
        expect(runner.calls.map((c) => c.name)).toEqual(['prepare-commit-msg', 'commit-msg']);
        expect(runner.calls[0]?.args).toEqual([editMsg, 'message']);
        expect(runner.calls[1]?.args).toEqual([editMsg]);
      });
    });
  });

  describe('Given source merge', () => {
    describe('When applyCommitMessageHooks', () => {
      it('Then prepare-commit-msg receives the merge source', async () => {
        // Arrange
        const runner = new MemoryHookRunner();
        const ctx = createMemoryContext({ hooks: runner });

        // Act
        await applyCommitMessageHooks(ctx, 'msg', { ...opts, source: 'merge' });

        // Assert
        expect(runner.calls[0]?.args).toEqual([`${ctx.layout.gitDir}/COMMIT_EDITMSG`, 'merge']);
      });
    });
  });

  describe('Given noVerify true and a runner', () => {
    describe('When applyCommitMessageHooks', () => {
      it('Then prepare-commit-msg still fires, commit-msg does not, and COMMIT_EDITMSG is written', async () => {
        // Arrange — git's --no-verify bypasses only pre-commit + commit-msg;
        // prepare-commit-msg runs regardless.
        const runner = new MemoryHookRunner();
        const ctx = createMemoryContext({ hooks: runner });

        // Act
        await applyCommitMessageHooks(ctx, 'msg', { ...opts, noVerify: true });

        // Assert
        expect(runner.calls.map((c) => c.name)).toEqual(['prepare-commit-msg']);
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/COMMIT_EDITMSG`)).toBe(true);
      });
    });
  });

  describe('Given no hook runner', () => {
    describe('When applyCommitMessageHooks', () => {
      it('Then it returns the message unchanged without writing the editmsg file', async () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        const result = await applyCommitMessageHooks(ctx, 'original', opts);

        // Assert — no runner ⇒ the round-trip is skipped entirely.
        expect(result).toBe('original');
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/COMMIT_EDITMSG`)).toBe(false);
      });
    });
  });

  describe('Given a runner that may rewrite COMMIT_EDITMSG', () => {
    describe('When applyCommitMessageHooks resolves the final message', () => {
      it.each([
        {
          rewrites: {},
          message: '  spaced  ',
          expected: '  spaced\n',
          label:
            'a hook that does not touch the file returns the sanitised message (stripspace round-trip)',
        },
        {
          rewrites: { 'commit-msg': 'rewritten by hook' },
          message: 'original',
          expected: 'rewritten by hook\n',
          label: 'a commit-msg hook that rewrites COMMIT_EDITMSG returns the rewritten message',
        },
        {
          rewrites: { 'prepare-commit-msg': 'from prepare', 'commit-msg': 'from commit-msg' },
          message: 'original',
          expected: 'from commit-msg\n',
          label:
            'a prepare-commit-msg and a commit-msg hook that both rewrite: the commit-msg rewrite (last) wins, proving order',
        },
        {
          rewrites: { 'prepare-commit-msg': 'from prepare' },
          message: 'original',
          expected: 'from prepare\n',
          label: 'only a prepare-commit-msg hook that rewrites is picked up',
        },
      ])('Then $label', async ({ rewrites, message, expected }) => {
        // Arrange
        const ctx = hookedContext(rewrites);

        // Act
        const result = await applyCommitMessageHooks(ctx, message, opts);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });

  describe('Given a commit-msg hook that empties the message and allowEmptyMessage false', () => {
    describe('When applyCommitMessageHooks', () => {
      it('Then it throws EMPTY_COMMIT_MESSAGE', async () => {
        // Arrange
        const ctx = hookedContext({ 'commit-msg': '   ' });

        // Act
        let caught: unknown;
        try {
          await applyCommitMessageHooks(ctx, 'original', opts);
        } catch (err) {
          caught = err;
        }

        // Assert
        expect((caught as TsgitError).data.code).toBe('EMPTY_COMMIT_MESSAGE');
      });
    });
  });

  describe('Given a commit-msg hook that empties the message and allowEmptyMessage true', () => {
    describe('When applyCommitMessageHooks', () => {
      it('Then it returns an empty string', async () => {
        // Arrange
        const ctx = hookedContext({ 'commit-msg': '   ' });

        // Act
        const result = await applyCommitMessageHooks(ctx, 'original', {
          ...opts,
          allowEmptyMessage: true,
        });

        // Assert
        expect(result).toBe('');
      });
    });
  });

  describe('Given a prepare-commit-msg hook that exits non-zero', () => {
    describe('When applyCommitMessageHooks', () => {
      it('Then it throws HOOK_FAILED and commit-msg never runs', async () => {
        // Arrange
        const runner = new MemoryHookRunner({
          'prepare-commit-msg': { kind: 'ran', exitCode: 1, stdout: '', stderr: 'prep bad' },
        });
        const ctx = createMemoryContext({ hooks: runner });

        // Act
        let caught: unknown;
        try {
          await applyCommitMessageHooks(ctx, 'original', opts);
        } catch (err) {
          caught = err;
        }

        // Assert
        expect((caught as TsgitError).data).toEqual({
          code: 'HOOK_FAILED',
          hook: 'prepare-commit-msg',
          exitCode: 1,
          stderr: 'prep bad',
        });
        expect(runner.calls.map((c) => c.name)).toEqual(['prepare-commit-msg']);
      });
    });
  });

  describe('Given a commit-msg hook that exits non-zero', () => {
    describe('When applyCommitMessageHooks', () => {
      it('Then it throws HOOK_FAILED', async () => {
        // Arrange
        const ctx = createMemoryContext({
          hooks: new MemoryHookRunner({
            'commit-msg': { kind: 'ran', exitCode: 1, stdout: '', stderr: 'bad' },
          }),
        });

        // Act
        let caught: unknown;
        try {
          await applyCommitMessageHooks(ctx, 'original', opts);
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
    });
  });
});
