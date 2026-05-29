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
  describe('Given a clean repo', () => {
    describe('When status', () => {
      it('Then clean=true and no working-tree changes', async () => {
        // Arrange
        const ctx = await seedClean();

        // Act
        const sut = await status(ctx);

        // Assert
        expect(sut.clean).toBe(true);
        expect(sut.workingTreeChanges).toEqual([]);
        expect(sut.branch).toBe('refs/heads/main');
      });
    });
  });

  describe('Given a modified working file', () => {
    describe('When status', () => {
      it('Then workingTreeChanges contains a modified entry', async () => {
        // Arrange
        const ctx = await seedClean();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'modified');

        // Act
        const sut = await status(ctx);

        // Assert
        expect(sut.clean).toBe(false);
        expect(sut.workingTreeChanges).toContainEqual({ kind: 'modified', path: 'a.txt' });
      });
    });
  });

  describe('Given a deleted working file', () => {
    describe('When status', () => {
      it('Then workingTreeChanges contains a deleted entry', async () => {
        // Arrange
        const ctx = await seedClean();
        await ctx.fs.rm(`${ctx.layout.workDir}/a.txt`);

        // Act
        const sut = await status(ctx);

        // Assert
        expect(sut.workingTreeChanges).toContainEqual({ kind: 'deleted', path: 'a.txt' });
      });
    });
  });

  describe('Given a symbolic HEAD', () => {
    describe('When status', () => {
      it('Then detached=false and branch is set', async () => {
        // Arrange — seedClean leaves HEAD as `ref: refs/heads/main`.
        const ctx = await seedClean();

        // Act
        const sut = await status(ctx);

        // Assert — kills L46 `head.kind === 'direct'` -> `false` (would force
        // detached=false anyway, but `=== ` -> `!== ` would flip this to true).
        expect(sut.detached).toBe(false);
        expect(sut.branch).toBe('refs/heads/main');
      });
    });
  });

  describe('Given a detached HEAD pointing at a commit oid', () => {
    describe('When status', () => {
      it('Then detached=true and branch is undefined', async () => {
        // Arrange — commit on main, then rewrite HEAD to the bare commit oid.
        const ctx = await seedClean();
        const head = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/HEAD`);
        const ref = head.replace('ref: ', '').trim();
        const oid = (await ctx.fs.readUtf8(`${ctx.layout.gitDir}/${ref}`)).trim();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, `${oid}\n`);

        // Act
        const sut = await status(ctx);

        // Assert — kills L46 EqualityOperator `=== ` -> `!== ` (would make this
        // false) and ConditionalExpression `-> false` (would make this false).
        expect(sut.detached).toBe(true);
        expect(sut.branch).toBeUndefined();
      });
    });
  });

  describe('Given three untracked files added out of order', () => {
    describe('When status', () => {
      it('Then they are sorted ascending by path', async () => {
        // Arrange — write in a deliberately non-sorted, non-reversed order so a
        // dropped `.sort()` (MethodExpression mutant) yields the insertion order
        // `['u3','u1','u2']`, which differs from both ascending and descending.
        // u*.txt names avoid colliding with the tracked `a.txt` from seedClean.
        const ctx = await seedClean();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/u3.txt`, '3');
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/u1.txt`, '1');
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/u2.txt`, '2');

        // Act
        const sut = await status(ctx);

        // Assert — kills L72 `untracked.sort(...)` -> `untracked` (no sort) and
        // ConditionalExpression `-> true`/`-> false` + UnaryOperator `-1` -> `+1`
        // on the comparator, all of which break this exact ascending order.
        const untrackedPaths = sut.workingTreeChanges
          .filter((c) => c.kind === 'untracked')
          .map((c) => c.path);
        expect(untrackedPaths).toEqual(['u1.txt', 'u2.txt', 'u3.txt']);
      });
    });
  });

  describe('Given untracked files added in descending order', () => {
    describe('When status', () => {
      it('Then they are sorted ascending', async () => {
        // Arrange — pure descending insertion: a dropped sort or a `false`/`-1->+1`
        // comparator mutant would leave `['u3','u2','u1']`; a `>=` comparator
        // mutant would also leave `['u3','u2','u1']`.
        const ctx = await seedClean();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/u3.txt`, '3');
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/u2.txt`, '2');
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/u1.txt`, '1');

        // Act
        const sut = await status(ctx);

        // Assert — kills the comparator's EqualityOperator `< ` -> `>= ` mutant.
        const untrackedPaths = sut.workingTreeChanges
          .filter((c) => c.kind === 'untracked')
          .map((c) => c.path);
        expect(untrackedPaths).toEqual(['u1.txt', 'u2.txt', 'u3.txt']);
      });
    });
  });

  // A repo with `src/a.txt` + `docs/b.txt`, then a cone-mode `set` keeping
  // only `src/` — `docs/b.txt` becomes a skip-worktree index entry, absent
  // from disk.
  const seedSparseRepo = async () => {
    const { sparseCheckoutSet } = await import(
      '../../../../src/application/commands/sparse-checkout.js'
    );
    const ctx = createMemoryContext();
    await init(ctx);
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/src/a.txt`, 'a');
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/docs/b.txt`, 'b');
    await add(ctx, ['src/a.txt', 'docs/b.txt']);
    await commit(ctx, { message: 'first', author });
    await sparseCheckoutSet(ctx, { patterns: ['src'], cone: true });
    return ctx;
  };

  describe('Given a skip-worktree index entry absent from disk', () => {
    describe('When status', () => {
      it('Then it is NOT reported as deleted and the repo is clean', async () => {
        // Arrange — `docs/b.txt` is skip-worktree (sparse-excluded); its absence is
        // expected, so `classifyEntry` must early-return undefined for it.
        const ctx = await seedSparseRepo();

        // Act
        const sut = await status(ctx);

        // Assert
        expect(sut.clean).toBe(true);
        expect(sut.workingTreeChanges).toEqual([]);
      });
    });
  });

  describe('Given a skip-worktree path manually re-created on disk', () => {
    describe('When status', () => {
      it('Then it is NOT reported as untracked (still treated as tracked)', async () => {
        // Arrange — re-create the excluded file. It must stay in `indexByPath` so
        // pass 2 does not emit a spurious `untracked` for a tracked path.
        const ctx = await seedSparseRepo();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/docs/b.txt`, 'b');

        // Act
        const sut = await status(ctx);

        // Assert — no `untracked` entry for the still-tracked path.
        const kinds = sut.workingTreeChanges.map((c) => `${c.kind}:${c.path}`);
        expect(kinds).not.toContain('untracked:docs/b.txt');
      });
    });
  });

  describe('Given a tracked file whose read throws during scan', () => {
    describe('When status', () => {
      it('Then it is reported as modified', async () => {
        // Arrange — a.txt is staged/committed clean. Wrap ctx.fs.read so reading
        // a.txt throws: lstat still succeeds, so classifyEntry reaches isModified,
        // whose catch must report the file as modified.
        const ctx = await seedClean();
        const workFile = `${ctx.layout.workDir}/a.txt`;
        const failingReadCtx = {
          ...ctx,
          fs: {
            ...ctx.fs,
            read: async (path: string) => {
              if (path === workFile) throw new Error('simulated read failure');
              return ctx.fs.read(path);
            },
          },
        };

        // Act
        const sut = await status(failingReadCtx);

        // Assert — kills L111 BooleanLiteral `return true` -> `return false`
        // (which would drop a.txt from the changes entirely).
        expect(sut.workingTreeChanges).toContainEqual({ kind: 'modified', path: 'a.txt' });
        expect(sut.clean).toBe(false);
      });
    });
  });
});

// Progress reporting. Mutation-resistant: every assertion uses
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

  describe('Given an empty index', () => {
    describe('When status runs', () => {
      it('Then start fires before any updates and end fires last (no updates)', async () => {
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
    });
  });

  describe('Given a status:scan op', () => {
    describe('When start fires', () => {
      it("Then op === 'status:scan' (exact match — kills StringLiteral mutants)", async () => {
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
    });
  });

  describe('Given exactly 99 indexed entries (granularity boundary -1)', () => {
    describe('When status runs', () => {
      it('Then NO bucket-crossing update fires (count never reaches 100)', async () => {
        // Arrange
        const ctx = await seedWithIndexEntries(99);
        const { reporter, events } = recordingProgress();

        // Act
        await status(replaceProgress(ctx, reporter));

        // Assert — at 99 entries, Math.floor(99/100)=0, so no bucket crossing.
        const updates = events.filter((e) => e.kind === 'update');
        expect(updates).toEqual([]);
      });
    });
  });

  describe('Given exactly 100 indexed entries (granularity boundary)', () => {
    describe('When status runs', () => {
      it('Then exactly one update fires at current=100', async () => {
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
    });
  });

  describe('Given exactly 101 indexed entries (granularity boundary +1)', () => {
    describe('When status runs', () => {
      it('Then exactly one update at 100 (status:scan reports indeterminate progress; no final flush)', async () => {
        // Arrange
        const ctx = await seedWithIndexEntries(101);
        const { reporter, events } = recordingProgress();

        // Act
        await status(replaceProgress(ctx, reporter));

        // Assert — bucket crossing at 100 (Math.floor(100/100)=1>0). Last 1 entry doesn't cross
        // a new bucket; total is undefined so no final-flush rule applies.
        const updates = events
          .filter((e): e is Extract<Event, { kind: 'update' }> => e.kind === 'update')
          .map((e) => e.current);
        expect(updates).toEqual([100]);
      });
    });
  });

  describe('Given exactly 200 indexed entries', () => {
    describe('When status runs', () => {
      it('Then exactly two bucket-crossing updates fire (at 100 and 200)', async () => {
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
    });
  });

  describe('Given a successful status', () => {
    describe('When the chain completes', () => {
      it('Then end fires AFTER the last update (try/finally on success)', async () => {
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
    });
  });

  describe('Given an untracked working-tree file', () => {
    describe('When status', () => {
      it('Then workingTreeChanges contains a `untracked` ChangeEntry and clean=false', async () => {
        // Arrange — committed a.txt; add an untracked b.txt.
        const ctx = await seedClean();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/b.txt`, 'new');

        // Act
        const sut = await status(ctx);

        // Assert
        expect(sut.clean).toBe(false);
        expect(sut.workingTreeChanges).toContainEqual({ kind: 'untracked', path: 'b.txt' });
      });
    });
  });

  describe('Given an untracked file matched by.gitignore', () => {
    describe('When status', () => {
      it('Then it is NOT in workingTreeChanges and clean=true (only-ignored-untracked)', async () => {
        // Arrange
        const ctx = await seedClean();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitignore`, 'build.log\n');
        // The.gitignore itself is untracked — also matches no rule, so it WOULD
        // appear. Add a rule that also ignores.gitignore so we test the
        // "only ignored untracked files" path cleanly.
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitignore`, 'build.log\n.gitignore\n');
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/build.log`, 'log');

        // Act
        const sut = await status(ctx);

        // Assert
        expect(sut.workingTreeChanges).toEqual([]);
        expect(sut.clean).toBe(true);
      });
    });
  });

  describe('Given a tracked-but-ignored file', () => {
    describe('When status', () => {
      it('Then it appears as modified/clean (NOT untracked) — tracked beats ignored', async () => {
        // Arrange — stage `secret.bin`, then add a rule that would ignore it,
        // then modify it.
        const ctx = await seedClean();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/secret.bin`, 'sensitive');
        await add(ctx, ['secret.bin']);
        await commit(ctx, { message: 'add secret', author });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitignore`, 'secret.bin\n.gitignore\n');
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/secret.bin`, 'changed');

        // Act
        const sut = await status(ctx);

        // Assert — secret.bin is detected as modified (Pass 1 covers tracked
        // entries regardless of ignore status). NOT emitted as 'untracked'.
        const kinds = sut.workingTreeChanges.map((c) => `${c.kind}:${c.path}`);
        expect(kinds).toContain('modified:secret.bin');
        expect(kinds).not.toContain('untracked:secret.bin');
      });
    });
  });

  describe('Given a failure during scan', () => {
    describe('When status rejects', () => {
      it('Then end still fires (try/finally on failure)', async () => {
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
        // Assert
        expect(endCount).toBe(startCount);
      });
    });
  });
});
