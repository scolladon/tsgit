import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { applyCleanFilter } from '../../../../../src/application/primitives/internal/apply-clean-filter.js';
import {
  admitClean,
  withCleanOrder,
} from '../../../../../src/application/primitives/internal/clean-order.js';
import type { FilterChoice } from '../../../../../src/application/primitives/resolve-filter-driver.js';
import type { TsgitError } from '../../../../../src/domain/error.js';
import type { FilePath } from '../../../../../src/domain/objects/object-id.js';
import {
  encodePktStream,
  FLUSH_PKT,
  MAX_PKT_LINE_PAYLOAD,
} from '../../../../../src/domain/protocol/pkt-line.js';
import { scriptedCommandRunner } from '../../../../fixtures/scripted-command-runner.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);
const PATH = 'f' as FilePath;
const RAW = enc('hi\n');

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

const SERVER_GREETING = concat(
  stream('git-filter-server\n', 'version=2\n'),
  stream('capability=clean\n', 'capability=smudge\n'),
);

const successResponse = (content: string): Uint8Array =>
  concat(SERVER_GREETING, stream('status=success\n'), stream(content), FLUSH_PKT);

const processDriver = (required: boolean, process = 'proc-cmd'): FilterChoice => ({
  kind: 'external',
  name: 'd',
  clean: 'clean-cmd',
  process,
  required,
});

describe('applyCleanFilter', () => {
  describe('Given a driver configuring both a process and a clean command', () => {
    describe('When the process answers status=success', () => {
      it('Then the process cleans the bytes, over git’s v2 filter protocol', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const { runner, requests } = scriptedCommandRunner(successResponse('HI\n'));
        const sut = applyCleanFilter;

        // Act
        const result = await sut(ctx, runner, PATH, RAW, processDriver(false));

        // Assert
        expect(dec(result)).toBe('HI\n');
        expect(requests.map((r) => r.command)).toEqual(['proc-cmd']);
        expect(dec(requests[0]?.stdin ?? new Uint8Array(0))).toBe(
          dec(
            concat(
              stream('git-filter-client\n', 'version=2\n'),
              stream('capability=clean\n', 'capability=smudge\n', 'capability=delay\n'),
              stream('command=clean\n', 'pathname=f\n'),
              stream('hi\n'),
            ),
          ),
        );
      });
    });
  });

  describe.each([
    {
      label: 'answers status=error',
      stdout: concat(SERVER_GREETING, stream('status=error\n')),
      exitCode: 0,
    },
    {
      label: 'answers status=abort',
      stdout: concat(SERVER_GREETING, stream('status=abort\n')),
      exitCode: 0,
    },
    {
      label: 'fails after sending content',
      stdout: concat(
        SERVER_GREETING,
        stream('status=success\n'),
        stream('HI\n'),
        stream('status=error\n'),
      ),
      exitCode: 0,
    },
    {
      label: 'lacks the clean capability',
      stdout: concat(stream('git-filter-server\n', 'version=2\n'), stream('capability=smudge\n')),
      exitCode: 0,
    },
    {
      label: 'greets with another version',
      stdout: concat(stream('git-filter-server\n', 'version=3\n'), stream('capability=clean\n')),
      exitCode: 0,
    },
    { label: 'exits before greeting', stdout: new Uint8Array(0), exitCode: 1 },
    { label: 'writes a malformed frame', stdout: enc('zzzz'), exitCode: 0 },
    {
      label: 'writes a truncated frame',
      stdout: concat(SERVER_GREETING, enc('0010ab')),
      exitCode: 0,
    },
    {
      label: 'writes a reserved length',
      stdout: concat(SERVER_GREETING, enc('0003')),
      exitCode: 0,
    },
    {
      label: 'ends inside a frame header',
      stdout: concat(SERVER_GREETING, enc('00')),
      exitCode: 0,
    },
    {
      label: 'greets but sends no status',
      stdout: SERVER_GREETING,
      exitCode: 0,
    },
    {
      label: 'ends without its trailing status',
      stdout: concat(SERVER_GREETING, stream('status=success\n'), stream('HI\n')),
      exitCode: 0,
    },
    {
      label: 'stops before sending content',
      stdout: concat(SERVER_GREETING, stream('status=success\n')),
      exitCode: 0,
    },
  ])('Given a process driver that $label', ({ stdout, exitCode }) => {
    describe('When the driver is optional', () => {
      it('Then the raw bytes are kept', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const { runner } = scriptedCommandRunner(stdout, exitCode);
        const sut = applyCleanFilter;

        // Act
        const result = await sut(ctx, runner, PATH, RAW, processDriver(false));

        // Assert
        expect(result).toBe(RAW);
      });
    });

    describe('When the driver is required', () => {
      it('Then it refuses with CLEAN_FILTER_FAILED', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const { runner } = scriptedCommandRunner(stdout, exitCode);
        const sut = applyCleanFilter;

        // Act
        const result = await sut(ctx, runner, PATH, RAW, processDriver(true)).catch(
          (err: unknown) => err,
        );

        // Assert
        expect((result as TsgitError).data).toEqual({
          code: 'CLEAN_FILTER_FAILED',
          path: 'f',
          filter: 'd',
          ...(exitCode !== 0 && { exitCode }),
        });
      });
    });
  });

  describe('Given a process that answers successfully, then exits non-zero', () => {
    describe('When cleaning', () => {
      it('Then the response stands, as git never checks a filter process exit', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const { runner } = scriptedCommandRunner(successResponse('HI\n'), 2);
        const sut = applyCleanFilter;

        // Act
        const result = await sut(ctx, runner, PATH, RAW, processDriver(true));

        // Assert
        expect(dec(result)).toBe('HI\n');
      });
    });
  });

  describe('Given a process that captures no output and exits non-zero', () => {
    describe('When a required driver cleans', () => {
      it('Then it refuses with the exit code', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const { runner } = scriptedCommandRunner(new Uint8Array(0), 9);
        const sut = applyCleanFilter;

        // Act
        const result = await sut(ctx, runner, PATH, RAW, processDriver(true)).catch(
          (err: unknown) => err,
        );

        // Assert
        expect((result as TsgitError).data).toEqual({
          code: 'CLEAN_FILTER_FAILED',
          path: 'f',
          filter: 'd',
          exitCode: 9,
        });
      });
    });
  });

  describe('Given an identity filter choice', () => {
    describe('When cleaning', () => {
      it('Then the bytes pass through and nothing runs', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const { runner, requests } = scriptedCommandRunner(enc('unused'));
        const sut = applyCleanFilter;

        // Act
        const result = await sut(ctx, runner, PATH, RAW, { kind: 'identity' });

        // Assert
        expect(result).toBe(RAW);
        expect(requests).toEqual([]);
      });
    });
  });

  describe('Given a command carrying an abort signal', () => {
    describe('When the process cleans', () => {
      it('Then the signal reaches the runner', async () => {
        // Arrange
        const signal = new AbortController().signal;
        const ctx = { ...createMemoryContext(), signal };
        const { runner, requests } = scriptedCommandRunner(successResponse('HI\n'));
        const sut = applyCleanFilter;

        // Act
        await sut(ctx, runner, PATH, RAW, processDriver(false));

        // Assert
        expect(requests[0]?.signal).toBe(signal);
      });
    });
  });

  describe('Given content longer than one pkt-line payload', () => {
    describe('When the process cleans it', () => {
      it('Then the content is split across frames of at most one payload', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const { runner, requests } = scriptedCommandRunner(successResponse('X'));
        const big = new Uint8Array(MAX_PKT_LINE_PAYLOAD + 1).fill(0x61);
        const sut = applyCleanFilter;

        // Act
        await sut(ctx, runner, PATH, big, processDriver(false));

        // Assert
        const sent = dec(requests[0]?.stdin ?? new Uint8Array(0));
        const tail = `fff0${'a'.repeat(MAX_PKT_LINE_PAYLOAD)}0005a0000`;
        expect(sent.endsWith(tail)).toBe(true);
      });
    });
  });

  describe('Given a required driver whose process is empty and whose clean command is set', () => {
    describe('When cleaning', () => {
      it('Then nothing runs and the clean dies, as a set process shadows the clean command', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const { runner, requests } = scriptedCommandRunner(enc('CLEANED'));
        const sut = applyCleanFilter;

        // Act
        let caught: unknown;
        try {
          await sut(ctx, runner, PATH, RAW, processDriver(true, ''));
        } catch (error) {
          caught = error;
        }

        // Assert
        expect((caught as TsgitError).data).toEqual({
          code: 'CLEAN_FILTER_FAILED',
          path: PATH,
          filter: 'd',
        });
        expect(requests).toEqual([]);
      });
    });
  });

  describe('Given a clean order where another path comes first', () => {
    describe('When the later path is cleaned before the earlier one is released', () => {
      it('Then the driver hears nothing until the earlier path is released', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const earlier = 'e' as FilePath;
        const { runner, requests } = scriptedCommandRunner(successResponse('HI\n'));
        const sut = applyCleanFilter;

        // Act
        const result = await withCleanOrder(ctx, async (order) => {
          order.enlist(earlier);
          order.enlist(PATH);
          const cleaning = sut(ctx, runner, PATH, RAW, processDriver(false));
          await new Promise((resolve) => setTimeout(resolve, 0));
          const heardEarly = requests.length;
          order.release(earlier);
          return { heardEarly, cleaned: dec(await cleaning) };
        });

        // Assert
        expect(result).toEqual({ heardEarly: 0, cleaned: 'HI\n' });
      });
    });

    describe('When a path has been cleaned', () => {
      it('Then the path after it is admitted', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const later = 'g' as FilePath;
        const { runner } = scriptedCommandRunner(successResponse('HI\n'));
        const sut = applyCleanFilter;

        // Act
        const admitted = await withCleanOrder(ctx, async (order) => {
          order.enlist(PATH);
          order.enlist(later);
          await sut(ctx, runner, PATH, RAW, processDriver(false));
          return Promise.race([
            admitClean(ctx, later).then(() => true),
            new Promise((resolve) => setTimeout(() => resolve(false), 0)),
          ]);
        });

        // Assert
        expect(admitted).toBe(true);
      });
    });
  });
});
