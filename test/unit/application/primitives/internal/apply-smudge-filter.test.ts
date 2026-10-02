import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { applySmudgeFilter } from '../../../../../src/application/primitives/internal/apply-smudge-filter.js';
import type { FilterChoice } from '../../../../../src/application/primitives/resolve-filter-driver.js';
import type { TsgitError } from '../../../../../src/domain/error.js';
import type { FilePath, ObjectId } from '../../../../../src/domain/objects/object-id.js';
import { encodePktStream, FLUSH_PKT } from '../../../../../src/domain/protocol/pkt-line.js';
import { scriptedCommandRunner } from '../../../../fixtures/scripted-command-runner.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);
const PATH = 'a.t' as FilePath;
const BLOB = '7766585f8e7448d95bc9fc3955475efc72d4740a' as ObjectId;
const RAW = enc('MiXeD\n');
const TARGET = { path: PATH, blob: BLOB, bytes: RAW };

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

const processResponse = (capabilities: ReadonlyArray<string>, content: string): Uint8Array =>
  concat(
    stream('git-filter-server\n', 'version=2\n'),
    stream(...capabilities.map((capability) => `capability=${capability}\n`)),
    stream('status=success\n'),
    stream(content),
    FLUSH_PKT,
  );

const driver = (fields: Partial<Omit<Extract<FilterChoice, { kind: 'external' }>, 'kind'>>) =>
  ({ kind: 'external', name: 'd', required: false, ...fields }) as FilterChoice;

const failureOf = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    await run();
  } catch (error) {
    return (error as TsgitError).data;
  }
  return undefined;
};

describe('applySmudgeFilter', () => {
  describe('Given a process driver advertising smudge', () => {
    describe('When smudging', () => {
      it('Then the process smudges the blob, asked with its path and blob id', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const { runner, requests } = scriptedCommandRunner(
          processResponse(['clean', 'smudge'], 'mixed\n'),
        );
        const sut = applySmudgeFilter;

        // Act
        const result = await sut(ctx, runner, TARGET, driver({ process: 'proc', smudge: 'other' }));

        // Assert
        expect(dec(result)).toBe('mixed\n');
        expect(requests.map((r) => r.command)).toEqual(['proc']);
        expect(dec(requests[0]?.stdin ?? new Uint8Array(0))).toBe(
          dec(
            concat(
              stream('git-filter-client\n', 'version=2\n'),
              stream('capability=clean\n', 'capability=smudge\n', 'capability=delay\n'),
              stream('command=smudge\n', `pathname=${PATH}\n`, `blob=${BLOB}\n`),
              stream('MiXeD\n'),
            ),
          ),
        );
      });
    });
  });

  describe.each([
    {
      label: 'a process driver advertising only clean',
      fields: { process: 'proc' },
      stdout: processResponse(['clean'], 'mixed\n'),
      ran: ['proc'],
    },
    {
      label: 'an empty process shadowing a smudge command',
      fields: { process: '', smudge: 'smudge-cmd' },
      stdout: enc('mixed\n'),
      ran: [],
    },
    {
      label: 'a driver with only a clean command',
      fields: { clean: 'clean-cmd' },
      stdout: enc('mixed\n'),
      ran: [],
    },
  ])('Given $label', ({ fields, stdout, ran }) => {
    describe('When an optional driver smudges', () => {
      it('Then the blob is kept as stored', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const { runner, requests } = scriptedCommandRunner(stdout);
        const sut = applySmudgeFilter;

        // Act
        const result = await sut(ctx, runner, TARGET, driver(fields));

        // Assert
        expect(result).toEqual(RAW);
        expect(requests.map((r) => r.command)).toEqual(ran);
      });
    });

    describe('When a required driver smudges', () => {
      it('Then it dies as convert_to_working_tree does, naming no exit', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const { runner } = scriptedCommandRunner(stdout);
        const sut = applySmudgeFilter;

        // Act
        const result = await failureOf(() =>
          sut(ctx, runner, TARGET, driver({ ...fields, required: true })),
        );

        // Assert
        expect(result).toEqual({ code: 'SMUDGE_FILTER_FAILED', path: PATH, filter: 'd' });
      });
    });
  });

  describe('Given a smudge command', () => {
    describe('When it exits zero', () => {
      it('Then its stdout is the smudged content', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const { runner, requests } = scriptedCommandRunner(enc('mixed\n'));
        const sut = applySmudgeFilter;

        // Act
        const result = await sut(ctx, runner, TARGET, driver({ smudge: 'smudge-cmd' }));

        // Assert
        expect(dec(result)).toBe('mixed\n');
        expect(requests.map((r) => [r.command, dec(r.stdin ?? new Uint8Array(0))])).toEqual([
          ['smudge-cmd', 'MiXeD\n'],
        ]);
      });
    });

    describe('When a required one exits non-zero', () => {
      it('Then it dies naming the exit', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const { runner } = scriptedCommandRunner(enc(''), 3);
        const sut = applySmudgeFilter;

        // Act
        const result = await failureOf(() =>
          sut(ctx, runner, TARGET, driver({ smudge: 'smudge-cmd', required: true })),
        );

        // Assert
        expect(result).toEqual({
          code: 'SMUDGE_FILTER_FAILED',
          path: PATH,
          filter: 'd',
          exitCode: 3,
        });
      });
    });
  });
});
