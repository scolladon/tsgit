import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { applyTextconv } from '../../../../src/application/primitives/apply-textconv.js';
import type { TsgitError } from '../../../../src/domain/error.js';
import type { CommandRequest, CommandRunner } from '../../../../src/ports/command-runner.js';
import type { Context } from '../../../../src/ports/context.js';

const utf8 = new TextEncoder();

const stagedInputs = async (ctx: Context): Promise<ReadonlyArray<string>> => {
  if (!(await ctx.fs.exists(ctx.layout.gitDir))) return [];
  return (await ctx.fs.readdir(ctx.layout.gitDir))
    .map((entry) => entry.name)
    .filter((name) => name.startsWith('TEXTCONV_INPUT_'));
};

describe('applyTextconv', () => {
  describe('Given a command and content bytes', () => {
    describe('When applyTextconv is called', () => {
      it('Then it writes content to a temp file, runs command with path as argv[1], returns stdout bytes', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const content = utf8.encode('hello world\n');
        let capturedCommand = '';
        const runner: CommandRunner = {
          run: async (req) => {
            capturedCommand = req.command;
            return { exitCode: 0, stdout: utf8.encode('HELLO WORLD\n') };
          },
        };

        // Act
        const result = await applyTextconv(ctx, runner, 'tr a-z A-Z', content, 'old');

        // Assert — command includes the driver name and a temp path as argv[1]
        expect(result).toEqual(utf8.encode('HELLO WORLD\n'));
        expect(capturedCommand).toMatch(/^tr a-z A-Z .+/);
        // The temp path is argv[1] — it follows the command string
        const parts = capturedCommand.split(' ');
        expect(parts.length).toBe(4); // 'tr' 'a-z' 'A-Z' '<tmpPath>'
      });
    });
  });

  describe('Given a command runner that returns undefined stdout', () => {
    describe('When applyTextconv is called', () => {
      it('Then it returns an empty Uint8Array (defensive fallback)', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const content = utf8.encode('some content\n');
        const runner: CommandRunner = {
          run: async () => ({ exitCode: 0 }),
        };

        // Act
        const result = await applyTextconv(ctx, runner, 'cat', content, 'new');

        // Assert
        expect(result).toEqual(new Uint8Array(0));
      });
    });
  });

  describe('Given a non-gitlink side with content', () => {
    describe('When applyTextconv is called and the runner returns transformed bytes', () => {
      it('Then the returned bytes are the runner stdout bytes', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const content = utf8.encode('hello there\nsecond line\n');
        const expected = utf8.encode('HELLO THERE\nSECOND LINE\n');
        const runner: CommandRunner = {
          run: async () => ({ exitCode: 0, stdout: expected }),
        };

        // Act
        const result = await applyTextconv(ctx, runner, 'up', content, 'old');

        // Assert
        expect(result).toEqual(expected);
      });
    });
  });

  describe('Given a textconv driver that exits non-zero', () => {
    describe('When applyTextconv is called', () => {
      it('Then it throws TEXTCONV_FAILED with the command and exit code and removes the temp file', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const runner: CommandRunner = {
          run: async () => ({ exitCode: 1, stdout: utf8.encode('partial\n') }),
        };

        // Act
        let caught: unknown;
        try {
          await applyTextconv(ctx, runner, 'false', utf8.encode('x\n'), 'old');
        } catch (error) {
          caught = error;
        }

        // Assert
        expect((caught as TsgitError).data).toEqual({
          code: 'TEXTCONV_FAILED',
          command: 'false',
          exitCode: 1,
        });
        expect(await stagedInputs(ctx)).toEqual([]);
      });
    });
  });

  describe('Given an empty textconv command', () => {
    describe('When applyTextconv is called', () => {
      it('Then it throws TEXTCONV_FAILED without an exit code and never runs or stages anything', async () => {
        // Arrange
        const ctx = createMemoryContext();
        let runnerCalled = false;
        const runner: CommandRunner = {
          run: async () => {
            runnerCalled = true;
            return { exitCode: 0 };
          },
        };

        // Act
        let caught: unknown;
        try {
          await applyTextconv(ctx, runner, '', utf8.encode('x\n'), 'old');
        } catch (error) {
          caught = error;
        }

        // Assert
        expect((caught as TsgitError).data).toEqual({ code: 'TEXTCONV_FAILED', command: '' });
        expect(runnerCalled).toBe(false);
        expect(await stagedInputs(ctx)).toEqual([]);
      });
    });
  });

  describe('Given a temp file is created', () => {
    describe('When applyTextconv finishes (even on error)', () => {
      it('Then the temp file is cleaned up after the call', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const content = utf8.encode('test\n');
        const runner: CommandRunner = {
          run: async () => ({ exitCode: 0, stdout: utf8.encode('OUT\n') }),
        };

        // Act
        await applyTextconv(ctx, runner, 'cmd', content, 'old');

        // Assert — temp file no longer exists after the call
        expect(await stagedInputs(ctx)).toEqual([]);
      });
    });
  });

  describe('Given two overlapping invocations with the same token', () => {
    describe('When the first finishes while the second still runs', () => {
      it('Then each stages its own temp file and both succeed', async () => {
        // Arrange
        const ctx = createMemoryContext();
        let releaseSecond: () => void = () => undefined;
        const secondGate = new Promise<void>((resolve) => {
          releaseSecond = resolve;
        });
        const staged: string[] = [];
        let calls = 0;
        const runner: CommandRunner = {
          run: async (req) => {
            const path = req.command.split(' ').pop() ?? '';
            staged.push(path);
            calls += 1;
            if (calls === 2) await secondGate;
            return { exitCode: 0, stdout: await ctx.fs.read(path) };
          },
        };
        const first = applyTextconv(ctx, runner, 'cat', utf8.encode('one\n'), 'old');
        const second = applyTextconv(ctx, runner, 'cat', utf8.encode('two\n'), 'old');

        // Act
        const firstResult = await first;
        releaseSecond();
        const secondResult = await second;

        // Assert
        expect(firstResult).toEqual(utf8.encode('one\n'));
        expect(secondResult).toEqual(utf8.encode('two\n'));
        expect(staged[0]).not.toBe(staged[1]);
      });
    });
  });

  describe('Given ctx.signal is set', () => {
    describe('When applyTextconv is called', () => {
      it('Then it threads signal to the runner request', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const content = utf8.encode('data\n');
        const controller = new AbortController();
        const ctxWithSignal = { ...ctx, signal: controller.signal };
        let capturedSignal: AbortSignal | undefined;
        const runner: CommandRunner = {
          run: async (req) => {
            capturedSignal = req.signal;
            return { exitCode: 0, stdout: content };
          },
        };

        // Act
        await applyTextconv(ctxWithSignal, runner, 'cmd', content, 'side');

        // Assert
        expect(capturedSignal).toBe(controller.signal);
      });
    });
  });

  describe('Given a caller-supplied token', () => {
    describe('When applyTextconv is called', () => {
      it('Then the temp file path embeds the token verbatim for per-invocation uniqueness', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const content = utf8.encode('hello\n');
        let capturedTmpPath = '';
        const runner: CommandRunner = {
          run: async (req) => {
            // argv[1] is the last space-separated token in the command string
            capturedTmpPath = req.command.split(' ').pop() ?? '';
            return { exitCode: 0, stdout: utf8.encode('HELLO\n') };
          },
        };
        const token = 'new_src_ts';

        // Act
        await applyTextconv(ctx, runner, 'upper', content, token);

        // Assert — the temp path ends with the caller-supplied token (the
        // per-side+path token is what prevents concurrent-diff collisions;
        // the cross-path collision itself is exercised in materialise-patch-files.test.ts)
        expect(capturedTmpPath).toMatch(new RegExp(`/TEXTCONV_INPUT_[A-Za-z0-9]{6}_${token}$`));
      });
    });
  });

  describe('Given a context with no abort signal', () => {
    describe('When applyTextconv is called', () => {
      it('Then the signal key is absent from the runner request (not just undefined)', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const content = utf8.encode('data\n');
        let capturedReq: CommandRequest | undefined;
        const runner: CommandRunner = {
          run: async (req) => {
            capturedReq = req;
            return { exitCode: 0, stdout: content };
          },
        };

        // Act
        await applyTextconv(ctx, runner, 'cmd', content, 'tok');

        // Assert — the spread `...(undefined !== undefined ? {signal} : {})` must
        // resolve to `{}`, so `signal` must be absent as an own property.
        expect(capturedReq).toBeDefined();
        expect(Object.hasOwn(capturedReq ?? {}, 'signal')).toBe(false);
      });
    });
  });

  describe('Given a context with a gitDir layout', () => {
    describe('When applyTextconv is called', () => {
      it('Then env.GIT_DIR is set to ctx.layout.gitDir', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const content = utf8.encode('abc\n');
        let capturedEnv: Record<string, string> | undefined;
        const runner: CommandRunner = {
          run: async (req) => {
            capturedEnv = req.env;
            return { exitCode: 0, stdout: content };
          },
        };

        // Act
        await applyTextconv(ctx, runner, 'cmd', content, 'tok');

        // Assert — driver must receive GIT_DIR so it resolves relative paths correctly
        expect(capturedEnv?.GIT_DIR).toBe(ctx.layout.gitDir);
      });
    });
  });
});
