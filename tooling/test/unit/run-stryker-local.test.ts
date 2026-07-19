import { EventEmitter } from 'node:events';

import { describe, expect, it } from 'vitest';
import type { MutationReport, SpawnLike } from '../../run-stryker-local.js';
import { runStrykerLocalSweep } from '../../run-stryker-local.js';

interface SpawnCall {
  readonly command: string;
  readonly args: readonly string[];
}

const fakeSpawn = (calls: SpawnCall[], exitCode = 0): SpawnLike => {
  return (command, args) => {
    calls.push({ command, args });
    const emitter = new EventEmitter();
    queueMicrotask(() => emitter.emit('exit', exitCode));
    return { on: emitter.on.bind(emitter) };
  };
};

const reportOf = (
  files: Record<string, Array<{ status: string; line: number }>>,
): MutationReport => ({
  files: Object.fromEntries(
    Object.entries(files).map(([path, mutants]) => [
      path,
      {
        mutants: mutants.map((m) => ({
          status: m.status,
          mutatorName: 'ConditionalExpression',
          location: { start: { line: m.line, column: 1 } },
        })),
      },
    ]),
  ),
});

const queuedReader = (reports: Array<MutationReport | null>): (() => MutationReport | null) => {
  let call = 0;
  return () => reports[call++] ?? null;
};

describe('runStrykerLocalSweep', () => {
  describe('Given five files and a chunk size of two', () => {
    describe('When the sweep runs', () => {
      it('Then it spawns stryker run --incremental --mutate once per chunk', async () => {
        // Arrange
        const calls: SpawnCall[] = [];
        const sut = runStrykerLocalSweep;

        // Act
        const result = await sut({
          argv: ['--chunk-size', '2'],
          files: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts'],
          spawn: fakeSpawn(calls),
          resetReport: () => {},
          readReport: queuedReader([
            reportOf({ 'src/a.ts': [], 'src/b.ts': [] }),
            reportOf({ 'src/c.ts': [], 'src/d.ts': [] }),
            reportOf({ 'src/e.ts': [] }),
          ]),
          stdout: () => {},
        });

        // Assert — three chunks of [2, 2, 1], each a scoped incremental run
        expect(result.chunksRun).toBe(3);
        expect(calls).toEqual([
          { command: 'stryker', args: ['run', '--incremental', '--mutate', 'src/a.ts,src/b.ts'] },
          { command: 'stryker', args: ['run', '--incremental', '--mutate', 'src/c.ts,src/d.ts'] },
          { command: 'stryker', args: ['run', '--incremental', '--mutate', 'src/e.ts'] },
        ]);
      });
    });
  });

  describe('Given chunk reports containing surviving and killed mutants', () => {
    describe('When the sweep aggregates them', () => {
      it('Then it collects only Survived and NoCoverage mutants for each chunk file', async () => {
        // Arrange
        const sut = runStrykerLocalSweep;

        // Act
        const result = await sut({
          argv: ['--chunk-size', '1'],
          files: ['src/a.ts', 'src/b.ts'],
          spawn: fakeSpawn([]),
          resetReport: () => {},
          readReport: queuedReader([
            reportOf({ 'src/a.ts': [{ status: 'Survived', line: 10 }, { status: 'Killed', line: 11 }] }),
            reportOf({ 'src/b.ts': [{ status: 'NoCoverage', line: 20 }] }),
          ]),
          stdout: () => {},
        });

        // Assert
        expect(result.survivorsByFile.get('src/a.ts')?.map((m) => m.location.start.line)).toEqual([10]);
        expect(result.survivorsByFile.get('src/b.ts')?.map((m) => m.status)).toEqual(['NoCoverage']);
        expect(result.exitCode).toBe(0);
      });
    });
  });

  describe('Given a chunk that resets the report and then crashes without rewriting it', () => {
    describe('When the sweep reads the missing report', () => {
      it('Then it resets before every chunk, credits the failed chunk nothing, and exits non-zero', async () => {
        // Arrange — resetReport runs before each chunk, so a crashed chunk sees
        // no report (null) instead of picking up a stale earlier one.
        let resets = 0;
        const sut = runStrykerLocalSweep;

        // Act
        const result = await sut({
          argv: ['--chunk-size', '1'],
          files: ['src/a.ts', 'src/b.ts'],
          spawn: fakeSpawn([]),
          resetReport: () => {
            resets += 1;
          },
          readReport: queuedReader([reportOf({ 'src/a.ts': [{ status: 'Survived', line: 5 }] }), null]),
          stdout: () => {},
        });

        // Assert
        expect(resets).toBe(2);
        expect(result.failedChunks).toBe(1);
        expect(result.exitCode).toBe(1);
        expect(result.survivorsByFile.has('src/b.ts')).toBe(false);
        expect(result.survivorsByFile.get('src/a.ts')).toHaveLength(1);
      });
    });
  });

  describe('Given a report file that cannot be read', () => {
    describe('When the sweep runs a single chunk', () => {
      it('Then the chunk is marked failed', async () => {
        // Arrange
        const sut = runStrykerLocalSweep;

        // Act
        const result = await sut({
          argv: [],
          files: ['src/a.ts'],
          spawn: fakeSpawn([]),
          resetReport: () => {},
          readReport: () => null,
          stdout: () => {},
        });

        // Assert
        expect(result.failedChunks).toBe(1);
        expect(result.exitCode).toBe(1);
      });
    });
  });

  describe('Given an invalid --chunk-size argument', () => {
    describe('When the sweep runs', () => {
      it('Then it falls back to the default chunk size of 20', async () => {
        // Arrange — 21 files with a bad size falls back to 20 → two chunks
        const calls: SpawnCall[] = [];
        const files = Array.from({ length: 21 }, (_, i) => `src/f${i}.ts`);
        const sut = runStrykerLocalSweep;

        // Act
        const result = await sut({
          argv: ['--chunk-size', 'nonsense'],
          files,
          spawn: fakeSpawn(calls),
          resetReport: () => {},
          readReport: () => reportOf(Object.fromEntries(files.map((f) => [f, []]))),
          stdout: () => {},
        });

        // Assert
        expect(result.chunksRun).toBe(2);
        expect(calls).toHaveLength(2);
      });
    });
  });
});
