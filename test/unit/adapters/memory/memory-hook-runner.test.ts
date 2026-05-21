import { describe, expect, it } from 'vitest';
import { MemoryHookRunner } from '../../../../src/adapters/memory/memory-hook-runner.js';
import type { HookName } from '../../../../src/domain/hooks/index.js';
import type { HookRequest } from '../../../../src/ports/hook-runner.js';

const request = (name: HookName): HookRequest => ({
  name,
  hooksDir: '/repo/.git/hooks',
  workDir: '/repo',
  gitDir: '/repo/.git',
  args: [],
  stdin: '',
});

describe('adapters/memory MemoryHookRunner', () => {
  it('Given a hook with a mapped outcome, When run, Then it resolves that outcome', async () => {
    // Arrange
    const sut = new MemoryHookRunner({
      'pre-commit': { kind: 'ran', exitCode: 1, stdout: 'out', stderr: 'err' },
    });

    // Act
    const result = await sut.run(request('pre-commit'));

    // Assert
    expect(result).toEqual({ kind: 'ran', exitCode: 1, stdout: 'out', stderr: 'err' });
  });

  it('Given a hook with no mapped outcome, When run, Then it resolves skipped', async () => {
    // Arrange
    const sut = new MemoryHookRunner({
      'pre-commit': { kind: 'ran', exitCode: 0, stdout: '', stderr: '' },
    });

    // Act
    const result = await sut.run(request('commit-msg'));

    // Assert
    expect(result).toEqual({ kind: 'skipped' });
  });

  it('Given a runner built with no outcomes, When run, Then every hook resolves skipped', async () => {
    // Arrange
    const sut = new MemoryHookRunner();

    // Act
    const result = await sut.run(request('pre-push'));

    // Assert
    expect(result).toEqual({ kind: 'skipped' });
  });

  it('Given several invocations, When inspecting calls, Then every request is recorded in order', async () => {
    // Arrange
    const sut = new MemoryHookRunner();

    // Act
    await sut.run(request('pre-commit'));
    await sut.run(request('pre-push'));

    // Assert
    expect(sut.calls.map((c) => c.name)).toEqual(['pre-commit', 'pre-push']);
  });
});
