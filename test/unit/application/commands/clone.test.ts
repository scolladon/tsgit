import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { clone } from '../../../../src/application/commands/clone.js';
import { TsgitError } from '../../../../src/domain/index.js';

describe('clone', () => {
  it('Given a fresh dir, When clone, Then bootstraps a repo and returns CloneResult', async () => {
    // Arrange
    const ctx = createMemoryContext();

    // Act
    const sut = await clone(ctx, { url: 'https://example.com/r.git' });

    // Assert
    expect(sut.path).toBe(ctx.layout.gitDir);
    expect(sut.head).toBe('main');
  });

  it('Given depth: 1, When clone, Then throws UNSUPPORTED_OPERATION naming Phase 12.2', async () => {
    // Arrange
    const ctx = createMemoryContext();

    // Act
    let caught: unknown;
    try {
      await clone(ctx, { url: 'https://example.com/r.git', depth: 1 });
    } catch (err) {
      caught = err;
    }

    // Assert
    expect(caught).toBeInstanceOf(TsgitError);
    const data = (caught as TsgitError).data as {
      readonly code: string;
      readonly operation?: string;
      readonly reason?: string;
    };
    expect(data.code).toBe('UNSUPPORTED_OPERATION');
    expect(data.operation).toBe('clone-shallow');
    expect(data.reason).toContain('depth');
    expect(data.reason).toContain('12.2');
  });

  it('Given depth: 0, When clone, Then also throws UNSUPPORTED_OPERATION', async () => {
    // Arrange
    const ctx = createMemoryContext();

    // Act
    let caught: unknown;
    try {
      await clone(ctx, { url: 'https://example.com/r.git', depth: 0 });
    } catch (err) {
      caught = err;
    }

    // Assert
    expect(caught).toBeInstanceOf(TsgitError);
    expect((caught as TsgitError).data.code).toBe('UNSUPPORTED_OPERATION');
  });

  it('Given an existing .git, When clone, Then throws TARGET_DIRECTORY_NOT_EMPTY', async () => {
    // Arrange
    const ctx = createMemoryContext();
    await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');

    // Act
    let caught: unknown;
    try {
      await clone(ctx, { url: 'https://example.com/r.git' });
    } catch (err) {
      caught = err;
    }

    // Assert
    expect(caught).toBeInstanceOf(TsgitError);
    expect((caught as TsgitError).data.code).toBe('TARGET_DIRECTORY_NOT_EMPTY');
  });
});

import { recordingProgress, withProgress } from './fixtures.js';

describe('clone — progress reporting', () => {
  it("Given a successful clone, When run, Then start fires before end with op === 'clone:discover'", async () => {
    const ctx = createMemoryContext();
    const { reporter, events } = recordingProgress();

    await clone(withProgress(ctx, reporter), { url: 'https://example.com/r.git' });

    expect(events[0]).toEqual({ kind: 'start', op: 'clone:discover' });
    expect(events[events.length - 1]).toEqual({ kind: 'end', op: 'clone:discover' });
  });

  it('Given a clone that throws (target not empty), When run, Then end still fires when start fired', async () => {
    const ctx = createMemoryContext();
    await ctx.fs.mkdir(`${ctx.layout.gitDir}`);
    await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
    const { reporter, events } = recordingProgress();

    try {
      await clone(withProgress(ctx, reporter), { url: 'https://example.com/r.git' });
    } catch {
      // expected
    }

    const startCount = events.filter((e) => e.kind === 'start').length;
    const endCount = events.filter((e) => e.kind === 'end').length;
    expect(endCount).toBe(startCount);
  });
});
