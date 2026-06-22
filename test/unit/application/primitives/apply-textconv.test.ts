import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { applyTextconv } from '../../../../src/application/primitives/apply-textconv.js';
import type { CommandRunner } from '../../../../src/ports/command-runner.js';

const utf8 = new TextEncoder();

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

  describe('Given a temp file is created', () => {
    describe('When applyTextconv finishes (even on error)', () => {
      it('Then the temp file is cleaned up after the call', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const content = utf8.encode('test\n');
        const tmpPath = `${ctx.layout.gitDir}/TEXTCONV_INPUT_old`;
        const runner: CommandRunner = {
          run: async () => ({ exitCode: 0, stdout: utf8.encode('OUT\n') }),
        };

        // Act
        await applyTextconv(ctx, runner, 'cmd', content, 'old');

        // Assert — temp file no longer exists after the call
        const existsAfter = await ctx.fs.exists(tmpPath);
        expect(existsAfter).toBe(false);
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
});
