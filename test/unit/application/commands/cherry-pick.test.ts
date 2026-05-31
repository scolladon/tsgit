import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { branchCreate } from '../../../../src/application/commands/branch.js';
import { checkout } from '../../../../src/application/commands/checkout.js';
import {
  cherryPickAbort,
  cherryPickContinue,
  cherryPickRun,
  cherryPickSkip,
} from '../../../../src/application/commands/cherry-pick.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import { bindCherryPickNamespace } from '../../../../src/application/commands/internal/cherry-pick-namespace.js';
import { writeMergeHead } from '../../../../src/application/commands/internal/merge-state.js';
import { merge } from '../../../../src/application/commands/merge.js';
import { createCommit } from '../../../../src/application/primitives/create-commit.js';
import { readIndex } from '../../../../src/application/primitives/read-index.js';
import { readObject } from '../../../../src/application/primitives/read-object.js';
import { readReflog } from '../../../../src/application/primitives/reflog-store.js';
import { resolveRef } from '../../../../src/application/primitives/resolve-ref.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { writeTree } from '../../../../src/application/primitives/write-tree.js';
import type { TsgitError } from '../../../../src/domain/error.js';
import { FILE_MODE } from '../../../../src/domain/objects/file-mode.js';
import type {
  AuthorIdentity,
  CommitData,
  ObjectId,
  RefName,
} from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';

const COMMITTER: AuthorIdentity = {
  name: 'Picker',
  email: 'pick@x',
  timestamp: 5,
  timezoneOffset: '+0000',
};
const FEAT_AUTHOR: AuthorIdentity = {
  name: 'Feat',
  email: 'feat@y',
  timestamp: 100,
  timezoneOffset: '+0200',
};
const MAIN_AUTHOR: AuthorIdentity = {
  name: 'Main',
  email: 'main@z',
  timestamp: 1,
  timezoneOffset: '+0000',
};

const work = (ctx: Context, name: string): string => `${ctx.layout.workDir}/${name}`;

const setUser = (ctx: Context): Promise<void> =>
  ctx.fs.appendUtf8(`${ctx.layout.gitDir}/config`, '\n[user]\n\tname = Picker\n\temail = pick@x\n');

const readCommit = async (ctx: Context, id: ObjectId): Promise<CommitData> => {
  const obj = await readObject(ctx, id);
  if (obj.type !== 'commit') throw new Error('not a commit');
  return obj.data;
};

const codeOf = async (run: () => Promise<unknown>): Promise<string | undefined> => {
  try {
    await run();
    return undefined;
  } catch (err) {
    return (err as TsgitError).data.code;
  }
};

/** main: base.txt; feature branch off base adds feat.txt. Returns ctx + feature tip. */
const seedFeature = async (
  baseBody = 'a\nb\n',
  featBody = 'feat\n',
): Promise<{ ctx: Context; feature: ObjectId; base: ObjectId }> => {
  const ctx = createMemoryContext();
  await init(ctx);
  await setUser(ctx);
  await ctx.fs.writeUtf8(work(ctx, 'base.txt'), baseBody);
  await add(ctx, ['base.txt']);
  const base = await commit(ctx, { message: 'base', author: MAIN_AUTHOR });
  await branchCreate(ctx, { name: 'feature' });
  await checkout(ctx, { target: 'feature' });
  await ctx.fs.writeUtf8(work(ctx, 'feat.txt'), featBody);
  await add(ctx, ['feat.txt']);
  const feature = await commit(ctx, { message: 'add feat\n\nbody line', author: FEAT_AUTHOR });
  await checkout(ctx, { target: 'main' });
  return { ctx, feature: feature.id, base: base.id };
};

/** Set up a conflicting cherry-pick already in progress; returns ctx + feature id. */
const seedConflictPick = async (): Promise<{ ctx: Context; feature: ObjectId }> => {
  const ctx = createMemoryContext();
  await init(ctx);
  await setUser(ctx);
  await ctx.fs.writeUtf8(work(ctx, 'f.txt'), 'l1\nl2\n');
  await add(ctx, ['f.txt']);
  await commit(ctx, { message: 'base', author: MAIN_AUTHOR });
  await branchCreate(ctx, { name: 'feature' });
  await checkout(ctx, { target: 'feature' });
  await ctx.fs.writeUtf8(work(ctx, 'f.txt'), 'l1\nFEAT\n');
  await add(ctx, ['f.txt']);
  const feature = await commit(ctx, { message: 'feat change', author: FEAT_AUTHOR });
  await checkout(ctx, { target: 'main' });
  await ctx.fs.writeUtf8(work(ctx, 'f.txt'), 'l1\nMAIN\n');
  await add(ctx, ['f.txt']);
  await commit(ctx, { message: 'main change', author: MAIN_AUTHOR });
  await cherryPickRun(ctx, { commits: [feature.id] });
  return { ctx, feature: feature.id };
};

/** main: base; feature adds c1 (conflicts) then c2 (g.txt); main diverges. */
const seedRange = async (): Promise<{
  ctx: Context;
  base: ObjectId;
  c1: ObjectId;
  feature: ObjectId;
}> => {
  const ctx = createMemoryContext();
  await init(ctx);
  await setUser(ctx);
  await ctx.fs.writeUtf8(work(ctx, 'f.txt'), 'l1\nl2\n');
  await add(ctx, ['f.txt']);
  const base = await commit(ctx, { message: 'base', author: MAIN_AUTHOR });
  await branchCreate(ctx, { name: 'feature' });
  await checkout(ctx, { target: 'feature' });
  await ctx.fs.writeUtf8(work(ctx, 'f.txt'), 'l1\nFEAT\n');
  await add(ctx, ['f.txt']);
  const c1 = await commit(ctx, { message: 'c1 change', author: FEAT_AUTHOR });
  await ctx.fs.writeUtf8(work(ctx, 'g.txt'), 'g\n');
  await add(ctx, ['g.txt']);
  const feature = await commit(ctx, { message: 'c2 add g', author: FEAT_AUTHOR });
  await checkout(ctx, { target: 'main' });
  await ctx.fs.writeUtf8(work(ctx, 'f.txt'), 'l1\nMAIN\n');
  await add(ctx, ['f.txt']);
  await commit(ctx, { message: 'main change', author: MAIN_AUTHOR });
  return { ctx, base: base.id, c1: c1.id, feature: feature.id };
};

/** A repo where `feature` contains a merge commit, then a post-merge commit. */
const seedMerge = async (): Promise<{
  ctx: Context;
  mergeId: ObjectId;
  base: ObjectId;
}> => {
  const ctx = createMemoryContext();
  await init(ctx);
  await setUser(ctx);
  await ctx.fs.writeUtf8(work(ctx, 'base.txt'), 'base\n');
  await add(ctx, ['base.txt']);
  const base = await commit(ctx, { message: 'base', author: MAIN_AUTHOR });
  await branchCreate(ctx, { name: 'feature' });
  await checkout(ctx, { target: 'feature' });
  await ctx.fs.writeUtf8(work(ctx, 'f1.txt'), 'f1\n');
  await add(ctx, ['f1.txt']);
  await commit(ctx, { message: 'c1', author: FEAT_AUTHOR });
  await branchCreate(ctx, { name: 'side', startPoint: base.id });
  await checkout(ctx, { target: 'side' });
  await ctx.fs.writeUtf8(work(ctx, 's1.txt'), 's1\n');
  await add(ctx, ['s1.txt']);
  await commit(ctx, { message: 's1', author: FEAT_AUTHOR });
  await checkout(ctx, { target: 'feature' });
  const m = await merge(ctx, { target: 'side' });
  if (m.kind !== 'merge') throw new Error('seed: expected a merge commit');
  await ctx.fs.writeUtf8(work(ctx, 'f2.txt'), 'f2\n');
  await add(ctx, ['f2.txt']);
  await commit(ctx, { message: 'c2 post-merge', author: FEAT_AUTHOR });
  await checkout(ctx, { target: 'main' });
  return { ctx, mergeId: m.id, base: base.id };
};

describe('cherryPickRun — merge commits', () => {
  describe('Given a single merge commit to pick', () => {
    describe('When run without -m', () => {
      it('Then refuses with CHERRY_PICK_MERGE_NO_MAINLINE and persists no state', async () => {
        // Arrange
        const { ctx, mergeId } = await seedMerge();

        // Act
        const code = await codeOf(() => cherryPickRun(ctx, { commits: [mergeId] }));

        // Assert
        expect(code).toBe('CHERRY_PICK_MERGE_NO_MAINLINE');
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/CHERRY_PICK_HEAD`)).toBe(false);
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/sequencer`)).toBe(false);
      });
    });
  });

  describe('Given a range containing a merge commit', () => {
    describe('When run', () => {
      it('Then applies the earlier picks, stops at the merge with sequencer state (no CHERRY_PICK_HEAD)', async () => {
        // Arrange
        const { ctx, base } = await seedMerge();

        // Act
        const code = await codeOf(() => cherryPickRun(ctx, { commits: [`${base}..feature`] }));

        // Assert
        expect(code).toBe('CHERRY_PICK_MERGE_NO_MAINLINE');
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/CHERRY_PICK_HEAD`)).toBe(false);
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/sequencer/head`)).toBe(true);
        const todo = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/sequencer/todo`);
        expect(todo.length).toBeGreaterThan(0);
      });
    });
  });

  describe('Given a merge-stopped range', () => {
    describe('When skip drops the merge', () => {
      it('Then it resumes and applies the post-merge pick', async () => {
        // Arrange
        const { ctx, base } = await seedMerge();
        await codeOf(() => cherryPickRun(ctx, { commits: [`${base}..feature`] }));

        // Act
        const sut = await cherryPickSkip(ctx);

        // Assert
        expect(sut.kind).toBe('picked');
        expect(await ctx.fs.readUtf8(work(ctx, 'f2.txt'))).toBe('f2\n'); // post-merge pick applied
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/sequencer`)).toBe(false);
      });
    });
  });

  describe('Given --no-commit and a merge commit', () => {
    describe('When run', () => {
      it('Then refuses with CHERRY_PICK_MERGE_NO_MAINLINE', async () => {
        // Arrange
        const { ctx, mergeId } = await seedMerge();

        // Act
        const code = await codeOf(() => cherryPickRun(ctx, { commits: [mergeId], noCommit: true }));

        // Assert
        expect(code).toBe('CHERRY_PICK_MERGE_NO_MAINLINE');
      });
    });
  });
});

describe('cherryPickRun — ranges and the sequencer', () => {
  describe('Given a clean A..B range', () => {
    describe('When run', () => {
      it('Then expands oldest-first, applies each, and leaves no sequencer dir', async () => {
        // Arrange — feature: c1 (f1), c2 (f2), c3 (f3); main untouched by those files
        const ctx = createMemoryContext();
        await init(ctx);
        await setUser(ctx);
        await ctx.fs.writeUtf8(work(ctx, 'base.txt'), 'base\n');
        await add(ctx, ['base.txt']);
        const base = await commit(ctx, { message: 'base', author: MAIN_AUTHOR });
        await branchCreate(ctx, { name: 'feature' });
        await checkout(ctx, { target: 'feature' });
        for (const name of ['f1', 'f2', 'f3']) {
          await ctx.fs.writeUtf8(work(ctx, `${name}.txt`), `${name}\n`);
          await add(ctx, [`${name}.txt`]);
          await commit(ctx, { message: `add ${name}`, author: FEAT_AUTHOR });
        }
        await checkout(ctx, { target: 'main' });

        // Act
        const sut = await cherryPickRun(ctx, { commits: [`${base.id}..feature`] });

        // Assert
        expect(sut.kind).toBe('picked');
        if (sut.kind === 'picked') expect(sut.commits).toHaveLength(3);
        expect(await ctx.fs.readUtf8(work(ctx, 'f1.txt'))).toBe('f1\n');
        expect(await ctx.fs.readUtf8(work(ctx, 'f3.txt'))).toBe('f3\n');
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/sequencer`)).toBe(false);
      });
    });
  });

  describe('Given an A...B symmetric-difference range', () => {
    describe('When run', () => {
      it('Then rejects with INVALID_OPTION', async () => {
        // Arrange
        const { ctx } = await seedFeature();

        // Act
        const code = await codeOf(() => cherryPickRun(ctx, { commits: ['main...feature'] }));

        // Assert
        expect(code).toBe('INVALID_OPTION');
      });
    });
  });

  describe('Given a ^-exclusion revision form', () => {
    describe('When run', () => {
      it('Then rejects with INVALID_OPTION', async () => {
        // Arrange
        const { ctx } = await seedFeature();

        // Act
        const code = await codeOf(() => cherryPickRun(ctx, { commits: ['feature^'] }));

        // Assert
        expect(code).toBe('INVALID_OPTION');
      });
    });
  });

  describe('Given a range whose first pick conflicts', () => {
    describe('When run', () => {
      it('Then writes the git-faithful sequencer dir with the remaining picks', async () => {
        // Arrange
        const { ctx, base, c1 } = await seedRange();
        const mainHead = await resolveRef(ctx, 'refs/heads/main' as RefName);

        // Act
        const sut = await cherryPickRun(ctx, { commits: [`${base}..feature`] });

        // Assert
        expect(sut.kind).toBe('conflict');
        if (sut.kind === 'conflict') {
          expect(sut.commit).toBe(c1);
          expect(sut.remaining).toBe(1);
        }
        expect(await ctx.fs.readUtf8(`${ctx.layout.gitDir}/CHERRY_PICK_HEAD`)).toBe(`${c1}\n`);
        expect(await ctx.fs.readUtf8(`${ctx.layout.gitDir}/sequencer/head`)).toBe(`${mainHead}\n`);
        const todo = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/sequencer/todo`);
        expect(todo.split('\n').filter(Boolean)).toHaveLength(2); // c1 (current) + c2
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/sequencer/abort-safety`)).toBe(true);
      });
    });
  });

  describe('Given a divergent-branch range main..feature', () => {
    describe('When run', () => {
      it('Then excludes the shared merge-base — first pick is c1, not the shared root', async () => {
        // Arrange — `base` is reachable from both main and feature; git's
        // `main..feature` excludes it (and everything else reachable from main).
        const { ctx, c1 } = await seedRange();

        // Act
        const sut = await cherryPickRun(ctx, { commits: ['main..feature'] });

        // Assert — the sequence starts at c1 (not the parentless root `base`),
        // with only c2 remaining.
        expect(sut.kind).toBe('conflict');
        if (sut.kind === 'conflict') {
          expect(sut.commit).toBe(c1);
          expect(sut.remaining).toBe(1);
        }
        expect(await ctx.fs.readUtf8(`${ctx.layout.gitDir}/CHERRY_PICK_HEAD`)).toBe(`${c1}\n`);
        const todo = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/sequencer/todo`);
        expect(todo.split('\n').filter(Boolean)).toHaveLength(2); // c1 (current) + c2
      });
    });
  });

  describe('Given a stopped range', () => {
    describe('When the conflict is resolved and continue runs', () => {
      it('Then it finishes the remaining picks and clears the sequencer', async () => {
        // Arrange
        const { ctx, base } = await seedRange();
        await cherryPickRun(ctx, { commits: [`${base}..feature`] }); // → conflict on c1
        await ctx.fs.writeUtf8(work(ctx, 'f.txt'), 'l1\nBOTH\n');
        await add(ctx, ['f.txt']);

        // Act
        const sut = await cherryPickContinue(ctx);

        // Assert
        expect(sut.kind).toBe('picked');
        expect(await ctx.fs.readUtf8(work(ctx, 'g.txt'))).toBe('g\n'); // c2 applied
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/sequencer`)).toBe(false);
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/CHERRY_PICK_HEAD`)).toBe(false);
      });
    });
  });

  describe('Given a sequencer todo rewritten with git-style abbreviated oids', () => {
    describe('When continue resumes', () => {
      it('Then it resolves the abbreviated oids and finishes', async () => {
        // Arrange — reach a range conflict, then abbreviate the todo to 7-char oids
        const { ctx, base } = await seedRange();
        await cherryPickRun(ctx, { commits: [`${base}..feature`] });
        const todoPath = `${ctx.layout.gitDir}/sequencer/todo`;
        const abbreviated = (await ctx.fs.readUtf8(todoPath))
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            const [, oid, ...subj] = line.split(' ');
            return `pick ${(oid as string).slice(0, 7)} ${subj.join(' ')}`;
          })
          .join('\n');
        await ctx.fs.writeUtf8(todoPath, `${abbreviated}\n`);
        await ctx.fs.writeUtf8(work(ctx, 'f.txt'), 'l1\nBOTH\n');
        await add(ctx, ['f.txt']);

        // Act
        const sut = await cherryPickContinue(ctx);

        // Assert
        expect(sut.kind).toBe('picked');
        expect(await ctx.fs.readUtf8(work(ctx, 'g.txt'))).toBe('g\n');
      });
    });
  });
});

describe('bindCherryPickNamespace', () => {
  describe('Given the bound namespace', () => {
    describe('When each verb is called', () => {
      it('Then it runs the guard and forwards to the command', async () => {
        // Arrange
        const { ctx, feature } = await seedFeature();
        let guarded = 0;
        const ns = bindCherryPickNamespace(ctx, () => {
          guarded += 1;
        });

        // Act
        const run = await ns.run({ commits: [feature] });

        // Assert — run forwarded; the other verbs forward + throw (nothing in progress)
        expect(run.kind).toBe('picked');
        await expect(ns.continue()).rejects.toThrow();
        await expect(ns.skip()).rejects.toThrow();
        await expect(ns.abort()).rejects.toThrow();
        expect(guarded).toBe(4);
        expect(Object.isFrozen(ns)).toBe(true);
      });
    });
  });
});

describe('cherryPickAbort', () => {
  describe('Given a stopped range', () => {
    describe('When abort', () => {
      it('Then resets HEAD, working tree, and index to the pre-sequence commit and clears state', async () => {
        // Arrange
        const { ctx, base } = await seedRange();
        const preSeq = await resolveRef(ctx, 'refs/heads/main' as RefName);
        await cherryPickRun(ctx, { commits: [`${base}..feature`] });

        // Act
        const sut = await cherryPickAbort(ctx);

        // Assert
        expect(sut.head).toBe(preSeq);
        expect(await resolveRef(ctx, 'refs/heads/main' as RefName)).toBe(preSeq);
        expect(await ctx.fs.readUtf8(work(ctx, 'f.txt'))).toBe('l1\nMAIN\n'); // restored
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/sequencer`)).toBe(false);
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/CHERRY_PICK_HEAD`)).toBe(false);
      });
    });
  });

  describe('Given a single conflicted pick', () => {
    describe('When abort', () => {
      it('Then resets to HEAD and clears CHERRY_PICK_HEAD', async () => {
        // Arrange
        const { ctx } = await seedConflictPick();
        const headBefore = await resolveRef(ctx, 'refs/heads/main' as RefName);

        // Act
        const sut = await cherryPickAbort(ctx);

        // Assert
        expect(sut.head).toBe(headBefore);
        expect(await ctx.fs.readUtf8(work(ctx, 'f.txt'))).toBe('l1\nMAIN\n');
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/CHERRY_PICK_HEAD`)).toBe(false);
      });
    });
  });

  describe('Given nothing in progress', () => {
    describe('When abort', () => {
      it('Then refuses with NO_OPERATION_IN_PROGRESS', async () => {
        // Arrange
        const { ctx } = await seedFeature();

        // Act
        const code = await codeOf(() => cherryPickAbort(ctx));

        // Assert
        expect(code).toBe('NO_OPERATION_IN_PROGRESS');
      });
    });
  });

  describe('Given a detached HEAD mid cherry-pick', () => {
    describe('When abort', () => {
      it('Then refuses with UNSUPPORTED_OPERATION', async () => {
        // Arrange
        const { ctx, feature } = await seedConflictPick();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, `${feature}\n`);

        // Act
        const code = await codeOf(() => cherryPickAbort(ctx));

        // Assert
        expect(code).toBe('UNSUPPORTED_OPERATION');
      });
    });
  });
});

describe('cherryPickSkip', () => {
  describe('Given a stopped range', () => {
    describe('When skip', () => {
      it('Then drops the current pick and applies the remaining ones', async () => {
        // Arrange
        const { ctx, base } = await seedRange();
        await cherryPickRun(ctx, { commits: [`${base}..feature`] }); // conflict on c1

        // Act
        const sut = await cherryPickSkip(ctx);

        // Assert
        expect(sut.kind).toBe('picked');
        expect(await ctx.fs.readUtf8(work(ctx, 'g.txt'))).toBe('g\n'); // c2 applied
        expect(await ctx.fs.readUtf8(work(ctx, 'f.txt'))).toBe('l1\nMAIN\n'); // c1 dropped
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/sequencer`)).toBe(false);
      });
    });
  });

  describe('Given a single conflicted pick', () => {
    describe('When skip', () => {
      it('Then drops it and applies nothing', async () => {
        // Arrange
        const { ctx } = await seedConflictPick();

        // Act
        const sut = await cherryPickSkip(ctx);

        // Assert
        expect(sut.kind).toBe('picked');
        if (sut.kind === 'picked') expect(sut.commits).toHaveLength(0);
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/CHERRY_PICK_HEAD`)).toBe(false);
      });
    });
  });

  describe('Given nothing in progress', () => {
    describe('When skip', () => {
      it('Then refuses with NO_OPERATION_IN_PROGRESS', async () => {
        // Arrange
        const { ctx } = await seedFeature();

        // Act
        const code = await codeOf(() => cherryPickSkip(ctx));

        // Assert
        expect(code).toBe('NO_OPERATION_IN_PROGRESS');
      });
    });
  });
});

describe('cherryPickContinue', () => {
  describe('Given a resolved conflict', () => {
    describe('When continue', () => {
      it('Then commits single-parent with preserved author and "commit (cherry-pick)" reflog', async () => {
        // Arrange
        const { ctx, feature } = await seedConflictPick();
        await ctx.fs.writeUtf8(work(ctx, 'f.txt'), 'l1\nBOTH\n');
        await add(ctx, ['f.txt']);

        // Act
        const sut = await cherryPickContinue(ctx);

        // Assert
        expect(sut.kind).toBe('picked');
        if (sut.kind !== 'picked') return;
        const data = await readCommit(ctx, sut.commits[0]?.created as ObjectId);
        expect(data.author).toEqual(FEAT_AUTHOR);
        expect(data.committer.name).toBe(COMMITTER.name);
        expect(data.parents).toHaveLength(1);
        expect(data.message).toBe('feat change\n'); // # Conflicts block stripped
        expect(sut.commits[0]?.source).toBe(feature);
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/CHERRY_PICK_HEAD`)).toBe(false);
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/MERGE_MSG`)).toBe(false);
        const reflog = await readReflog(ctx, 'refs/heads/main' as RefName);
        expect(reflog.some((e) => e.message === 'commit (cherry-pick): feat change')).toBe(true);
      });
    });
  });

  describe('Given no cherry-pick in progress', () => {
    describe('When continue', () => {
      it('Then refuses with NO_OPERATION_IN_PROGRESS', async () => {
        // Arrange
        const { ctx } = await seedFeature();

        // Act
        const code = await codeOf(() => cherryPickContinue(ctx));

        // Assert
        expect(code).toBe('NO_OPERATION_IN_PROGRESS');
      });
    });
  });

  describe('Given the index still has unmerged entries', () => {
    describe('When continue', () => {
      it('Then refuses with MERGE_HAS_CONFLICTS', async () => {
        // Arrange — conflict left unresolved
        const { ctx } = await seedConflictPick();

        // Act
        const code = await codeOf(() => cherryPickContinue(ctx));

        // Assert
        expect(code).toBe('MERGE_HAS_CONFLICTS');
      });
    });
  });

  describe('Given the resolution leaves the tree unchanged', () => {
    describe('When continue without --allow-empty', () => {
      it('Then re-stops as empty', async () => {
        // Arrange — resolve back to HEAD's content (no change)
        const { ctx, feature } = await seedConflictPick();
        await ctx.fs.writeUtf8(work(ctx, 'f.txt'), 'l1\nMAIN\n');
        await add(ctx, ['f.txt']);

        // Act
        const sut = await cherryPickContinue(ctx);

        // Assert
        expect(sut.kind).toBe('empty');
        if (sut.kind === 'empty') expect(sut.commit).toBe(feature);
      });
    });

    describe('When continue with --allow-empty', () => {
      it('Then commits an empty commit', async () => {
        // Arrange
        const { ctx } = await seedConflictPick();
        await ctx.fs.writeUtf8(work(ctx, 'f.txt'), 'l1\nMAIN\n');
        await add(ctx, ['f.txt']);

        // Act
        const sut = await cherryPickContinue(ctx, { allowEmpty: true });

        // Assert
        expect(sut.kind).toBe('picked');
        if (sut.kind === 'picked') expect(sut.commits).toHaveLength(1);
      });
    });
  });
});

describe('cherryPickRun', () => {
  describe('Given a clean single pick', () => {
    describe('When run', () => {
      it('Then commits with preserved author, current committer, single parent, and reflog', async () => {
        // Arrange
        const { ctx, feature, base } = await seedFeature();

        // Act
        const sut = await cherryPickRun(ctx, { commits: ['feature'] });

        // Assert
        expect(sut.kind).toBe('picked');
        if (sut.kind !== 'picked') return;
        const created = sut.commits[0]?.created as ObjectId;
        expect(sut.commits[0]?.source).toBe(feature);
        const data = await readCommit(ctx, created);
        expect(data.author).toEqual(FEAT_AUTHOR); // preserved
        expect(data.committer.name).toBe(COMMITTER.name); // current identity
        expect(data.parents).toEqual([base]); // single parent = old HEAD
        expect(data.message).toBe('add feat\n\nbody line\n'); // preserved verbatim (source's stripspace'd form)
        expect(await resolveRef(ctx, 'refs/heads/main' as RefName)).toBe(created);
        expect(await ctx.fs.readUtf8(work(ctx, 'feat.txt'))).toBe('feat\n');
      });
    });
  });

  describe('Given recordOrigin (-x)', () => {
    describe('When run', () => {
      it('Then appends "(cherry picked from commit <full-oid>)" after a blank line', async () => {
        // Arrange
        const { ctx, feature } = await seedFeature();

        // Act
        const sut = await cherryPickRun(ctx, { commits: ['feature'], recordOrigin: true });

        // Assert
        expect(sut.kind).toBe('picked');
        if (sut.kind !== 'picked') return;
        const data = await readCommit(ctx, sut.commits[0]?.created as ObjectId);
        expect(data.message).toBe(
          `add feat\n\nbody line\n\n(cherry picked from commit ${feature})\n`,
        );
      });
    });
  });

  describe('Given two clean picks given as separate arguments', () => {
    describe('When run', () => {
      it('Then both are applied in order onto HEAD', async () => {
        // Arrange — feature has feat.txt; add a second feature commit
        const { ctx, feature } = await seedFeature();
        await checkout(ctx, { target: 'feature' });
        await ctx.fs.writeUtf8(work(ctx, 'feat2.txt'), 'feat2\n');
        await add(ctx, ['feat2.txt']);
        const second = await commit(ctx, { message: 'add feat2', author: FEAT_AUTHOR });
        await checkout(ctx, { target: 'main' });

        // Act
        const sut = await cherryPickRun(ctx, { commits: [feature, second.id] });

        // Assert
        expect(sut.kind).toBe('picked');
        if (sut.kind !== 'picked') return;
        expect(sut.commits).toHaveLength(2);
        expect(await ctx.fs.readUtf8(work(ctx, 'feat.txt'))).toBe('feat\n');
        expect(await ctx.fs.readUtf8(work(ctx, 'feat2.txt'))).toBe('feat2\n');
      });
    });
  });

  describe('Given a parentless (root) commit to pick', () => {
    describe('When run', () => {
      it('Then applies it against an empty base', async () => {
        // Arrange — a root commit (no parents) adding r.txt
        const { ctx } = await seedFeature();
        const blob = await writeObject(ctx, {
          type: 'blob',
          id: '' as ObjectId,
          content: new TextEncoder().encode('r\n'),
        });
        const rTree = await writeTree(ctx, [{ name: 'r.txt', id: blob, mode: FILE_MODE.REGULAR }]);
        const root = await createCommit(ctx, {
          tree: rTree,
          parents: [],
          author: FEAT_AUTHOR,
          committer: FEAT_AUTHOR,
          message: 'root',
          extraHeaders: [],
        });

        // Act
        const sut = await cherryPickRun(ctx, { commits: [root] });

        // Assert
        expect(sut.kind).toBe('picked');
        expect(await ctx.fs.readUtf8(work(ctx, 'r.txt'))).toBe('r\n');
      });
    });
  });

  describe('Given a pick that conflicts', () => {
    describe('When run', () => {
      it('Then stops with CHERRY_PICK_HEAD, MERGE_MSG, unmerged index, and markers', async () => {
        // Arrange — feature and main change the same line differently
        const ctx = createMemoryContext();
        await init(ctx);
        await setUser(ctx);
        await ctx.fs.writeUtf8(work(ctx, 'f.txt'), 'l1\nl2\n');
        await add(ctx, ['f.txt']);
        await commit(ctx, { message: 'base', author: MAIN_AUTHOR });
        await branchCreate(ctx, { name: 'feature' });
        await checkout(ctx, { target: 'feature' });
        await ctx.fs.writeUtf8(work(ctx, 'f.txt'), 'l1\nFEAT\n');
        await add(ctx, ['f.txt']);
        const feature = await commit(ctx, { message: 'feat change', author: FEAT_AUTHOR });
        await checkout(ctx, { target: 'main' });
        await ctx.fs.writeUtf8(work(ctx, 'f.txt'), 'l1\nMAIN\n');
        await add(ctx, ['f.txt']);
        await commit(ctx, { message: 'main change', author: MAIN_AUTHOR });

        // Act
        const sut = await cherryPickRun(ctx, { commits: [feature.id] });

        // Assert
        expect(sut.kind).toBe('conflict');
        if (sut.kind !== 'conflict') return;
        expect(sut.commit).toBe(feature.id);
        expect(sut.conflicts.map((c) => c.path)).toContain('f.txt');
        expect(sut.remaining).toBe(0);
        expect(await ctx.fs.readUtf8(`${ctx.layout.gitDir}/CHERRY_PICK_HEAD`)).toBe(
          `${feature.id}\n`,
        );
        const mergeMsg = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/MERGE_MSG`);
        expect(mergeMsg).toContain('feat change');
        expect(mergeMsg).toContain('# Conflicts:');
        const index = await readIndex(ctx);
        expect(index.entries.some((e) => e.path === 'f.txt' && e.flags.stage !== 0)).toBe(true);
        expect(await ctx.fs.readUtf8(work(ctx, 'f.txt'))).toContain('<<<<<<<');
      });
    });
  });

  describe('Given a pick whose change is already applied', () => {
    describe('When run without --allow-empty', () => {
      it('Then stops as empty', async () => {
        // Arrange — pick feature once (clean), then pick it again (redundant)
        const { ctx, feature } = await seedFeature();
        await cherryPickRun(ctx, { commits: [feature] });

        // Act
        const sut = await cherryPickRun(ctx, { commits: [feature] });

        // Assert
        expect(sut.kind).toBe('empty');
        if (sut.kind === 'empty') expect(sut.commit).toBe(feature);
      });
    });
  });

  describe('Given --no-commit (-n) for a single pick', () => {
    describe('When run', () => {
      it('Then stages the change, leaves HEAD and state untouched', async () => {
        // Arrange
        const { ctx, feature, base } = await seedFeature();

        // Act
        const sut = await cherryPickRun(ctx, { commits: ['feature'], noCommit: true });

        // Assert
        expect(sut.kind).toBe('no-commit');
        if (sut.kind === 'no-commit') expect(sut.sources).toEqual([feature]);
        const index = await readIndex(ctx);
        expect(index.entries.some((e) => e.path === 'feat.txt')).toBe(true);
        expect(await resolveRef(ctx, 'refs/heads/main' as RefName)).toBe(base); // HEAD unmoved
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/CHERRY_PICK_HEAD`)).toBe(false);
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/sequencer`)).toBe(false);
      });
    });
  });

  describe('Given --no-commit for a two-pick list', () => {
    describe('When run', () => {
      it('Then accumulates both changes in the index without committing', async () => {
        // Arrange
        const { ctx, feature, base } = await seedFeature();
        await checkout(ctx, { target: 'feature' });
        await ctx.fs.writeUtf8(work(ctx, 'feat2.txt'), 'feat2\n');
        await add(ctx, ['feat2.txt']);
        const second = await commit(ctx, { message: 'add feat2', author: FEAT_AUTHOR });
        await checkout(ctx, { target: 'main' });

        // Act
        const sut = await cherryPickRun(ctx, { commits: [feature, second.id], noCommit: true });

        // Assert
        expect(sut.kind).toBe('no-commit');
        const index = await readIndex(ctx);
        expect(index.entries.some((e) => e.path === 'feat.txt')).toBe(true);
        expect(index.entries.some((e) => e.path === 'feat2.txt')).toBe(true);
        expect(await resolveRef(ctx, 'refs/heads/main' as RefName)).toBe(base);
      });
    });
  });

  describe('Given --no-commit and a conflicting pick', () => {
    describe('When run', () => {
      it('Then reports the conflict but persists no resume state', async () => {
        // Arrange — feature and main change the same line differently
        const ctx = createMemoryContext();
        await init(ctx);
        await setUser(ctx);
        await ctx.fs.writeUtf8(work(ctx, 'f.txt'), 'l1\nl2\n');
        await add(ctx, ['f.txt']);
        await commit(ctx, { message: 'base', author: MAIN_AUTHOR });
        await branchCreate(ctx, { name: 'feature' });
        await checkout(ctx, { target: 'feature' });
        await ctx.fs.writeUtf8(work(ctx, 'f.txt'), 'l1\nFEAT\n');
        await add(ctx, ['f.txt']);
        const feature = await commit(ctx, { message: 'feat change', author: FEAT_AUTHOR });
        await checkout(ctx, { target: 'main' });
        await ctx.fs.writeUtf8(work(ctx, 'f.txt'), 'l1\nMAIN\n');
        await add(ctx, ['f.txt']);
        await commit(ctx, { message: 'main change', author: MAIN_AUTHOR });

        // Act
        const sut = await cherryPickRun(ctx, { commits: [feature.id], noCommit: true });

        // Assert
        expect(sut.kind).toBe('conflict');
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/CHERRY_PICK_HEAD`)).toBe(false);
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/sequencer`)).toBe(false);
      });
    });
  });

  describe('Given a redundant pick with --allow-empty', () => {
    describe('When run', () => {
      it('Then creates an empty commit instead of stopping', async () => {
        // Arrange — pick feature once (clean), capture HEAD
        const { ctx, feature } = await seedFeature();
        await cherryPickRun(ctx, { commits: [feature] });
        const headBefore = await resolveRef(ctx, 'refs/heads/main' as RefName);

        // Act — pick it again with --allow-empty
        const sut = await cherryPickRun(ctx, { commits: [feature], allowEmpty: true });

        // Assert
        expect(sut.kind).toBe('picked');
        if (sut.kind !== 'picked') return;
        const created = await readCommit(ctx, sut.commits[0]?.created as ObjectId);
        const parent = await readCommit(ctx, headBefore);
        expect(created.tree).toBe(parent.tree); // empty: tree unchanged
        expect(created.parents).toEqual([headBefore]);
      });
    });
  });

  describe('Given an untracked working file the pick would overwrite', () => {
    describe('When run', () => {
      it('Then refuses with WORKING_TREE_DIRTY', async () => {
        // Arrange — feat.txt exists untracked on main before the pick adds it
        const { ctx } = await seedFeature();
        await ctx.fs.writeUtf8(work(ctx, 'feat.txt'), 'untracked\n');

        // Act
        const code = await codeOf(() => cherryPickRun(ctx, { commits: ['feature'] }));

        // Assert
        expect(code).toBe('WORKING_TREE_DIRTY');
      });
    });
  });

  describe('Given no configured committer identity', () => {
    describe('When a clean pick reaches the commit step', () => {
      it('Then refuses with AUTHOR_UNCONFIGURED', async () => {
        // Arrange — repo built with explicit authors but no [user] config
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(work(ctx, 'base.txt'), 'a\n');
        await add(ctx, ['base.txt']);
        await commit(ctx, { message: 'base', author: MAIN_AUTHOR });
        await branchCreate(ctx, { name: 'feature' });
        await checkout(ctx, { target: 'feature' });
        await ctx.fs.writeUtf8(work(ctx, 'feat.txt'), 'feat\n');
        await add(ctx, ['feat.txt']);
        const feature = await commit(ctx, { message: 'add feat', author: FEAT_AUTHOR });
        await checkout(ctx, { target: 'main' });

        // Act
        const code = await codeOf(() => cherryPickRun(ctx, { commits: [feature.id] }));

        // Assert
        expect(code).toBe('AUTHOR_UNCONFIGURED');
      });
    });
  });

  describe('Given a detached HEAD', () => {
    describe('When run', () => {
      it('Then refuses with UNSUPPORTED_OPERATION', async () => {
        // Arrange
        const { ctx, base } = await seedFeature();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, `${base}\n`);

        // Act
        const code = await codeOf(() => cherryPickRun(ctx, { commits: ['feature'] }));

        // Assert
        expect(code).toBe('UNSUPPORTED_OPERATION');
      });
    });
  });

  describe('Given an unborn branch', () => {
    describe('When run', () => {
      it('Then refuses with NO_INITIAL_COMMIT', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        await setUser(ctx);

        // Act
        const code = await codeOf(() => cherryPickRun(ctx, { commits: ['a'.repeat(40)] }));

        // Assert
        expect(code).toBe('NO_INITIAL_COMMIT');
      });
    });
  });

  describe('Given a dirty working tree', () => {
    describe('When run', () => {
      it('Then refuses with WORKING_TREE_DIRTY', async () => {
        // Arrange
        const { ctx } = await seedFeature();
        await ctx.fs.writeUtf8(work(ctx, 'base.txt'), 'dirty\n');

        // Act
        const code = await codeOf(() => cherryPickRun(ctx, { commits: ['feature'] }));

        // Assert
        expect(code).toBe('WORKING_TREE_DIRTY');
      });
    });
  });

  describe('Given another operation already in progress', () => {
    describe('When run', () => {
      it('Then refuses with OPERATION_IN_PROGRESS', async () => {
        // Arrange — a stray MERGE_HEAD
        const { ctx, base } = await seedFeature();
        await writeMergeHead(ctx, base);

        // Act
        const code = await codeOf(() => cherryPickRun(ctx, { commits: ['feature'] }));

        // Assert
        expect(code).toBe('OPERATION_IN_PROGRESS');
      });
    });
  });
});
