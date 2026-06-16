import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { MemoryHookRunner } from '../../../../src/adapters/memory/memory-hook-runner.js';
import { __resetConfigCacheForTests } from '../../../../src/application/primitives/config-read.js';
import {
  NO_HOOKS_SUBDIR,
  resolveHooksDir,
  runHook,
  runInformationalHook,
} from '../../../../src/application/primitives/run-hook.js';
import { TsgitError } from '../../../../src/domain/error.js';
import type { RepositoryLayout } from '../../../../src/ports/context.js';

const layout = (over: Partial<RepositoryLayout> = {}): RepositoryLayout => ({
  workDir: '/repo',
  gitDir: '/repo/.git',
  bare: false,
  ...over,
});

describe('primitives/run-hook resolveHooksDir', () => {
  describe('Given no hooksPath', () => {
    describe('When resolveHooksDir', () => {
      it('Then it defaults to <gitDir>/hooks', () => {
        // Arrange
        const sut = resolveHooksDir(undefined, layout());

        // Assert
        expect(sut).toBe('/repo/.git/hooks');
      });
    });
  });

  describe('Given an absolute POSIX hooksPath', () => {
    describe('When resolveHooksDir', () => {
      it('Then it is used verbatim', () => {
        // Arrange
        const sut = resolveHooksDir('/opt/githooks', layout());

        // Assert
        expect(sut).toBe('/opt/githooks');
      });
    });
  });

  describe('Given an absolute Windows hooksPath', () => {
    describe('When resolveHooksDir', () => {
      it('Then it is used verbatim', () => {
        // Arrange
        const sut = resolveHooksDir('C:\\githooks', layout());

        // Assert
        expect(sut).toBe('C:\\githooks');
      });
    });
  });

  describe('Given a ~/ hooksPath with a known homeDir', () => {
    describe('When resolveHooksDir', () => {
      it('Then it expands against homeDir', () => {
        // Arrange + Assert
        expect(resolveHooksDir('~/.githooks', layout({ homeDir: '/home/ada' }))).toBe(
          '/home/ada/.githooks',
        );
      });
    });
  });

  describe('Given a ~/ hooksPath with no homeDir', () => {
    describe('When resolveHooksDir', () => {
      it('Then it falls back to <gitDir>/hooks', () => {
        // Arrange
        const sut = resolveHooksDir('~/.githooks', layout());

        // Assert
        expect(sut).toBe('/repo/.git/hooks');
      });
    });
  });

  describe('Given a relative hooksPath', () => {
    describe('When resolveHooksDir', () => {
      it('Then it resolves against the working-tree root', () => {
        // Arrange
        const sut = resolveHooksDir('.husky', layout());

        // Assert
        expect(sut).toBe('/repo/.husky');
      });
    });
  });

  describe('Given a relative hooksPath with a drive-letter sequence mid-string', () => {
    describe('When resolveHooksDir', () => {
      it('Then it stays relative', () => {
        // Arrange + Assert
        // The drive-letter form is absolute only when it anchors the start.
        expect(resolveHooksDir('hooks/c:/sub', layout())).toBe('/repo/hooks/c:/sub');
      });
    });
  });

  describe('Given an empty hooksPath', () => {
    describe('When resolveHooksDir', () => {
      it('Then it does NOT resolve to the default <gitDir>/hooks', () => {
        // Arrange
        const sut = resolveHooksDir('', layout());

        // Assert — absent fires the default dir; empty must not collapse to it
        expect(sut).not.toBe(`${layout().gitDir}/hooks`);
      });

      it('Then it does NOT resolve to the worktree root', () => {
        // Arrange
        const sut = resolveHooksDir('', layout());

        // Assert — empty must not resolve against the CWD / worktree root
        expect(sut).not.toBe(`${layout().workDir}/`);
      });

      it('Then it resolves to the no-hooks sentinel directory under gitDir', () => {
        // Arrange
        const sut = resolveHooksDir('', layout());

        // Assert — a reserved dir guaranteed to hold no hook script
        expect(sut).toBe(`${layout().gitDir}/${NO_HOOKS_SUBDIR}`);
      });
    });
  });
});

describe('primitives/run-hook runHook', () => {
  beforeEach(() => {
    __resetConfigCacheForTests();
  });

  describe('Given a Context with no HookRunner', () => {
    describe('When runHook', () => {
      it('Then it resolves without error', async () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act & Assert
        await expect(runHook(ctx, 'pre-commit')).resolves.toBeUndefined();
      });
    });
  });

  describe('Given a runner that skips the hook', () => {
    describe('When runHook', () => {
      it('Then it resolves without throwing', async () => {
        // Arrange
        const ctx = createMemoryContext({ hooks: new MemoryHookRunner() });

        // Act & Assert
        await expect(runHook(ctx, 'pre-commit')).resolves.toBeUndefined();
      });
    });
  });

  describe('Given a hook that exits 0', () => {
    describe('When runHook', () => {
      it('Then it resolves without throwing', async () => {
        // Arrange
        const runner = new MemoryHookRunner({
          'pre-commit': { kind: 'ran', exitCode: 0, stdout: '', stderr: '' },
        });
        const ctx = createMemoryContext({ hooks: runner });

        // Act & Assert
        await expect(runHook(ctx, 'pre-commit')).resolves.toBeUndefined();
      });
    });
  });

  describe('Given a hook that exits 1', () => {
    describe('When runHook', () => {
      it('Then it throws HOOK_FAILED carrying the hook, exit code and stderr', async () => {
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
    });
  });

  describe('Given a hook that exits with a non-1 non-zero code', () => {
    describe('When runHook', () => {
      it('Then it still throws HOOK_FAILED', async () => {
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
    });
  });

  describe('Given args and stdin', () => {
    describe('When runHook', () => {
      it('Then the runner receives them verbatim', async () => {
        // Arrange
        const runner = new MemoryHookRunner();
        const ctx = createMemoryContext({ hooks: runner });

        // Act
        await runHook(ctx, 'pre-push', {
          args: ['origin', 'https://x/r.git'],
          stdin: 'ref-line\n',
        });

        // Assert
        expect(runner.calls[0]?.args).toEqual(['origin', 'https://x/r.git']);
        expect(runner.calls[0]?.stdin).toBe('ref-line\n');
      });
    });
  });

  describe('Given no input', () => {
    describe('When runHook', () => {
      it('Then the runner receives empty args and stdin', async () => {
        // Arrange
        const runner = new MemoryHookRunner();
        const ctx = createMemoryContext({ hooks: runner });

        // Act
        await runHook(ctx, 'pre-commit');

        // Assert
        expect(runner.calls[0]?.args).toEqual([]);
        expect(runner.calls[0]?.stdin).toBe('');
      });
    });
  });

  describe('Given core.hooksPath is configured', () => {
    describe('When runHook', () => {
      it('Then the request hooksDir reflects it', async () => {
        // Arrange
        const runner = new MemoryHookRunner();
        const ctx = createMemoryContext({ hooks: runner });
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[core]\n  hooksPath = /opt/gh\n');

        // Act
        await runHook(ctx, 'pre-commit');

        // Assert
        expect(runner.calls[0]?.hooksDir).toBe('/opt/gh');
      });
    });
  });

  describe('Given a Context with an abort signal', () => {
    describe('When runHook', () => {
      it('Then the request carries that signal', async () => {
        // Arrange
        const runner = new MemoryHookRunner();
        const controller = new AbortController();
        const ctx = createMemoryContext({ hooks: runner, signal: controller.signal });

        // Act
        await runHook(ctx, 'pre-commit');

        // Assert
        expect(runner.calls[0]?.signal).toBe(controller.signal);
      });
    });
  });

  describe('Given a Context with no abort signal', () => {
    describe('When runHook', () => {
      it('Then the request has no signal key', async () => {
        // Arrange
        const runner = new MemoryHookRunner();
        const ctx = createMemoryContext({ hooks: runner });

        // Act
        await runHook(ctx, 'pre-commit');

        // Assert
        expect('signal' in (runner.calls[0] ?? {})).toBe(false);
      });
    });
  });

  describe('Given a valueless core.hooksPath at line 2', () => {
    describe('When runHook resolves the hooks dir', () => {
      it('Then it refuses with CONFIG_MISSING_VALUE for core.hookspath at that line', async () => {
        // Arrange
        const runner = new MemoryHookRunner();
        const ctx = createMemoryContext({ hooks: runner });
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[core]\n\thooksPath\n');

        // Act
        let caught: unknown;
        try {
          await runHook(ctx, 'pre-commit');
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data as {
          code: string;
          key: string;
          line: number;
        };
        expect(data.code).toBe('CONFIG_MISSING_VALUE');
        expect(data.key).toBe('core.hookspath');
        expect(data.line).toBe(2);
      });
    });
  });

  describe('Given a valued core.hooksPath', () => {
    describe('When runHook resolves the hooks dir', () => {
      it('Then it resolves to that directory without throwing', async () => {
        // Arrange
        const runner = new MemoryHookRunner();
        const ctx = createMemoryContext({ hooks: runner });
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[core]\n\thooksPath = /opt/gh\n');

        // Act
        await runHook(ctx, 'pre-commit');

        // Assert
        expect(runner.calls[0]?.hooksDir).toBe('/opt/gh');
      });
    });
  });

  describe('Given an absent core.hooksPath', () => {
    describe('When runHook resolves the hooks dir', () => {
      it('Then it resolves to the <gitDir>/hooks default without throwing', async () => {
        // Arrange
        const runner = new MemoryHookRunner();
        const ctx = createMemoryContext({ hooks: runner });

        // Act
        await runHook(ctx, 'pre-commit');

        // Assert
        expect(runner.calls[0]?.hooksDir).toBe(`${ctx.layout.gitDir}/hooks`);
      });
    });
  });

  describe('Given an empty core.hooksPath', () => {
    describe('When runHook resolves the hooks dir', () => {
      it('Then the request hooksDir is the sentinel, not the default dir', async () => {
        // Arrange — an unmapped runner skips, mirroring a real hook lookup miss
        const runner = new MemoryHookRunner();
        const ctx = createMemoryContext({ hooks: runner });
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[core]\n\thooksPath = \n');

        // Act
        await runHook(ctx, 'pre-commit');

        // Assert — sentinel resolves so a real runner finds no hook to fire
        expect(runner.calls[0]?.hooksDir).toBe(`${ctx.layout.gitDir}/${NO_HOOKS_SUBDIR}`);
        expect(runner.calls[0]?.hooksDir).not.toBe(`${ctx.layout.gitDir}/hooks`);
      });
    });
  });

  describe('Given an absent core.hooksPath and a blocking pre-commit', () => {
    describe('When runHook resolves the hooks dir', () => {
      it('Then absent fires the default-dir hook and throws HOOK_FAILED', async () => {
        // Arrange — the E3c-dist control: absent ≠ empty (absent fires the default)
        const runner = new MemoryHookRunner({
          'pre-commit': { kind: 'ran', exitCode: 1, stdout: '', stderr: 'blocked' },
        });
        const ctx = createMemoryContext({ hooks: runner });

        // Act
        let caught: unknown;
        try {
          await runHook(ctx, 'pre-commit');
        } catch (err) {
          caught = err;
        }

        // Assert — absent resolved to the default dir, so the hook fired
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data).toEqual({
          code: 'HOOK_FAILED',
          hook: 'pre-commit',
          exitCode: 1,
          stderr: 'blocked',
        });
        expect(runner.calls[0]?.hooksDir).toBe(`${ctx.layout.gitDir}/hooks`);
      });
    });
  });
});

describe('primitives/run-hook runInformationalHook', () => {
  beforeEach(() => {
    __resetConfigCacheForTests();
  });

  describe('Given a Context with no HookRunner', () => {
    describe('When runInformationalHook', () => {
      it('Then it resolves without error', async () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act & Assert
        await expect(runInformationalHook(ctx, 'post-commit')).resolves.toBeUndefined();
      });
    });
  });

  describe('Given a runner that skips the hook', () => {
    describe('When runInformationalHook', () => {
      it('Then it resolves and records the invocation', async () => {
        // Arrange
        const runner = new MemoryHookRunner();
        const ctx = createMemoryContext({ hooks: runner });

        // Act
        await runInformationalHook(ctx, 'post-commit');

        // Assert
        expect(runner.calls[0]?.name).toBe('post-commit');
      });
    });
  });

  describe('Given a hook that exits 0', () => {
    describe('When runInformationalHook', () => {
      it('Then it resolves without throwing', async () => {
        // Arrange
        const runner = new MemoryHookRunner({
          'post-merge': { kind: 'ran', exitCode: 0, stdout: '', stderr: '' },
        });
        const ctx = createMemoryContext({ hooks: runner });

        // Act & Assert
        await expect(runInformationalHook(ctx, 'post-merge')).resolves.toBeUndefined();
      });
    });
  });

  describe('Given a hook that exits non-zero', () => {
    describe('When runInformationalHook', () => {
      it('Then it still resolves without throwing and records the fire', async () => {
        // Arrange — the defining contrast with runHook: an informational hook's
        // non-zero exit is ignored (git-faithful), never surfaced as HOOK_FAILED.
        const runner = new MemoryHookRunner({
          'post-checkout': { kind: 'ran', exitCode: 1, stdout: '', stderr: 'noisy' },
        });
        const ctx = createMemoryContext({ hooks: runner });

        // Act & Assert
        await expect(runInformationalHook(ctx, 'post-checkout')).resolves.toBeUndefined();
        expect(runner.calls[0]?.name).toBe('post-checkout');
      });
    });
  });

  describe('Given args and stdin', () => {
    describe('When runInformationalHook', () => {
      it('Then the runner receives them verbatim', async () => {
        // Arrange
        const runner = new MemoryHookRunner();
        const ctx = createMemoryContext({ hooks: runner });

        // Act
        await runInformationalHook(ctx, 'post-rewrite', {
          args: ['rebase'],
          stdin: 'old new\n',
        });

        // Assert
        expect(runner.calls[0]?.args).toEqual(['rebase']);
        expect(runner.calls[0]?.stdin).toBe('old new\n');
      });
    });
  });

  describe('Given no input', () => {
    describe('When runInformationalHook', () => {
      it('Then the runner receives empty args and stdin', async () => {
        // Arrange
        const runner = new MemoryHookRunner();
        const ctx = createMemoryContext({ hooks: runner });

        // Act
        await runInformationalHook(ctx, 'post-commit');

        // Assert
        expect(runner.calls[0]?.args).toEqual([]);
        expect(runner.calls[0]?.stdin).toBe('');
      });
    });
  });

  describe('Given core.hooksPath is configured', () => {
    describe('When runInformationalHook', () => {
      it('Then the request hooksDir reflects it', async () => {
        // Arrange
        const runner = new MemoryHookRunner();
        const ctx = createMemoryContext({ hooks: runner });
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[core]\n  hooksPath = /opt/gh\n');

        // Act
        await runInformationalHook(ctx, 'post-commit');

        // Assert
        expect(runner.calls[0]?.hooksDir).toBe('/opt/gh');
      });
    });
  });

  describe('Given a Context with an abort signal', () => {
    describe('When runInformationalHook', () => {
      it('Then the request carries that signal', async () => {
        // Arrange
        const runner = new MemoryHookRunner();
        const controller = new AbortController();
        const ctx = createMemoryContext({ hooks: runner, signal: controller.signal });

        // Act
        await runInformationalHook(ctx, 'post-commit');

        // Assert
        expect(runner.calls[0]?.signal).toBe(controller.signal);
      });
    });
  });

  describe('Given a Context with no abort signal', () => {
    describe('When runInformationalHook', () => {
      it('Then the request has no signal key', async () => {
        // Arrange
        const runner = new MemoryHookRunner();
        const ctx = createMemoryContext({ hooks: runner });

        // Act
        await runInformationalHook(ctx, 'post-commit');

        // Assert
        expect('signal' in (runner.calls[0] ?? {})).toBe(false);
      });
    });
  });

  describe('Given a valueless core.hooksPath at line 2', () => {
    describe('When runInformationalHook resolves the hooks dir', () => {
      it('Then it also refuses with CONFIG_MISSING_VALUE for core.hookspath at that line', async () => {
        // Arrange — the informational path shares the same resolution point, so it
        // must refuse identically to the blocking runHook path.
        const runner = new MemoryHookRunner();
        const ctx = createMemoryContext({ hooks: runner });
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[core]\n\thooksPath\n');

        // Act
        let caught: unknown;
        try {
          await runInformationalHook(ctx, 'post-commit');
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data as {
          code: string;
          key: string;
          line: number;
        };
        expect(data.code).toBe('CONFIG_MISSING_VALUE');
        expect(data.key).toBe('core.hookspath');
        expect(data.line).toBe(2);
      });
    });
  });

  describe('Given a valued core.hooksPath', () => {
    describe('When runInformationalHook resolves the hooks dir', () => {
      it('Then it resolves to that directory without throwing', async () => {
        // Arrange
        const runner = new MemoryHookRunner();
        const ctx = createMemoryContext({ hooks: runner });
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[core]\n\thooksPath = /opt/gh\n');

        // Act
        await runInformationalHook(ctx, 'post-commit');

        // Assert
        expect(runner.calls[0]?.hooksDir).toBe('/opt/gh');
      });
    });
  });

  describe('Given an absent core.hooksPath', () => {
    describe('When runInformationalHook resolves the hooks dir', () => {
      it('Then it resolves to the <gitDir>/hooks default without throwing', async () => {
        // Arrange
        const runner = new MemoryHookRunner();
        const ctx = createMemoryContext({ hooks: runner });

        // Act
        await runInformationalHook(ctx, 'post-commit');

        // Assert
        expect(runner.calls[0]?.hooksDir).toBe(`${ctx.layout.gitDir}/hooks`);
      });
    });
  });
});
