import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { fetch } from '../../../../src/application/commands/fetch.js';
import { TsgitError } from '../../../../src/domain/index.js';
import { seedRepo } from './fixtures.js';

describe('fetch', () => {
  it('Given no remote configured, When fetch, Then throws REMOTE_NOT_CONFIGURED', async () => {
    // Arrange
    const ctx = createMemoryContext();
    await seedRepo(ctx, {});

    // Act
    let caught: unknown;
    try {
      await fetch(ctx);
    } catch (err) {
      caught = err;
    }

    // Assert
    expect(caught).toBeInstanceOf(TsgitError);
    expect((caught as TsgitError).data.code).toBe('REMOTE_NOT_CONFIGURED');
  });

  it('Given an origin remote, When fetch, Then returns the resolved url', async () => {
    // Arrange
    const ctx = createMemoryContext();
    await seedRepo(ctx, {});
    await ctx.fs.writeUtf8(
      `${ctx.layout.gitDir}/config`,
      '[remote "origin"]\n  url = https://example.com/r.git\n',
    );

    // Act
    const sut = await fetch(ctx);

    // Assert
    expect(sut.remote).toBe('origin');
    expect(sut.url).toBe('https://example.com/r.git');
  });
});

import { recordingProgress, withProgress } from './fixtures.js';

describe('fetch — progress reporting', () => {
  it("Given a successful fetch, When run, Then start/end pair fires with op === 'fetch:negotiate'", async () => {
    const ctx = createMemoryContext();
    await seedRepo(ctx, {});
    await ctx.fs.writeUtf8(
      `${ctx.layout.gitDir}/config`,
      '[remote "origin"]\n  url = https://example.com/r.git\n',
    );
    const { reporter, events } = recordingProgress();

    await fetch(withProgress(ctx, reporter));

    expect(events[0]).toEqual({ kind: 'start', op: 'fetch:negotiate' });
    expect(events[events.length - 1]).toEqual({ kind: 'end', op: 'fetch:negotiate' });
  });

  it('Given a failing fetch (no remote), When run, Then end still fires after start', async () => {
    const ctx = createMemoryContext();
    await seedRepo(ctx, {});
    const { reporter, events } = recordingProgress();

    try {
      await fetch(withProgress(ctx, reporter));
    } catch {
      // expected
    }

    const startCount = events.filter((e) => e.kind === 'start').length;
    const endCount = events.filter((e) => e.kind === 'end').length;
    expect(endCount).toBe(startCount);
  });
});
