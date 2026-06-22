import { describe, expect, it } from 'vitest';

import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { runFilterDriver } from '../../../../src/application/primitives/run-filter-driver.js';
import type {
  CommandRequest,
  CommandResult,
  CommandRunner,
} from '../../../../src/ports/command-runner.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

/** Minimal fake runner: record calls, return a pre-set result. */
class FakeRunner implements CommandRunner {
  private readonly exitCode: number;
  private readonly stdout: Uint8Array | undefined;
  readonly calls: CommandRequest[] = [];

  constructor(exitCode = 0, stdout?: Uint8Array) {
    this.exitCode = exitCode;
    this.stdout = stdout;
  }

  async run(request: CommandRequest): Promise<CommandResult> {
    this.calls.push(request);
    return this.stdout !== undefined
      ? { exitCode: this.exitCode, stdout: this.stdout }
      : { exitCode: this.exitCode };
  }
}

describe('runFilterDriver', () => {
  describe('Given a driver that exits 0 and writes stdout bytes', () => {
    describe('When run with input bytes', () => {
      it('Then result is ok:true carrying the stdout bytes', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const outputBytes = enc('FILTERED OUTPUT');
        const runner = new FakeRunner(0, outputBytes);

        // Act
        const sut = await runFilterDriver(ctx, runner, 'upper', enc('raw input'));

        // Assert
        expect(sut.ok).toBe(true);
        expect(sut.ok === true && dec(sut.bytes)).toBe('FILTERED OUTPUT');
      });
    });
  });

  describe('Given a driver that exits non-zero', () => {
    describe('When run', () => {
      it('Then result is ok:false carrying the exit code', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const runner = new FakeRunner(1, enc('partial'));

        // Act
        const sut = await runFilterDriver(ctx, runner, 'myfilter', enc('data'));

        // Assert
        expect(sut.ok).toBe(false);
        expect(sut.ok === false && sut.exitCode).toBe(1);
      });
    });
  });

  describe('Given a driver that exits 128', () => {
    describe('When run', () => {
      it('Then result is ok:false with exitCode 128', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const runner = new FakeRunner(128);

        // Act
        const sut = await runFilterDriver(ctx, runner, 'lfs', enc('ptr'));

        // Assert
        expect(sut.ok).toBe(false);
        expect(sut.ok === false && sut.exitCode).toBe(128);
      });
    });
  });

  describe('Given a driver that returns no stdout', () => {
    describe('When run with exit 0', () => {
      it('Then result is ok:true with empty bytes', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const runner = new FakeRunner(0, undefined);

        // Act
        const sut = await runFilterDriver(ctx, runner, 'noop', enc('input'));

        // Assert
        expect(sut.ok).toBe(true);
        expect(sut.ok === true && sut.bytes.length).toBe(0);
      });
    });
  });

  describe('Given the request shape', () => {
    describe('When run', () => {
      it('Then command, cwd, env.GIT_DIR and stdin are set correctly', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const inputBytes = enc('hello');
        const runner = new FakeRunner(0, enc('world'));

        // Act
        await runFilterDriver(ctx, runner, 'smudge-cmd', inputBytes);

        // Assert
        const req = runner.calls[0];
        expect(req).toBeDefined();
        expect(req?.command).toBe('smudge-cmd');
        expect(req?.cwd).toBe(ctx.layout.workDir);
        expect(req?.env.GIT_DIR).toBe(ctx.layout.gitDir);
        expect(req?.stdin).toBe(inputBytes);
      });
    });
  });

  describe('Given a context with an abort signal', () => {
    describe('When run', () => {
      it('Then the signal is forwarded to the runner', async () => {
        // Arrange
        const controller = new AbortController();
        const ctx = createMemoryContext({ signal: controller.signal });
        const runner = new FakeRunner(0, enc('out'));

        // Act
        await runFilterDriver(ctx, runner, 'cmd', enc('in'));

        // Assert
        expect(runner.calls[0]?.signal).toBe(controller.signal);
      });
    });
  });

  describe('Given a context without an abort signal', () => {
    describe('When run', () => {
      it('Then no signal is set on the request', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const runner = new FakeRunner(0, enc('out'));

        // Act
        await runFilterDriver(ctx, runner, 'cmd', enc('in'));

        // Assert
        expect(runner.calls[0]?.signal).toBeUndefined();
      });
    });
  });
});
