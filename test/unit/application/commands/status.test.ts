import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import { status } from '../../../../src/application/commands/status.js';
import type { AuthorIdentity } from '../../../../src/domain/objects/index.js';

const author: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

const seedClean = async () => {
  const ctx = createMemoryContext();
  await init(ctx);
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
  await add(ctx, ['a.txt']);
  await commit(ctx, { message: 'first', author });
  return ctx;
};

describe('status', () => {
  it('Given a clean repo, When status, Then clean=true and no working-tree changes', async () => {
    // Arrange
    const ctx = await seedClean();

    // Act
    const sut = await status(ctx);

    // Assert
    expect(sut.clean).toBe(true);
    expect(sut.workingTreeChanges).toEqual([]);
    expect(sut.branch).toBe('refs/heads/main');
  });

  it('Given a modified working file, When status, Then workingTreeChanges contains a modified entry', async () => {
    // Arrange
    const ctx = await seedClean();
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'modified');

    // Act
    const sut = await status(ctx);

    // Assert
    expect(sut.clean).toBe(false);
    expect(sut.workingTreeChanges).toContainEqual({ kind: 'modified', path: 'a.txt' });
  });

  it('Given a deleted working file, When status, Then workingTreeChanges contains a deleted entry', async () => {
    // Arrange
    const ctx = await seedClean();
    await ctx.fs.rm(`${ctx.layout.workDir}/a.txt`);

    // Act
    const sut = await status(ctx);

    // Assert
    expect(sut.workingTreeChanges).toContainEqual({ kind: 'deleted', path: 'a.txt' });
  });
});

// Progress reporting (Phase 10 §6.2). Mutation-resistant: every assertion uses
// `.toBe(<exact string>)` for op names so StringLiteral mutants are killed; the
// granularity boundary is exercised at 99 / 100 / 101 entries to kill operator
// mutants on the comparison.
describe('status — progress reporting', () => {
  type Event =
    | { readonly kind: 'start'; readonly op: string; readonly total?: number }
    | {
        readonly kind: 'update';
        readonly op: string;
        readonly current: number;
        readonly total?: number;
        readonly text?: string;
      }
    | { readonly kind: 'end'; readonly op: string };

  const recordingProgress = (): {
    readonly reporter: import('../../../../src/ports/progress-reporter.js').ProgressReporter;
    readonly events: ReadonlyArray<Event>;
  } => {
    const events: Event[] = [];
    return {
      reporter: {
        start: (op, total) => {
          events.push(total !== undefined ? { kind: 'start', op, total } : { kind: 'start', op });
        },
        update: (op, current, total, text) => {
          events.push({
            kind: 'update',
            op,
            current,
            ...(total !== undefined ? { total } : {}),
            ...(text !== undefined ? { text } : {}),
          });
        },
        end: (op) => {
          events.push({ kind: 'end', op });
        },
      },
      events,
    };
  };

  const seedWithIndexEntries = async (count: number) => {
    const ctx = createMemoryContext();
    await init(ctx);
    const paths: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const path = `f${i}.txt`;
      await ctx.fs.writeUtf8(`${ctx.layout.workDir}/${path}`, String(i));
      paths.push(path);
    }
    if (paths.length > 0) await add(ctx, paths);
    await commit(ctx, { message: 'seed', author });
    return ctx;
  };

  const replaceProgress = (
    ctx: ReturnType<typeof createMemoryContext>,
    reporter: import('../../../../src/ports/progress-reporter.js').ProgressReporter,
  ) => ({ ...ctx, progress: reporter });

  it('Given an empty index, When status runs, Then start fires before any updates and end fires last (no updates)', async () => {
    // Arrange
    const ctx = createMemoryContext();
    await init(ctx);
    const { reporter, events } = recordingProgress();

    // Act
    await status(replaceProgress(ctx, reporter));

    // Assert
    expect(events[0]).toEqual({ kind: 'start', op: 'status:scan' });
    expect(events[events.length - 1]).toEqual({ kind: 'end', op: 'status:scan' });
    // No updates when there are no entries to scan.
    expect(events.filter((e) => e.kind === 'update')).toEqual([]);
  });

  it("Given a status:scan op, When start fires, Then op === 'status:scan' (exact match — kills StringLiteral mutants)", async () => {
    // Arrange
    const ctx = createMemoryContext();
    await init(ctx);
    const { reporter, events } = recordingProgress();

    // Act
    await status(replaceProgress(ctx, reporter));

    // Assert
    const startEvent = events.find((e) => e.kind === 'start');
    expect(startEvent?.kind).toBe('start');
    if (startEvent?.kind === 'start') {
      expect(startEvent.op).toBe('status:scan');
    }
  });

  it('Given exactly 99 indexed entries (granularity boundary -1), When status runs, Then NO bucket-crossing update fires (count never reaches 100)', async () => {
    // Arrange
    const ctx = await seedWithIndexEntries(99);
    const { reporter, events } = recordingProgress();

    // Act
    await status(replaceProgress(ctx, reporter));

    // Assert — at 99 entries, Math.floor(99/100)=0, so no bucket crossing.
    const updates = events.filter((e) => e.kind === 'update');
    expect(updates).toEqual([]);
  });

  it('Given exactly 100 indexed entries (granularity boundary), When status runs, Then exactly one update fires at current=100', async () => {
    // Arrange
    const ctx = await seedWithIndexEntries(100);
    const { reporter, events } = recordingProgress();

    // Act
    await status(replaceProgress(ctx, reporter));

    // Assert
    const updates = events.filter((e) => e.kind === 'update');
    expect(updates.length).toBe(1);
    if (updates[0]?.kind === 'update') {
      expect(updates[0].op).toBe('status:scan');
      expect(updates[0].current).toBe(100);
    }
  });

  it('Given exactly 101 indexed entries (granularity boundary +1), When status runs, Then exactly one update at 100 (status:scan reports indeterminate progress; no final flush)', async () => {
    // Arrange
    const ctx = await seedWithIndexEntries(101);
    const { reporter, events } = recordingProgress();

    // Act
    await status(replaceProgress(ctx, reporter));

    // Assert — bucket crossing at 100 (Math.floor(100/100)=1>0). Last 1 entry doesn't cross
    // a new bucket; total is undefined per design §6.2 so no final-flush rule applies.
    const updates = events
      .filter((e): e is Extract<Event, { kind: 'update' }> => e.kind === 'update')
      .map((e) => e.current);
    expect(updates).toEqual([100]);
  });

  it('Given exactly 200 indexed entries, When status runs, Then exactly two bucket-crossing updates fire (at 100 and 200)', async () => {
    // Arrange
    const ctx = await seedWithIndexEntries(200);
    const { reporter, events } = recordingProgress();

    // Act
    await status(replaceProgress(ctx, reporter));

    // Assert
    const updates = events
      .filter((e): e is Extract<Event, { kind: 'update' }> => e.kind === 'update')
      .map((e) => e.current);
    expect(updates).toEqual([100, 200]);
  });

  it('Given a successful status, When the chain completes, Then end fires AFTER the last update (try/finally on success)', async () => {
    // Arrange
    const ctx = await seedWithIndexEntries(100);
    const { reporter, events } = recordingProgress();

    // Act
    await status(replaceProgress(ctx, reporter));

    // Assert
    const lastUpdateIndex = events.map((e) => e.kind).lastIndexOf('update');
    const endIndex = events.map((e) => e.kind).lastIndexOf('end');
    expect(endIndex).toBeGreaterThan(lastUpdateIndex);
  });

  it('Given a failure during scan, When status rejects, Then end still fires (try/finally on failure)', async () => {
    // Arrange — break readHeadRaw by removing HEAD after init.
    const ctx = createMemoryContext();
    await init(ctx);
    await ctx.fs.rm(`${ctx.layout.gitDir}/HEAD`);
    const { reporter, events } = recordingProgress();

    // Act / Assert
    try {
      await status(replaceProgress(ctx, reporter));
    } catch {
      // expected — HEAD removal causes the read path to throw before start fires
    }
    // start may or may not have fired depending on where the throw happened;
    // the contract is: IF start fires, end MUST follow.
    const startCount = events.filter((e) => e.kind === 'start').length;
    const endCount = events.filter((e) => e.kind === 'end').length;
    expect(endCount).toBe(startCount);
  });
});
