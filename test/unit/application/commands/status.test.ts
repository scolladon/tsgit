import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { branchCreate } from '../../../../src/application/commands/branch.js';
import { checkout } from '../../../../src/application/commands/checkout.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import { mergeRun } from '../../../../src/application/commands/merge.js';
import { rm } from '../../../../src/application/commands/rm.js';
import {
  type ChangedPath,
  type StatusResult,
  status,
  toStagedKind,
  toUnstagedKind,
} from '../../../../src/application/commands/status.js';
import { invalidateConfigCache } from '../../../../src/application/primitives/config-read.js';
import type { DiffChange } from '../../../../src/domain/diff/index.js';
import type { TsgitError } from '../../../../src/domain/error.js';
import type {
  AuthorIdentity,
  FileMode,
  FilePath,
  ObjectId,
} from '../../../../src/domain/objects/index.js';

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

/** The single `changes` record for a path, or undefined if the path is clean. */
const changeFor = (sut: StatusResult, path: string): ChangedPath | undefined =>
  sut.changes.find((c) => c.path === path);

describe('status', () => {
  describe('Given a clean repo', () => {
    describe('When status', () => {
      it('Then clean=true and no changes/untracked', async () => {
        // Arrange
        const ctx = await seedClean();

        // Act
        const sut = await status(ctx);

        // Assert
        expect(sut.clean).toBe(true);
        expect(sut.changes).toEqual([]);
        expect(sut.untracked).toEqual([]);
        expect(sut.branch).toBe('refs/heads/main');
      });
    });
  });

  describe('Given a modified working file', () => {
    describe('When status', () => {
      it('Then changes carries an unstaged-modified record with head==index endpoints', async () => {
        // Arrange — a.txt committed, then edited on disk (index still matches HEAD).
        const ctx = await seedClean();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'modified');

        // Act
        const sut = await status(ctx);

        // Assert — `.M` shape: unstaged modify, staged unchanged → head equals index.
        expect(sut.clean).toBe(false);
        const c = changeFor(sut, 'a.txt');
        expect(c?.unstaged).toBe('modified');
        expect(c?.staged).toBeUndefined();
        expect(c?.head?.id).toBe(c?.index?.id);
        expect(c?.index?.mode).toBe('100644');
        expect(c?.worktree?.mode).toBe('100644');
      });
    });
  });

  describe('Given a deleted working file', () => {
    describe('When status', () => {
      it('Then changes carries an unstaged-deleted record with no worktree side', async () => {
        // Arrange
        const ctx = await seedClean();
        await ctx.fs.rm(`${ctx.layout.workDir}/a.txt`);

        // Act
        const sut = await status(ctx);

        // Assert — ` D` shape: the working file is gone, so no `worktree`.
        const c = changeFor(sut, 'a.txt');
        expect(c?.unstaged).toBe('deleted');
        expect(c?.index?.mode).toBe('100644');
        expect(c?.worktree).toBeUndefined();
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

        // Assert — kills the `head.kind === 'direct'` EqualityOperator flip.
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

        // Assert
        expect(sut.detached).toBe(true);
        expect(sut.branch).toBeUndefined();
      });
    });
  });

  describe('Given three untracked files added out of order', () => {
    describe('When status', () => {
      it('Then untracked is sorted ascending by path', async () => {
        // Arrange — write in a deliberately non-sorted, non-reversed order so a
        // dropped `.sort()` yields the insertion order `['u3','u1','u2']`, which
        // differs from both ascending and descending.
        const ctx = await seedClean();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/u3.txt`, '3');
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/u1.txt`, '1');
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/u2.txt`, '2');

        // Act
        const sut = await status(ctx);

        // Assert — kills the dropped-sort and comparator-flip mutants.
        expect(sut.untracked).toEqual(['u1.txt', 'u2.txt', 'u3.txt']);
      });
    });
  });

  describe('Given untracked files added in descending order', () => {
    describe('When status', () => {
      it('Then untracked is sorted ascending', async () => {
        // Arrange — pure descending insertion: a dropped sort or a flipped
        // comparator would leave `['u3','u2','u1']`.
        const ctx = await seedClean();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/u3.txt`, '3');
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/u2.txt`, '2');
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/u1.txt`, '1');

        // Act
        const sut = await status(ctx);

        // Assert — kills the comparator's `< ` -> `>= ` mutant.
        expect(sut.untracked).toEqual(['u1.txt', 'u2.txt', 'u3.txt']);
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
        // expected, so the working pass must skip it.
        const ctx = await seedSparseRepo();

        // Act
        const sut = await status(ctx);

        // Assert
        expect(sut.clean).toBe(true);
        expect(sut.changes).toEqual([]);
      });
    });
  });

  describe('Given a skip-worktree path manually re-created on disk', () => {
    describe('When status', () => {
      it('Then it is NOT reported as untracked (still treated as tracked)', async () => {
        // Arrange — re-create the excluded file. It must stay tracked so the
        // untracked pass does not emit a spurious entry for it.
        const ctx = await seedSparseRepo();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/docs/b.txt`, 'b');

        // Act
        const sut = await status(ctx);

        // Assert — no `untracked` entry for the still-tracked path.
        expect(sut.untracked).not.toContain('docs/b.txt');
      });
    });
  });

  describe('Given a tracked file whose read throws during scan', () => {
    describe('When status', () => {
      it('Then it is reported as unstaged-modified', async () => {
        // Arrange — a.txt is staged/committed clean. Wrap ctx.fs.read so reading
        // a.txt throws: lstat still succeeds, so the comparison reaches the hash
        // step, whose catch must report the file as modified.
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

        // Assert — kills the catch's BooleanLiteral mutant (would drop a.txt).
        expect(changeFor(sut, 'a.txt')?.unstaged).toBe('modified');
        expect(sut.clean).toBe(false);
      });
    });
  });
});

describe('status — staged column (index-vs-HEAD)', () => {
  describe('Given a file added to the index but not committed', () => {
    describe('When status', () => {
      it('Then the record is staged-added with an index side and no head', async () => {
        // Arrange — HEAD has a.txt; stage a new b.txt without committing.
        const ctx = await seedClean();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/b.txt`, 'b');
        await add(ctx, ['b.txt']);

        // Act
        const sut = await status(ctx);

        // Assert — `A ` shape: staged add only; b.txt matches the index on disk.
        const c = changeFor(sut, 'b.txt');
        expect(c?.staged).toBe('added');
        expect(c?.unstaged).toBeUndefined();
        expect(c?.head).toBeUndefined();
        expect(c?.index?.mode).toBe('100644');
        expect(c?.worktree?.mode).toBe('100644');
        expect(sut.clean).toBe(false);
      });
    });
  });

  describe('Given a committed file restaged with new content', () => {
    describe('When status', () => {
      it('Then the record is staged-modified with divergent head/index blobs', async () => {
        // Arrange — a.txt committed, then changed and staged; worktree == index.
        const ctx = await seedClean();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'changed');
        await add(ctx, ['a.txt']);

        // Act
        const sut = await status(ctx);

        // Assert — `M ` shape: staged modify, no working-tree column; head≠index.
        const c = changeFor(sut, 'a.txt');
        expect(c?.staged).toBe('modified');
        expect(c?.unstaged).toBeUndefined();
        expect(c?.head?.id).not.toBe(c?.index?.id);
      });
    });
  });

  describe('Given a committed file removed from the index and disk', () => {
    describe('When status', () => {
      it('Then the record is staged-deleted with a head side and nothing untracked', async () => {
        // Arrange — `rm` stages the deletion and removes the working file.
        const ctx = await seedClean();
        await rm(ctx, ['a.txt']);

        // Act
        const sut = await status(ctx);

        // Assert — `D ` shape: head present, index/worktree absent.
        const c = changeFor(sut, 'a.txt');
        expect(c?.staged).toBe('deleted');
        expect(c?.head?.mode).toBe('100644');
        expect(c?.index).toBeUndefined();
        expect(c?.worktree).toBeUndefined();
        expect(sut.untracked).toEqual([]);
      });
    });
  });

  describe('Given a committed file removed from the index but kept on disk', () => {
    describe('When status', () => {
      it('Then it is staged-deleted in changes AND listed as untracked (git D + ??)', async () => {
        // Arrange — `rm --cached` drops it from the index, leaving the file on disk.
        const ctx = await seedClean();
        await rm(ctx, ['a.txt'], { cached: true });

        // Act
        const sut = await status(ctx);

        // Assert — two clean sources: a staged delete and the untracked on-disk file.
        const c = changeFor(sut, 'a.txt');
        expect(c?.staged).toBe('deleted');
        expect(c?.head?.mode).toBe('100644');
        expect(c?.index).toBeUndefined();
        expect(sut.untracked).toContain('a.txt');
      });
    });
  });

  describe('Given a file modified in the index and then again in the working tree', () => {
    describe('When status', () => {
      it('Then one record carries both columns with all three sides (git MM)', async () => {
        // Arrange — stage one change, then edit on disk again so worktree != index.
        const ctx = await seedClean();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'staged');
        await add(ctx, ['a.txt']);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'worktree');

        // Act
        const sut = await status(ctx);

        // Assert — `MM`: staged and unstaged on one record, head/index/worktree all set.
        const c = changeFor(sut, 'a.txt');
        expect(c?.staged).toBe('modified');
        expect(c?.unstaged).toBe('modified');
        expect(c?.head?.id).not.toBe(c?.index?.id);
        expect(c?.worktree?.mode).toBe('100644');
      });
    });
  });

  describe('Given a staged type change (regular file becomes a symlink)', () => {
    describe('When status', () => {
      it('Then the staged column reports type-changed with mode 100644→120000 (git T)', async () => {
        // Arrange — commit a regular a.txt, then replace it with a symlink and stage.
        const ctx = await seedClean();
        await ctx.fs.rm(`${ctx.layout.workDir}/a.txt`);
        await ctx.fs.symlink('elsewhere', `${ctx.layout.workDir}/a.txt`);
        await add(ctx, ['a.txt']);

        // Act
        const sut = await status(ctx);

        // Assert — a kind change is git's `T`; the side modes capture it.
        const c = changeFor(sut, 'a.txt');
        expect(c?.staged).toBe('type-changed');
        expect(c?.head?.mode).toBe('100644');
        expect(c?.index?.mode).toBe('120000');
        expect(c?.worktree?.mode).toBe('120000');
      });
    });
  });

  describe('Given an unborn HEAD with staged files', () => {
    describe('When status', () => {
      it('Then every staged entry is added with no head side', async () => {
        // Arrange — init, stage two files, never commit (HEAD unborn → empty tree).
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/b.txt`, 'b');
        await add(ctx, ['a.txt', 'b.txt']);

        // Act
        const sut = await status(ctx);

        // Assert — both `added` against the empty HEAD tree, no head blobs.
        expect(sut.changes.map((c) => c.path)).toEqual(['a.txt', 'b.txt']);
        for (const c of sut.changes) {
          expect(c.staged).toBe('added');
          expect(c.head).toBeUndefined();
          expect(c.index?.mode).toBe('100644');
        }
      });
    });
  });

  describe('Given a clean repo', () => {
    describe('When status', () => {
      it('Then changes is empty and clean is true', async () => {
        // Arrange
        const ctx = await seedClean();

        // Act
        const sut = await status(ctx);

        // Assert
        expect(sut.changes).toEqual([]);
        expect(sut.clean).toBe(true);
      });
    });
  });

  describe('Given staged changes whose union order is not byte-sorted', () => {
    describe('When status', () => {
      it('Then changes is sorted ascending by path', async () => {
        // Arrange — HEAD {a.txt}; remove a.txt (index-empty), then stage z.txt. The
        // index-vs-tree union visits z before a, so a dropped sort would yield [z, a].
        const ctx = await seedClean();
        await rm(ctx, ['a.txt']);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/z.txt`, 'z');
        await add(ctx, ['z.txt']);

        // Act
        const sut = await status(ctx);

        // Assert — byte order: a.txt (deleted) before z.txt (added).
        expect(sut.changes.map((c) => `${c.path}:${c.staged}`)).toEqual([
          'a.txt:deleted',
          'z.txt:added',
        ]);
      });
    });
  });

  describe('Given a staged change on a late path and a working-only change on an early path', () => {
    describe('When status', () => {
      it('Then changes is byte-sorted even though the union starts staged-first', async () => {
        // Arrange — HEAD {a.txt, z.txt}. Stage a modify to z.txt (staged column)
        // and modify a.txt on disk only (working column). The change set is built
        // from the staged keys first, so the pre-sort union is [z.txt, a.txt]; a
        // dropped sort would surface that order.
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/z.txt`, 'z');
        await add(ctx, ['a.txt', 'z.txt']);
        await commit(ctx, { message: 'base', author });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/z.txt`, 'z2');
        await add(ctx, ['z.txt']);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a2');

        // Act
        const sut = await status(ctx);

        // Assert — byte order a.txt (unstaged) before z.txt (staged).
        expect(sut.changes.map((c) => `${c.path}:${c.staged ?? '-'}:${c.unstaged ?? '-'}`)).toEqual(
          ['a.txt:-:modified', 'z.txt:modified:-'],
        );
      });
    });
  });

  describe('Given a corrupt index', () => {
    describe('When status', () => {
      it('Then it propagates the index error instead of fabricating deletions', async () => {
        // Arrange — overwrite the index with bytes too short to be valid. A
        // swallowed error would fabricate an empty index and report every committed
        // path as a spurious staged deletion; status must surface the error.
        const ctx = await seedClean();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/index`, 'corrupt');

        // Act / Assert
        try {
          await status(ctx);
          expect.unreachable('status should reject a corrupt index');
        } catch (err) {
          expect((err as { data: { code: string } }).data.code).toBe('INVALID_INDEX_HEADER');
        }
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

        // Assert — bucket crossing at 100 (Math.floor(100/100)=1>0). Last 1 entry
        // doesn't cross a new bucket; total is undefined so no final-flush rule applies.
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
      it('Then untracked contains the path and clean=false', async () => {
        // Arrange — committed a.txt; add an untracked b.txt.
        const ctx = await seedClean();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/b.txt`, 'new');

        // Act
        const sut = await status(ctx);

        // Assert
        expect(sut.clean).toBe(false);
        expect(sut.untracked).toContain('b.txt');
      });
    });
  });

  describe('Given an untracked file matched by .gitignore', () => {
    describe('When status', () => {
      it('Then it is NOT untracked and clean=true (only-ignored-untracked)', async () => {
        // Arrange
        const ctx = await seedClean();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitignore`, 'build.log\n');
        // The .gitignore itself is untracked — add a rule ignoring it too so we test
        // the "only ignored untracked files" path cleanly.
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitignore`, 'build.log\n.gitignore\n');
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/build.log`, 'log');

        // Act
        const sut = await status(ctx);

        // Assert
        expect(sut.untracked).toEqual([]);
        expect(sut.changes).toEqual([]);
        expect(sut.clean).toBe(true);
      });
    });
  });

  describe('Given a tracked-but-ignored file', () => {
    describe('When status', () => {
      it('Then it appears as unstaged-modified (NOT untracked) — tracked beats ignored', async () => {
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

        // Assert — the working pass covers tracked entries regardless of ignore status.
        expect(changeFor(sut, 'secret.bin')?.unstaged).toBe('modified');
        expect(sut.untracked).not.toContain('secret.bin');
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

  describe('Given a tracked symlink replaced by a regular file with identical bytes', () => {
    describe('When status', () => {
      it('Then it reports the path unstaged type-changed (symlink → file is git T)', async () => {
        // Arrange — the symlink blob is its target string; a regular file holding
        // those same bytes hashes identically, so only the file kind differs.
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.symlink('target-content', `${ctx.layout.workDir}/link`);
        await add(ctx, ['link']);
        await ctx.fs.rm(`${ctx.layout.workDir}/link`);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/link`, 'target-content');

        // Act
        const sut = await status(ctx);

        // Assert
        const c = changeFor(sut, 'link');
        expect(c?.unstaged).toBe('type-changed');
        expect(c?.worktree?.mode).toBe('100644');
      });
    });
  });
});

describe('toStagedKind', () => {
  const oid = (s: string): ObjectId => s as ObjectId;
  const path = (s: string): FilePath => s as FilePath;
  const REGULAR = '100644' as FileMode;
  const EXEC = '100755' as FileMode;
  const SYMLINK = '120000' as FileMode;

  describe('Given an add change', () => {
    describe('When projected to a staged kind', () => {
      it("Then it is 'added'", () => {
        // Arrange
        const change: DiffChange = {
          type: 'add',
          newPath: path('a.txt'),
          newId: oid('aaa'),
          newMode: REGULAR,
        };

        // Act / Assert
        expect(toStagedKind(change)).toBe('added');
      });
    });
  });

  describe('Given a delete change', () => {
    describe('When projected to a staged kind', () => {
      it("Then it is 'deleted'", () => {
        // Arrange
        const change: DiffChange = {
          type: 'delete',
          oldPath: path('a.txt'),
          oldId: oid('aaa'),
          oldMode: REGULAR,
        };

        // Act / Assert
        expect(toStagedKind(change)).toBe('deleted');
      });
    });
  });

  describe('Given a type-change', () => {
    describe('When projected to a staged kind', () => {
      it("Then it is 'type-changed' (git T)", () => {
        // Arrange — regular file became a symlink in the index.
        const change: DiffChange = {
          type: 'type-change',
          path: path('a.txt'),
          oldId: oid('aaa'),
          newId: oid('bbb'),
          oldMode: REGULAR,
          newMode: SYMLINK,
        };

        // Act / Assert
        expect(toStagedKind(change)).toBe('type-changed');
      });
    });
  });

  describe('Given a modify change whose blob id is unchanged', () => {
    describe('When projected to a staged kind', () => {
      it("Then it is 'mode-changed' (same blob, exec bit flipped)", () => {
        // Arrange — identical oid, mode promoted to executable.
        const change: DiffChange = {
          type: 'modify',
          path: path('a.txt'),
          oldId: oid('aaa'),
          newId: oid('aaa'),
          oldMode: REGULAR,
          newMode: EXEC,
        };

        // Act / Assert
        expect(toStagedKind(change)).toBe('mode-changed');
      });
    });
  });

  describe('Given a modify change whose blob id differs', () => {
    describe('When projected to a staged kind', () => {
      it("Then it is 'modified' (content change)", () => {
        // Arrange — different oid (content edit).
        const change: DiffChange = {
          type: 'modify',
          path: path('a.txt'),
          oldId: oid('aaa'),
          newId: oid('bbb'),
          oldMode: REGULAR,
          newMode: REGULAR,
        };

        // Act / Assert
        expect(toStagedKind(change)).toBe('modified');
      });
    });
  });
});

describe('toUnstagedKind', () => {
  describe('Given each working-tree comparison', () => {
    describe('When projected to an unstaged kind', () => {
      it("Then 'absent' is deleted", () => {
        // Arrange / Act
        const sut = toUnstagedKind('absent');
        // Assert
        expect(sut).toBe('deleted');
      });

      it("Then 'type-changed' is type-changed", () => {
        // Arrange / Act
        const sut = toUnstagedKind('type-changed');
        // Assert
        expect(sut).toBe('type-changed');
      });

      it("Then 'mode-changed' is mode-changed", () => {
        // Arrange / Act
        const sut = toUnstagedKind('mode-changed');
        // Assert
        expect(sut).toBe('mode-changed');
      });

      it("Then 'modified' is modified", () => {
        // Arrange / Act
        const sut = toUnstagedKind('modified');
        // Assert
        expect(sut).toBe('modified');
      });

      it("Then 'unchanged' yields no kind", () => {
        // Arrange / Act
        const sut = toUnstagedKind('unchanged');
        // Assert
        expect(sut).toBeUndefined();
      });
    });
  });
});

// Mirror merge.test.ts's content/content conflict to leave stages 1/2/3 in the
// index for `file.txt` (git porcelain `UU`).
const seedConflict = async () => {
  const ctx = createMemoryContext();
  await init(ctx);
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file.txt`, 'shared\n');
  await add(ctx, ['file.txt']);
  await commit(ctx, { message: 'base', author });
  await branchCreate(ctx, { name: 'feature' });
  await checkout(ctx, { rev: 'feature' });
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file.txt`, 'FEATURE-CHANGE\n');
  await add(ctx, ['file.txt']);
  await commit(ctx, { message: 'on-feature', author });
  await checkout(ctx, { rev: 'main' });
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file.txt`, 'MAIN-CHANGE\n');
  await add(ctx, ['file.txt']);
  await commit(ctx, { message: 'on-main', author });
  await mergeRun(ctx, { rev: 'feature', author });
  return ctx;
};

describe('status — unmerged column', () => {
  describe('Given a conflicted index (both sides modified the same file)', () => {
    describe('When status', () => {
      it('Then the path is reported as both-modified with all three stage blobs', async () => {
        // Arrange
        const ctx = await seedConflict();

        // Act
        const sut = await status(ctx);

        // Assert — one unmerged entry carrying base/ours/theirs blobs.
        expect(sut.unmerged).toHaveLength(1);
        const entry = sut.unmerged[0];
        expect(entry?.kind).toBe('both-modified');
        expect(entry?.path).toBe('file.txt');
        expect(entry?.base?.mode).toBe('100644');
        expect(entry?.ours?.mode).toBe('100644');
        expect(entry?.theirs?.mode).toBe('100644');
        // ours and theirs are the divergent blobs (distinct from each other and base).
        expect(entry?.ours?.id).not.toBe(entry?.theirs?.id);
        expect(entry?.base?.id).not.toBe(entry?.ours?.id);
      });

      it('Then the conflicted path is absent from changes and untracked', async () => {
        // Arrange
        const ctx = await seedConflict();

        // Act
        const sut = await status(ctx);

        // Assert — git lists an unmerged path only under "Unmerged paths".
        expect(sut.changes.map((c) => c.path)).not.toContain('file.txt');
        expect(sut.untracked).not.toContain('file.txt');
      });

      it('Then the repo is not clean', async () => {
        // Arrange
        const ctx = await seedConflict();

        // Act
        const sut = await status(ctx);

        // Assert
        expect(sut.clean).toBe(false);
      });
    });
  });

  describe('Given a conflicted file present on disk', () => {
    describe('When status', () => {
      it('Then the entry carries a worktree side with the on-disk mode (mW)', async () => {
        // Arrange — the merge leaves file.txt (with conflict markers) on disk.
        const ctx = await seedConflict();

        // Act
        const sut = await status(ctx);

        // Assert — mW is the on-disk regular-file mode; stages stay intact.
        const entry = sut.unmerged[0];
        expect(entry?.path).toBe('file.txt');
        expect(entry?.worktree?.mode).toBe('100644');
        expect(entry?.base).toBeDefined();
        expect(entry?.ours).toBeDefined();
        expect(entry?.theirs).toBeDefined();
      });
    });
  });

  describe('Given a conflicted file removed from disk', () => {
    describe('When status', () => {
      it('Then the worktree side is omitted while the stage blobs remain', async () => {
        // Arrange — remove the conflicted file from the working tree (git's mW=000000).
        const ctx = await seedConflict();
        await ctx.fs.rm(`${ctx.layout.workDir}/file.txt`);

        // Act
        const sut = await status(ctx);

        // Assert — no worktree side, but the index stages are still reported.
        const entry = sut.unmerged[0];
        expect(entry?.path).toBe('file.txt');
        expect(entry?.worktree).toBeUndefined();
        expect(entry?.base).toBeDefined();
        expect(entry?.ours).toBeDefined();
        expect(entry?.theirs).toBeDefined();
      });
    });
  });

  describe('Given a modify/delete conflict (one side modifies, the other deletes)', () => {
    describe('When status', () => {
      it('Then it is deleted-by-them with the base and ours stages but no theirs', async () => {
        // Arrange — main modifies file.txt, feature deletes it → stages 1 (base)
        // and 2 (ours) only, no stage 3 (theirs); git porcelain `UD`.
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file.txt`, 'shared\n');
        await add(ctx, ['file.txt']);
        await commit(ctx, { message: 'base', author });
        await branchCreate(ctx, { name: 'feature' });
        await checkout(ctx, { rev: 'feature' });
        await rm(ctx, ['file.txt']);
        await commit(ctx, { message: 'delete', author });
        await checkout(ctx, { rev: 'main' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file.txt`, 'MAIN\n');
        await add(ctx, ['file.txt']);
        await commit(ctx, { message: 'modify', author });
        await mergeRun(ctx, { rev: 'feature', author });

        // Act
        const sut = await status(ctx);

        // Assert — UD: base + ours present, theirs omitted.
        expect(sut.unmerged).toHaveLength(1);
        const entry = sut.unmerged[0];
        expect(entry?.kind).toBe('deleted-by-them');
        expect(entry?.path).toBe('file.txt');
        expect(entry?.base).toBeDefined();
        expect(entry?.ours).toBeDefined();
        expect(entry?.theirs).toBeUndefined();
      });
    });
  });

  describe('Given two conflicting files merged out of insertion order', () => {
    describe('When status', () => {
      it('Then the unmerged entries are byte-ordered by path', async () => {
        // Arrange — conflict on z.txt and a.txt; assert byte order (a before z).
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/z.txt`, 'shared\n');
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'shared\n');
        await add(ctx, ['z.txt', 'a.txt']);
        await commit(ctx, { message: 'base', author });
        await branchCreate(ctx, { name: 'feature' });
        await checkout(ctx, { rev: 'feature' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/z.txt`, 'FEATURE\n');
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'FEATURE\n');
        await add(ctx, ['z.txt', 'a.txt']);
        await commit(ctx, { message: 'on-feature', author });
        await checkout(ctx, { rev: 'main' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/z.txt`, 'MAIN\n');
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'MAIN\n');
        await add(ctx, ['z.txt', 'a.txt']);
        await commit(ctx, { message: 'on-main', author });
        await mergeRun(ctx, { rev: 'feature', author });

        // Act
        const sut = await status(ctx);

        // Assert
        expect(sut.unmerged.map((u) => u.path)).toEqual(['a.txt', 'z.txt']);
      });
    });
  });

  describe('Given a clean repo', () => {
    describe('When status', () => {
      it('Then the unmerged column is empty', async () => {
        // Arrange
        const ctx = await seedClean();

        // Act
        const sut = await status(ctx);

        // Assert
        expect(sut.unmerged).toEqual([]);
      });
    });
  });
});

describe('status — valueless core path-like refusal', () => {
  describe('Given a repo with a valueless core.excludesFile', () => {
    describe('When status', () => {
      it('Then it throws CONFIG_MISSING_VALUE for core.excludesfile', async () => {
        // Arrange
        const ctx = await seedClean();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[core]\n\texcludesFile\n');
        invalidateConfigCache(ctx);
        const sut = status;

        // Act
        let caught: unknown;
        try {
          await sut(ctx);
        } catch (err) {
          caught = err;
        }

        // Assert — each field individually (mutation-resistant)
        const data = (caught as TsgitError).data as {
          code: string;
          key: string;
          line: number;
        };
        expect(data.code).toBe('CONFIG_MISSING_VALUE');
        expect(data.key).toBe('core.excludesfile');
        expect(data.line).toBe(2);
      });
    });
  });
});
