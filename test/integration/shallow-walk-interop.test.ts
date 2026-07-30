/**
 * Cross-tool interop — shallow-boundary parent masking. Builds several
 * `--depth N` clones of real git repos with canonical git, opens each with
 * tsgit, and proves every read surface that walks commit ancestry (`log`,
 * `walkCommits`, `walkCommitsByDate`, `whatchanged`, `describe`, `shortlog`,
 * bundle creation, the push-object enumerator) stops at the same cut point
 * canonical git does, while `catFile` (which never walks) still reports the
 * boundary's true, unmasked parent straight from the object bytes.
 *
 * @proves
 *   surface:        shallowWalk
 *   bucket:         cross-tool-interop
 *   unique:         shallow-boundary parent masking matches git rev-list/log on a --depth clone
 *   interopSurface: shallowWalk
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { describe as describeCommit } from '../../src/application/commands/describe.js';
import { enumeratePushObjects } from '../../src/application/primitives/enumerate-push-objects.js';
import type { TsgitError } from '../../src/domain/error.js';
import type { ObjectId } from '../../src/domain/objects/index.js';
import { openRepository } from '../../src/index.node.js';
import { GIT_AVAILABLE, runGit, runGitEnv, tryRunGitWithExit } from './interop-helpers.js';

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const BASE_TS = 1_700_000_000;

/** Deterministic, monotonically increasing author/committer identity. */
const identityEnv = (offsetSeconds: number): NodeJS.ProcessEnv => ({
  ...runGitEnv(),
  GIT_AUTHOR_NAME: 'Ada',
  GIT_AUTHOR_EMAIL: 'ada@example.com',
  GIT_AUTHOR_DATE: `${BASE_TS + offsetSeconds} +0000`,
  GIT_COMMITTER_NAME: 'Ada',
  GIT_COMMITTER_EMAIL: 'ada@example.com',
  GIT_COMMITTER_DATE: `${BASE_TS + offsetSeconds} +0000`,
});

const mktemp = (slug: string): Promise<string> =>
  mkdtemp(path.join(os.tmpdir(), `tsgit-interop-shallow-${slug}-`));

const cloneDepth = (bare: string, depth: number, dest: string): void => {
  runGit(['clone', '-q', '--depth', String(depth), `file://${bare}`, dest]);
};

describe.skipIf(!GIT_AVAILABLE)('shallow-walk interop', () => {
  // F1 fixture: bare + source with 5 linear commits c1..c5 on main.
  let bare1: string;
  let source1: string;
  let ids: readonly ObjectId[]; // [C1, C2, C3, C4, C5], oldest first

  let f1: string; // --depth 2 clone: objects {C5,C4}, shallow={C4}
  let f2: string; // --depth 1 clone: shallow={C5}
  let f6worktree: string; // linked worktree of f1

  // F3 fixture: base -> {side1, main1} -> merge, --depth 2 clone: two boundaries.
  let bare3: string;
  let source3: string;
  let f3: string;
  // `base` itself is deliberately never captured — it sits beyond BOTH
  // boundaries and is absent from every F3 assertion below.
  let side1: ObjectId;
  let main1: ObjectId;
  let merge3: ObjectId;

  // F7a/F7b: mutated inside their own `it` (Arrange), not in beforeAll.
  let f7a: string;
  let f7b: string;

  const allDirs: string[] = [];
  const tmp = async (slug: string): Promise<string> => {
    const dir = await mktemp(slug);
    allDirs.push(dir);
    return dir;
  };

  beforeAll(async () => {
    // ── F1/F2/F6/F7a/F7b: shared linear 5-commit source ──
    bare1 = await tmp('bare1');
    source1 = await tmp('source1');
    runGit(['init', '-q', '-b', 'main', '--bare', bare1]);
    runGit(['init', '-q', '-b', 'main', source1]);
    for (let i = 0; i < 5; i += 1) {
      await writeFile(path.join(source1, `f${i}.txt`), `${i}\n`);
      runGit(['-C', source1, 'add', '.']);
      runGit(['-C', source1, 'commit', '-q', '-m', `c${i + 1}`], { env: identityEnv(i) });
    }
    runGit(['-C', source1, 'remote', 'add', 'origin', bare1]);
    runGit(['-C', source1, 'push', '-q', 'origin', 'main']);
    ids = runGit(['-C', source1, 'rev-list', '--reverse', 'main']).trim().split('\n') as ObjectId[];

    f1 = await tmp('f1');
    cloneDepth(bare1, 2, f1);
    f2 = await tmp('f2');
    cloneDepth(bare1, 1, f2);
    f7a = await tmp('f7a');
    cloneDepth(bare1, 2, f7a);
    f7b = await tmp('f7b');
    cloneDepth(bare1, 2, f7b);

    // Annotate v0.4 on C4 directly in the shallow clone F1 (A28/A29): an
    // annotated tag needs a committer identity, and the isolated HOME means
    // there is no readable user.name/user.email, so the extended env is
    // required here.
    runGit(['-C', f1, 'tag', '-a', 'v0.4', '-m', 'v0.4', ids[3] as string], {
      env: identityEnv(5),
    });

    f6worktree = await tmp('f6-worktree');
    runGit(['-C', f1, 'worktree', 'add', f6worktree, '-b', 'wt'], { env: identityEnv(6) });

    // ── F3: two-boundary diamond ──
    bare3 = await tmp('bare3');
    source3 = await tmp('source3');
    runGit(['init', '-q', '-b', 'main', '--bare', bare3]);
    runGit(['init', '-q', '-b', 'main', source3]);
    await writeFile(path.join(source3, 'base.txt'), 'base\n');
    runGit(['-C', source3, 'add', '.']);
    runGit(['-C', source3, 'commit', '-q', '-m', 'base'], { env: identityEnv(10) });

    runGit(['-C', source3, 'checkout', '-q', '-b', 'side']);
    await writeFile(path.join(source3, 'side.txt'), 'side\n');
    runGit(['-C', source3, 'add', '.']);
    runGit(['-C', source3, 'commit', '-q', '-m', 'side1'], { env: identityEnv(11) });
    side1 = runGit(['-C', source3, 'rev-parse', 'HEAD']).trim() as ObjectId;

    runGit(['-C', source3, 'checkout', '-q', 'main']);
    await writeFile(path.join(source3, 'main.txt'), 'main\n');
    runGit(['-C', source3, 'add', '.']);
    runGit(['-C', source3, 'commit', '-q', '-m', 'main1'], { env: identityEnv(12) });
    main1 = runGit(['-C', source3, 'rev-parse', 'HEAD']).trim() as ObjectId;

    runGit(['-C', source3, 'merge', '-q', '--no-ff', 'side', '-m', 'merge'], {
      env: identityEnv(13),
    });
    merge3 = runGit(['-C', source3, 'rev-parse', 'HEAD']).trim() as ObjectId;

    runGit(['-C', source3, 'remote', 'add', 'origin', bare3]);
    runGit(['-C', source3, 'push', '-q', 'origin', 'main']);
    f3 = await tmp('f3');
    cloneDepth(bare3, 2, f3);
  }, 60_000);

  afterAll(async () => {
    for (const dir of allDirs) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  describe('Given a --depth 2 clone (F1: objects {C5,C4}, shallow={C4})', () => {
    describe('When log runs with maxParents:0', () => {
      it('Then only the boundary is returned, matching rev-list --max-parents=0', async () => {
        // Arrange
        const repo = await openRepository({ cwd: f1 });

        // Act
        const result = await repo.log({ maxParents: 0 });
        const gitBoundary = runGit(['-C', f1, 'rev-list', '--max-parents=0', 'HEAD']).trim();

        // Assert — A3
        expect(result.map((e) => e.id)).toEqual([ids[3]]);
        expect(result[0]?.id).toBe(gitBoundary);
      });
    });

    describe('When walkCommits and walkCommitsByDate both walk from the tip', () => {
      it('Then both yield exactly [C5, C4]', async () => {
        // Arrange
        const repo = await openRepository({ cwd: f1 });
        const gitCount = Number(runGit(['-C', f1, 'rev-list', '--count', 'HEAD']).trim());

        // Act
        const topo: ObjectId[] = [];
        for await (const c of repo.primitives.walkCommits({ from: [ids[4] as ObjectId] })) {
          topo.push(c.id);
        }
        const byDate: ObjectId[] = [];
        for await (const c of repo.primitives.walkCommitsByDate({ from: [ids[4] as ObjectId] })) {
          byDate.push(c.id);
        }

        // Assert — A4/A5
        expect(topo).toEqual([ids[4], ids[3]]);
        expect(byDate).toEqual([ids[4], ids[3]]);
        expect(topo.length).toBe(gitCount);
      });
    });

    describe('When log runs with default options', () => {
      it('Then it reconstructs the same id/parents pairs as git log --format=%H %P', async () => {
        // Arrange
        const repo = await openRepository({ cwd: f1 });
        const gitLines = runGit(['-C', f1, 'log', '--format=%H %P', 'HEAD']).trim().split('\n');

        // Act
        const result = await repo.log({});
        const tsgitLines = result.map((e) => `${e.id} ${e.parents.join(' ')}`.trimEnd());

        // Assert — A6/A7/A10 (full-oid reconstruction only; abbreviation is the caller's concern)
        expect(tsgitLines).toEqual(gitLines);
        expect(result.find((e) => e.id === ids[3])?.parents).toEqual([]);
      });
    });

    describe('When log runs with minParents:1', () => {
      it('Then only the non-boundary commit is kept', async () => {
        // Arrange
        const repo = await openRepository({ cwd: f1 });

        // Act
        const result = await repo.log({ minParents: 1 });

        // Assert — A25
        expect(result.map((e) => e.id)).toEqual([ids[4]]);
      });
    });

    describe('When log runs with order:first-parent and maxParents:0', () => {
      it('Then it also returns only the boundary', async () => {
        // Arrange
        const repo = await openRepository({ cwd: f1 });

        // Act
        const result = await repo.log({ order: 'first-parent', maxParents: 0 });

        // Assert — A26
        expect(result.map((e) => e.id)).toEqual([ids[3]]);
      });
    });

    describe('When walkCommits(until:[C4]) and log(excluding:[C4]) both run', () => {
      it('Then both stop before the boundary, matching git ranges', async () => {
        // Arrange
        const repo = await openRepository({ cwd: f1 });
        const c4 = ids[3] as ObjectId;
        const c5 = ids[4] as ObjectId;
        const gitRange = runGit(['-C', f1, 'rev-list', `${c4}..${c5}`]).trim();
        const gitAncestry = runGit(['-C', f1, 'rev-list', '--ancestry-path', `${c4}..HEAD`]).trim();
        const gitNot = runGit(['-C', f1, 'rev-list', 'HEAD', '--not', c4]).trim();

        // Act
        const walked: ObjectId[] = [];
        for await (const c of repo.primitives.walkCommits({ from: [c5], until: [c4] })) {
          walked.push(c.id);
        }
        const logged = await repo.log({ excluding: [c4] });

        // Assert — A14/A16/A17
        expect(walked).toEqual([c5]);
        expect(logged.map((e) => e.id)).toEqual([c5]);
        expect(gitRange).toBe(c5);
        expect(gitAncestry).toBe(c5);
        expect(gitNot).toBe(c5);
      });
    });

    describe('When walkCommits is seeded with a commit that is itself absent', () => {
      it('Then it still rejects OBJECT_NOT_FOUND, matching git merge-base', async () => {
        // Arrange — C3 is a seed, not a boundary's parent: grafting never invents a commit.
        const repo = await openRepository({ cwd: f1 });
        const c3 = ids[2] as ObjectId;
        const gitResult = tryRunGitWithExit(['-C', f1, 'merge-base', 'HEAD', c3]);

        // Act & Assert — A19
        let caught: unknown;
        try {
          for await (const _c of repo.primitives.walkCommits({ from: [c3] })) {
            // draining is enough to trigger the read
          }
          expect.unreachable();
        } catch (error) {
          caught = error;
        }
        expect((caught as TsgitError).data.code).toBe('OBJECT_NOT_FOUND');
        expect(gitResult.exitCode).toBe(128);
      });
    });

    describe('When log excludes a range base beyond the boundary', () => {
      it('Then it co-refuses with git rev-list', async () => {
        // Arrange — C3 sits beyond the shallow boundary; resolveCommit's peel()
        // reads the object to confirm its type, so an absent oid surfaces here
        // as OBJECT_NOT_FOUND, matching git's own `fatal:` (exit 128) refusal
        // for the equivalent range.
        const repo = await openRepository({ cwd: f1 });
        const c3 = ids[2] as ObjectId;
        const gitResult = tryRunGitWithExit(['-C', f1, 'rev-list', `${c3}..HEAD`]);

        // Act & Assert — A15
        let caught: unknown;
        try {
          await repo.log({ excluding: [c3] });
          expect.unreachable();
        } catch (error) {
          caught = error;
        }
        expect((caught as TsgitError).data.code).toBe('OBJECT_NOT_FOUND');
        expect(gitResult.exitCode).toBe(128);
      });
    });

    describe('When catFile reads the boundary commit directly', () => {
      it("Then it still reports the commit's true, unmasked parent (negative control)", async () => {
        // Arrange
        const repo = await openRepository({ cwd: f1 });
        const c4 = ids[3] as ObjectId;
        const gitParentLine = runGit(['-C', f1, 'cat-file', '-p', c4])
          .split('\n')
          .find((line) => line.startsWith('parent '));

        // Act — A8/A9
        const result = await repo.catFile({ ids: [c4] });
        const entry = result.entries[0];
        const raw =
          entry?.ok === true && entry.object.type === 'commit'
            ? entry.object.data.parents
            : undefined;

        // Assert — object bytes are untouched by the walk-time graft
        expect(raw).toEqual([ids[2]]);
        expect(gitParentLine).toBe(`parent ${ids[2]}`);
      });
    });

    describe('When whatchanged walks the history', () => {
      it('Then it diffs the boundary against the empty tree, matching git diff against the empty-tree sentinel', async () => {
        // Arrange
        const repo = await openRepository({ cwd: f1 });
        const c4 = ids[3] as ObjectId;
        const gitAdded = runGit(['-C', f1, 'diff', '--name-status', EMPTY_TREE, c4])
          .trim()
          .split('\n')
          .map((line) => line.split('\t')[1])
          .sort();

        // Act — A23
        const result = await repo.whatchanged({});
        const boundaryEntry = result.find((e) => e.id === c4);
        const tsgitAdded = (boundaryEntry?.changes.changes ?? [])
          .filter((c) => c.type === 'add')
          .map((c) => c.newPath as string)
          .sort();

        // Assert
        expect(boundaryEntry?.parents).toEqual([]);
        expect(tsgitAdded).toEqual(gitAdded);
      });
    });

    describe('When describe runs on HEAD and on the boundary', () => {
      it('Then it finds the tag planted on the boundary, matching git describe', async () => {
        // Arrange
        const repo = await openRepository({ cwd: f1 });
        const gitHead = runGit(['-C', f1, 'describe', 'HEAD']).trim();
        const gitBoundary = runGit(['-C', f1, 'describe', ids[3] as string]).trim();

        // Act — A28/A29
        const head = await describeCommit(repo.ctx, 'HEAD');
        const boundary = await describeCommit(repo.ctx, ids[3] as ObjectId);

        // Assert — structured fields reconstruct git's `<name>-<distance>-g<abbrev>` line
        expect(head.name).toBe('v0.4');
        expect(head.distance).toBe(1);
        expect(gitHead.startsWith(`${head.name}-${head.distance}-g`)).toBe(true);
        expect(head.oid.startsWith(gitHead.slice(`${head.name}-${head.distance}-g`.length))).toBe(
          true,
        );
        expect(boundary.name).toBe('v0.4');
        expect(boundary.exact).toBe(true);
        expect(gitBoundary).toBe('v0.4');
      });
    });

    describe('When shortlog runs', () => {
      it('Then it counts both reachable commits for the single author', async () => {
        // Arrange
        const repo = await openRepository({ cwd: f1 });

        // Act — A31
        const groups = await repo.shortlog({});

        // Assert
        expect(groups).toHaveLength(1);
        expect(groups[0]?.commits).toHaveLength(2);
      });
    });

    describe('When a bundle is created', () => {
      it('Then it succeeds without over-enumerating past the boundary', async () => {
        // Arrange
        const repo = await openRepository({ cwd: f1 });

        // Act — A33
        const result = await repo.bundle.create({ branches: true });

        // Assert
        expect(result.objectCount).toBeGreaterThan(0);
      });
    });

    describe('When enumeratePushObjects walks from the tip', () => {
      it('Then it terminates at the boundary instead of over-enumerating', async () => {
        // Arrange
        const repo = await openRepository({ cwd: f1 });

        // Act — A34 (client half only; the server-side refusal is git's own)
        const objects: ObjectId[] = [];
        for await (const id of enumeratePushObjects(repo.ctx, {
          wants: [ids[4] as ObjectId],
          haves: [],
        })) {
          objects.push(id);
        }

        // Assert — completes without OBJECT_NOT_FOUND past the boundary
        expect(objects).toContain(ids[3]);
        expect(objects).toContain(ids[4]);
      });
    });
  });

  describe('Given a --depth 2 clone deepened by 1 inside the test (F7a)', () => {
    describe('When git fetch --deepen runs and a fresh Context is opened', () => {
      it('Then the new boundary is C3, matching git', async () => {
        // Arrange — A38
        runGit(['-C', f7a, 'fetch', '-q', '--deepen', '1'], { env: identityEnv(20) });
        const repo = await openRepository({ cwd: f7a });
        const gitCount = Number(runGit(['-C', f7a, 'rev-list', '--count', 'HEAD']).trim());

        // Act
        const walked: ObjectId[] = [];
        for await (const c of repo.primitives.walkCommits({ from: [ids[4] as ObjectId] })) {
          walked.push(c.id);
        }
        const boundary = await repo.log({ maxParents: 0 });

        // Assert
        expect(walked.length).toBe(3);
        expect(walked.length).toBe(gitCount);
        expect(boundary.map((e) => e.id)).toEqual([ids[2]]);
      });
    });
  });

  describe('Given a --depth 2 clone unshallowed inside the test (F7b)', () => {
    describe('When git fetch --unshallow runs and a fresh Context is opened', () => {
      it('Then the repository walks full history, matching git', async () => {
        // Arrange — A39
        runGit(['-C', f7b, 'fetch', '-q', '--unshallow'], { env: identityEnv(21) });
        const repo = await openRepository({ cwd: f7b });
        const gitCount = Number(runGit(['-C', f7b, 'rev-list', '--count', 'HEAD']).trim());

        // Act
        const walked: ObjectId[] = [];
        for await (const c of repo.primitives.walkCommits({ from: [ids[4] as ObjectId] })) {
          walked.push(c.id);
        }
        const boundary = await repo.log({ maxParents: 0 });

        // Assert
        expect(walked.length).toBe(5);
        expect(walked.length).toBe(gitCount);
        expect(boundary.map((e) => e.id)).toEqual([ids[0]]);
      });
    });
  });

  describe('Given a --depth 1 clone (F2: shallow={C5})', () => {
    describe('When log runs with default options', () => {
      it('Then it yields one entry whose parents are empty', async () => {
        // Arrange
        const repo = await openRepository({ cwd: f2 });

        // Act — B1
        const result = await repo.log({});

        // Assert
        expect(result.map((e) => e.id)).toEqual([ids[4]]);
        expect(result[0]?.parents).toEqual([]);
      });
    });

    describe('When log runs with maxParents:0', () => {
      it('Then it also returns the single commit', async () => {
        // Arrange
        const repo = await openRepository({ cwd: f2 });

        // Act — B2
        const result = await repo.log({ maxParents: 0 });

        // Assert
        expect(result.map((e) => e.id)).toEqual([ids[4]]);
      });
    });
  });

  describe('Given a --depth 2 clone of a two-parent merge (F3: boundaries side1, main1)', () => {
    describe('When walkCommits walks from the merge', () => {
      it('Then it yields exactly the merge and both boundary parents', async () => {
        // Arrange
        const repo = await openRepository({ cwd: f3 });

        // Act — B3/B4
        const walked: ObjectId[] = [];
        for await (const c of repo.primitives.walkCommits({ from: [merge3] })) {
          walked.push(c.id);
        }

        // Assert
        expect(walked.sort()).toEqual([merge3, main1, side1].sort());
      });

      it('Then both boundaries report empty parents', async () => {
        // Arrange
        const repo = await openRepository({ cwd: f3 });

        // Act — B5
        const commits: Record<string, readonly ObjectId[]> = {};
        for await (const c of repo.primitives.walkCommits({ from: [merge3] })) {
          commits[c.id] = c.data.parents;
        }

        // Assert
        expect(commits[side1]).toEqual([]);
        expect(commits[main1]).toEqual([]);
      });
    });

    describe('When log runs with maxParents:0', () => {
      it('Then it returns both boundaries', async () => {
        // Arrange
        const repo = await openRepository({ cwd: f3 });

        // Act — B6
        const result = await repo.log({ maxParents: 0 });

        // Assert
        expect(result.map((e) => e.id).sort()).toEqual([main1, side1].sort());
      });
    });

    // B7 (mergeBase(merge, main1) === main1) is deliberately NOT asserted here.
    // `mergeBase`'s own commit reader (`merge-base.ts`) calls `readObject`
    // directly, bypassing `readCommit`/`applyGraft` — verified by hand: it walks
    // past `main1` into its true (real, unmasked) parent `base`, which does not
    // exist in this shallow clone, and rejects OBJECT_NOT_FOUND. Grafting
    // `mergeBase` is out of this part's scope (it has no consumer of the
    // shallow set yet); the row belongs to the part that grafts it.
  });

  describe('Given a linked worktree of the shallow clone (F6: no .git/shallow in the worktree admin dir)', () => {
    describe('When walkCommits and log both run through the worktree Context', () => {
      it('Then the shared shallow set resolves through the common dir, identical masking to F1', async () => {
        // Arrange — E1/E2/E3
        const repo = await openRepository({ cwd: f6worktree });

        // Act
        const walked: ObjectId[] = [];
        for await (const c of repo.primitives.walkCommits({ from: [ids[4] as ObjectId] })) {
          walked.push(c.id);
        }
        const boundary = await repo.log({ maxParents: 0 });

        // Assert
        expect(walked).toEqual([ids[4], ids[3]]);
        expect(boundary.map((e) => e.id)).toEqual([ids[3]]);
      });
    });
  });
});
