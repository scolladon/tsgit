import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { withFilterProcessPool } from '../../../../../src/application/primitives/internal/filter-process-pool.js';
import {
  type FilterProcessRequest,
  runFilterProcess,
} from '../../../../../src/application/primitives/internal/run-filter-process.js';
import type { FilePath, ObjectId } from '../../../../../src/domain/objects/object-id.js';
import { encodePktStream, FLUSH_PKT } from '../../../../../src/domain/protocol/pkt-line.js';
import type { CommandProcess, CommandRunner } from '../../../../../src/ports/command-runner.js';
import type { Context } from '../../../../../src/ports/context.js';
import { scriptedCommandRunner } from '../../../../fixtures/scripted-command-runner.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

const concat = (...parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
};

const stream = (...lines: ReadonlyArray<string>): Uint8Array => encodePktStream(lines.map(enc));

const HANDSHAKE = concat(
  stream('git-filter-server\n', 'version=2\n'),
  stream('capability=clean\n', 'capability=smudge\n'),
);
const success = (content: string): Uint8Array =>
  concat(stream('status=success\n'), stream(content), FLUSH_PKT);
const statusOnly = (status: string): Uint8Array => stream(`status=${status}\n`);

const clean = (path: string, content = 'x\n'): FilterProcessRequest => ({
  capability: 'clean',
  path: path as FilePath,
  bytes: enc(content),
});

const convertAll = (
  ctx: Context,
  runner: CommandRunner,
  requests: ReadonlyArray<FilterProcessRequest>,
) =>
  withFilterProcessPool(ctx, async () => {
    const outcomes = [];
    for (const request of requests) {
      outcomes.push(await runFilterProcess(ctx, runner, 'proc', request));
    }
    return outcomes;
  });

const bytesOf = (outcome: { readonly ok: boolean; readonly bytes?: Uint8Array }) =>
  outcome.ok && outcome.bytes !== undefined ? dec(outcome.bytes) : outcome;

describe('runFilterProcess', () => {
  describe('Given one pool scope serving three paths', () => {
    describe('When each path is cleaned', () => {
      it('Then one process handshakes once and converts every path in order', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const scripted = scriptedCommandRunner(
          concat(HANDSHAKE, success('A\n'), success('B\n'), success('C\n')),
        );
        const sut = convertAll;

        // Act
        const result = await sut(ctx, scripted.runner, [clean('a'), clean('b'), clean('c')]);

        // Assert
        expect(result.map(bytesOf)).toEqual(['A\n', 'B\n', 'C\n']);
        expect(scripted.requests).toHaveLength(1);
        expect(scripted.closed()).toBe(1);
        const sent = dec(scripted.requests[0]?.stdin ?? new Uint8Array(0));
        expect(sent.match(/git-filter-client/g)).toHaveLength(1);
        expect([...sent.matchAll(/pathname=(\w)/g)].map((m) => m[1])).toEqual(['a', 'b', 'c']);
      });
    });
  });

  describe('Given a smudge carrying checkout metadata', () => {
    describe('When the request is sent', () => {
      it('Then ref, treeish and blob follow the pathname in git’s order', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const scripted = scriptedCommandRunner(concat(HANDSHAKE, success('a\n')));
        const sut = runFilterProcess;

        // Act
        await sut(ctx, scripted.runner, 'proc', {
          ...clean('a'),
          capability: 'smudge',
          ref: 'refs/heads/main',
          treeish: 'c0' as ObjectId,
          blob: 'b0' as ObjectId,
        });

        // Assert
        expect(dec(scripted.requests[0]?.stdin ?? new Uint8Array(0))).toContain(
          dec(
            stream(
              'command=smudge\n',
              'pathname=a\n',
              'ref=refs/heads/main\n',
              'treeish=c0\n',
              'blob=b0\n',
            ),
          ),
        );
      });
    });
  });

  describe('Given no pool scope', () => {
    describe('When two paths are cleaned', () => {
      it('Then each conversion starts and closes its own process', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const scripted = scriptedCommandRunner(concat(HANDSHAKE, success('A\n')));
        const sut = runFilterProcess;

        // Act
        await sut(ctx, scripted.runner, 'proc', clean('a'));
        await sut(ctx, scripted.runner, 'proc', clean('b'));

        // Assert
        expect(scripted.requests).toHaveLength(2);
        expect(scripted.closed()).toBe(2);
      });
    });
  });

  describe('Given a nested pool scope', () => {
    describe('When a path is cleaned inside it', () => {
      it('Then the outer scope’s process serves it', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const scripted = scriptedCommandRunner(concat(HANDSHAKE, success('A\n'), success('B\n')));
        const sut = withFilterProcessPool;

        // Act
        await sut(ctx, async () => {
          await runFilterProcess(ctx, scripted.runner, 'proc', clean('a'));
          await sut(ctx, () => runFilterProcess(ctx, scripted.runner, 'proc', clean('b')));
        });

        // Assert
        expect(scripted.requests).toHaveLength(1);
        expect(scripted.closed()).toBe(1);
      });
    });
  });

  describe('Given a scope that a nested scope outlives', () => {
    describe('When the outer scope settles first', () => {
      it('Then the process stays open until the nested scope settles', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const scripted = scriptedCommandRunner(concat(HANDSHAKE, success('A\n'), success('B\n')));
        let finishInner = (): void => undefined;
        const innerGate = new Promise<void>((resolve) => {
          finishInner = resolve;
        });
        const sut = withFilterProcessPool;

        // Act
        let inner: Promise<unknown> = Promise.resolve();
        await sut(ctx, async () => {
          await runFilterProcess(ctx, scripted.runner, 'proc', clean('a'));
          inner = sut(ctx, async () => {
            await innerGate;
            return runFilterProcess(ctx, scripted.runner, 'proc', clean('b'));
          });
        });
        const closedAfterOuter = scripted.closed();
        finishInner();
        const result = await inner;

        // Assert
        expect(closedAfterOuter).toBe(0);
        expect(bytesOf(result as { ok: boolean })).toBe('B\n');
        expect(scripted.requests).toHaveLength(1);
        expect(scripted.closed()).toBe(1);
      });
    });
  });

  describe('Given a process answering status=error for the first path', () => {
    describe('When two paths are cleaned', () => {
      it('Then only the first fails and the same process converts the second', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const scripted = scriptedCommandRunner(
          concat(HANDSHAKE, statusOnly('error'), success('B\n')),
        );
        const sut = convertAll;

        // Act
        const result = await sut(ctx, scripted.runner, [clean('a'), clean('b')]);

        // Assert
        expect(result.map(bytesOf)).toEqual([{ ok: false, exitCode: undefined }, 'B\n']);
        expect(scripted.requests).toHaveLength(1);
      });
    });
  });

  describe('Given a process failing after content for the first path', () => {
    describe('When two paths are cleaned', () => {
      it('Then only the first fails and the same process converts the second', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const failedAfterContent = concat(
          stream('status=success\n'),
          stream('partial'),
          statusOnly('error'),
        );
        const scripted = scriptedCommandRunner(
          concat(HANDSHAKE, failedAfterContent, success('B\n')),
        );
        const sut = convertAll;

        // Act
        const result = await sut(ctx, scripted.runner, [clean('a'), clean('b')]);

        // Assert
        expect(result.map(bytesOf)).toEqual([{ ok: false, exitCode: undefined }, 'B\n']);
        expect(scripted.requests).toHaveLength(1);
      });
    });
  });

  describe('Given a process answering status=abort for the first path', () => {
    describe('When two paths are cleaned', () => {
      it('Then both fail and the second is never sent to the process', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const scripted = scriptedCommandRunner(
          concat(HANDSHAKE, statusOnly('abort'), success('B\n')),
        );
        const sut = convertAll;

        // Act
        const result = await sut(ctx, scripted.runner, [clean('a'), clean('b')]);

        // Assert
        expect(result.map(bytesOf)).toEqual([
          { ok: false, exitCode: undefined },
          { ok: false, exitCode: undefined },
        ]);
        const sent = dec(scripted.requests[0]?.stdin ?? new Uint8Array(0));
        expect(sent.match(/command=clean/g)).toHaveLength(1);
      });
    });
  });

  describe('Given a process aborting cleans', () => {
    describe('When a path is then smudged', () => {
      it('Then the smudge is still sent to the process', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const scripted = scriptedCommandRunner(
          concat(HANDSHAKE, statusOnly('abort'), success('b\n')),
        );
        const sut = convertAll;

        // Act
        const result = await sut(ctx, scripted.runner, [
          clean('a'),
          { ...clean('b'), capability: 'smudge' },
        ]);

        // Assert
        expect(result.map(bytesOf)).toEqual([{ ok: false, exitCode: undefined }, 'b\n']);
      });
    });
  });

  describe.each([
    { label: 'ends its response early', first: concat(HANDSHAKE, stream('status=success\n')) },
    { label: 'answers an unknown status', first: concat(HANDSHAKE, statusOnly('weird')) },
    { label: 'writes a malformed frame', first: concat(HANDSHAKE, enc('zzzz')) },
    { label: 'fails its handshake', first: stream('git-filter-server\n', 'version=3\n') },
    { label: 'ends before its capabilities', first: stream('git-filter-server\n', 'version=2\n') },
  ])('Given a first process that $label', ({ first }) => {
    describe('When two paths are cleaned', () => {
      it('Then the first fails and a restarted process converts the second', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const scripted = scriptedCommandRunner([first, concat(HANDSHAKE, success('B\n'))]);
        const sut = convertAll;

        // Act
        const result = await sut(ctx, scripted.runner, [clean('a'), clean('b')]);

        // Assert
        expect(result.map(bytesOf)).toEqual([{ ok: false, exitCode: undefined }, 'B\n']);
        expect(scripted.requests).toHaveLength(2);
        expect(scripted.closed()).toBe(2);
      });
    });
  });

  describe('Given a broken process exiting non-zero', () => {
    describe('When a path is cleaned', () => {
      it('Then the failure carries the exit code', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const scripted = scriptedCommandRunner(new Uint8Array(0), 9);
        const sut = runFilterProcess;

        // Act
        const result = await sut(ctx, scripted.runner, 'proc', clean('a'));

        // Assert
        expect(result).toEqual({ ok: false, exitCode: 9 });
      });
    });
  });

  describe('Given a process lacking the wanted capability', () => {
    describe('When a path is smudged', () => {
      it('Then it fails without asking the process', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const handshake = concat(
          stream('git-filter-server\n', 'version=2\n'),
          stream('capability=clean\n'),
        );
        const scripted = scriptedCommandRunner(handshake);
        const sut = runFilterProcess;

        // Act
        const result = await sut(ctx, scripted.runner, 'proc', {
          ...clean('a'),
          capability: 'smudge',
        });

        // Assert
        expect(result).toEqual({ ok: false, exitCode: undefined });
        expect(dec(scripted.requests[0]?.stdin ?? new Uint8Array(0))).not.toContain('command=');
      });
    });
  });

  describe('Given a process whose stdin is broken', () => {
    describe('When a path is cleaned', () => {
      it('Then the conversion fails and the process is closed', async () => {
        // Arrange
        const ctx = createMemoryContext();
        let closed = 0;
        const child: CommandProcess = {
          write: async () => {
            throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
          },
          output: { [Symbol.asyncIterator]: async function* () {} },
          close: async () => {
            closed += 1;
            return { exitCode: 0 };
          },
        };
        const runner: CommandRunner = { run: async () => ({ exitCode: 0 }), spawn: () => child };
        const sut = runFilterProcess;

        // Act
        const result = await sut(ctx, runner, 'proc', clean('a'));

        // Assert
        expect(result).toEqual({ ok: false, exitCode: undefined });
        expect(closed).toBe(1);
      });
    });
  });

  describe('Given a runner whose spawn throws once', () => {
    describe('When two paths are cleaned in one scope', () => {
      it('Then the first conversion rejects and the second still runs', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const scripted = scriptedCommandRunner(concat(HANDSHAKE, success('B\n')));
        const failure = new Error('spawn refused');
        let attempts = 0;
        const runner: CommandRunner = {
          ...scripted.runner,
          spawn: (request) => {
            attempts += 1;
            if (attempts === 1) throw failure;
            return (scripted.runner.spawn as NonNullable<CommandRunner['spawn']>)(request);
          },
        };
        const sut = withFilterProcessPool;

        // Act
        const result = await sut(ctx, async () => {
          const first = runFilterProcess(ctx, runner, 'proc', clean('a'));
          const second = runFilterProcess(ctx, runner, 'proc', clean('b'));
          return [await first.catch((error: unknown) => error), await second];
        });

        // Assert
        expect(result[0]).toBe(failure);
        expect(bytesOf(result[1] as { ok: boolean })).toBe('B\n');
      });
    });
  });

  describe('Given a runner that cannot keep a process open', () => {
    describe('When a path is cleaned', () => {
      it('Then the conversion fails without running anything', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const calls: string[] = [];
        const runner: CommandRunner = {
          run: async (request) => {
            calls.push(request.command);
            return { exitCode: 0 };
          },
        };
        const sut = runFilterProcess;

        // Act
        const result = await sut(ctx, runner, 'proc', clean('a'));

        // Assert
        expect(result).toEqual({ ok: false, exitCode: undefined });
        expect(calls).toEqual([]);
      });
    });
  });

  describe('Given a scope whose body throws', () => {
    describe('When the scope ends', () => {
      it('Then its processes are still closed and the error propagates', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const scripted = scriptedCommandRunner(concat(HANDSHAKE, success('A\n')));
        const failure = new Error('boom');
        const sut = withFilterProcessPool;

        // Act
        const result = await sut(ctx, async () => {
          await runFilterProcess(ctx, scripted.runner, 'proc', clean('a'));
          throw failure;
        }).catch((error: unknown) => error);

        // Assert
        expect(result).toBe(failure);
        expect(scripted.closed()).toBe(1);
      });
    });
  });
});
