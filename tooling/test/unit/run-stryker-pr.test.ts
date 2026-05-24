import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SpawnLike } from '../../run-stryker-pr.js';
import { runStrykerPr } from '../../run-stryker-pr.js';

interface SpawnCall {
  readonly command: string;
  readonly args: readonly string[];
}

const fakeSpawn = (exitCode: number, calls: SpawnCall[]): SpawnLike => {
  return (command, args) => {
    calls.push({ command, args });
    const emitter = new EventEmitter();
    queueMicrotask(() => emitter.emit('exit', exitCode));
    return { on: emitter.on.bind(emitter) };
  };
};

const fakeSpawnError = (error: Error, calls: SpawnCall[]): SpawnLike => {
  return (command, args) => {
    calls.push({ command, args });
    const emitter = new EventEmitter();
    queueMicrotask(() => emitter.emit('error', error));
    return { on: emitter.on.bind(emitter) };
  };
};

describe('runStrykerPr', () => {
  let tmpDir: string;
  let stdoutLines: string[];

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'tsgit-runstryker-'));
    stdoutLines = [];
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('Given TSGIT_MUTATE_PATHS_FILE pointing at a file with newline-separated paths, When invoked, Then spawns stryker run --mutate with comma-joined list', async () => {
    // Arrange
    const file = path.join(tmpDir, 'mutate.txt');
    writeFileSync(file, 'src/a.ts\nsrc/b.ts\n');
    const calls: SpawnCall[] = [];

    // Act
    const sut = await runStrykerPr({
      argv: [],
      env: { TSGIT_MUTATE_PATHS_FILE: file },
      spawn: fakeSpawn(0, calls),
      stdout: (line) => stdoutLines.push(line),
    });

    // Assert
    expect(sut).toBe(0);
    expect(calls).toEqual([{ command: 'stryker', args: ['run', '--mutate', 'src/a.ts,src/b.ts'] }]);
  });

  it('Given TSGIT_MUTATE_PATHS_FILE pointing at an empty file, When invoked, Then exits 0 without spawning stryker', async () => {
    // Arrange
    const file = path.join(tmpDir, 'mutate.txt');
    writeFileSync(file, '');
    const calls: SpawnCall[] = [];

    // Act
    const sut = await runStrykerPr({
      argv: [],
      env: { TSGIT_MUTATE_PATHS_FILE: file },
      spawn: fakeSpawn(0, calls),
      stdout: (line) => stdoutLines.push(line),
    });

    // Assert
    expect(sut).toBe(0);
    expect(calls).toHaveLength(0);
    expect(stdoutLines.join('\n')).toMatch(/No src\/ files in/);
  });

  it('Given a commas-only path list via --mutate argv, When invoked with no env, Then spawns stryker with that list', async () => {
    // Arrange
    const calls: SpawnCall[] = [];

    // Act
    const sut = await runStrykerPr({
      argv: ['--mutate', 'src/foo.ts,src/bar.ts'],
      env: {},
      spawn: fakeSpawn(0, calls),
      stdout: (line) => stdoutLines.push(line),
    });

    // Assert
    expect(sut).toBe(0);
    expect(calls).toEqual([
      { command: 'stryker', args: ['run', '--mutate', 'src/foo.ts,src/bar.ts'] },
    ]);
  });

  it('Given no env and no --mutate argv, When invoked, Then spawns stryker run with no scope (full-tree)', async () => {
    // Arrange
    const calls: SpawnCall[] = [];

    // Act
    const sut = await runStrykerPr({
      argv: [],
      env: {},
      spawn: fakeSpawn(0, calls),
      stdout: (line) => stdoutLines.push(line),
    });

    // Assert
    expect(sut).toBe(0);
    expect(calls).toEqual([{ command: 'stryker', args: ['run'] }]);
    expect(stdoutLines.join('\n')).toMatch(/full tree — local-dev fallback/);
  });

  it('Given stryker exits with non-zero, When awaited, Then runStrykerPr returns that exit code', async () => {
    // Arrange
    const calls: SpawnCall[] = [];

    // Act
    const sut = await runStrykerPr({
      argv: [],
      env: {},
      spawn: fakeSpawn(2, calls),
      stdout: (line) => stdoutLines.push(line),
    });

    // Assert
    expect(sut).toBe(2);
  });

  it('Given the spawned child emits error (e.g. stryker not on PATH), When awaited, Then runStrykerPr returns 1 and logs the error', async () => {
    // Arrange
    const calls: SpawnCall[] = [];

    // Act
    const sut = await runStrykerPr({
      argv: [],
      env: {},
      spawn: fakeSpawnError(new Error('ENOENT: stryker not found'), calls),
      stdout: (line) => stdoutLines.push(line),
    });

    // Assert
    expect(sut).toBe(1);
    expect(stdoutLines.join('\n')).toMatch(/failed to spawn stryker: ENOENT: stryker not found/);
  });

  it('Given a non-existent TSGIT_MUTATE_PATHS_FILE, When invoked, Then treats it as empty (exits 0 without spawning)', async () => {
    // Arrange — file path that does not exist
    const calls: SpawnCall[] = [];

    // Act
    const sut = await runStrykerPr({
      argv: [],
      env: { TSGIT_MUTATE_PATHS_FILE: path.join(tmpDir, 'does-not-exist.txt') },
      spawn: fakeSpawn(0, calls),
      stdout: (line) => stdoutLines.push(line),
    });

    // Assert
    expect(sut).toBe(0);
    expect(calls).toHaveLength(0);
  });
});
