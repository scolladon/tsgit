/**
 * Cross-tool interop — the closure prune's object set against canonical git,
 * over a small shared-subtree history: four commits where consecutive trees
 * partially reuse each other's subtrees, and the tip is an empty commit that
 * reuses its parent's root tree verbatim.
 *
 * @proves
 *   surface:        revList
 *   bucket:         cross-tool-interop
 *   unique:         the pruned walk's object set matches canonical git's,
 *                    including the identical-tree-commit over-report shape
 *   interopSurface: closure
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { packObjects } from '../../src/application/commands/pack-objects.js';
import { revList } from '../../src/application/commands/rev-list.js';
import type { Context } from '../../src/ports/context.js';
import { GIT_AVAILABLE, git, runGit, runGitEnv, tryRunGitWithExit } from './interop-helpers.js';
import { trackedRepositories } from './repository-lifecycle.js';

const SETUP_TIMEOUT = 60_000;

interface SkewedMergeFixture {
  readonly dir: string;
  readonly ids: Readonly<Record<string, string>>;
}

/** m (100) merges a (50, on a1 at 80) and b (90); t (95) is a second tip; all on r. */
const buildSkewedMergeFixture = async (): Promise<SkewedMergeFixture> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-rev-list-skewed-merge-'));
  runGit(['init', '-q', '-b', 'main', dir]);
  const make = (name: string, offset: number, parents: ReadonlyArray<string>): string => {
    const blob = runGit(['-C', dir, 'hash-object', '-w', '--stdin'], { input: name }).trim();
    const tree = runGit(['-C', dir, 'mktree'], { input: `100644 blob ${blob}\t${name}\n` }).trim();
    const parentArgs = parents.flatMap((parent) => ['-p', parent]);
    return runGit(['-C', dir, 'commit-tree', tree, ...parentArgs, '-m', name], {
      env: datedEnv(1_700_000_000 + offset),
    }).trim();
  };
  const r = make('r', 10, []);
  const a = make('a', 50, [make('a1', 80, [r])]);
  const b = make('b', 90, [r]);
  return { dir, ids: { m: make('m', 100, [a, b]), t: make('t', 95, [r]) } };
};

/** Deterministic author/committer dates for every commit this suite makes. */
const datedEnv = (epoch: number): NodeJS.ProcessEnv => ({
  ...runGitEnv(),
  GIT_AUTHOR_NAME: 'A U Thor',
  GIT_AUTHOR_EMAIL: 'author@example.com',
  GIT_AUTHOR_DATE: `${epoch} +0000`,
  GIT_COMMITTER_NAME: 'A U Thor',
  GIT_COMMITTER_EMAIL: 'author@example.com',
  GIT_COMMITTER_DATE: `${epoch} +0000`,
});

const commit = (
  dir: string,
  message: string,
  ts: number,
  extraArgs: ReadonlyArray<string> = [],
): void => {
  runGit(['-C', dir, 'commit', '-q', '--no-gpg-sign', ...extraArgs, '-m', message], {
    env: datedEnv(ts),
  });
};

/**
 * `git rev-list <args>` stdout, as a bare id set. Each line is either a bare
 * id (commits without `--objects`) or `id path` (`--objects`' trees/blobs,
 * a root tree's own empty path included) — only the id counts here.
 */
const gitIdSet = (dir: string, ...args: ReadonlyArray<string>): ReadonlySet<string> => {
  const ids = new Set<string>();
  for (const line of git(dir, 'rev-list', ...args).split('\n')) {
    if (line.length === 0) continue;
    const spaceIndex = line.indexOf(' ');
    ids.add(spaceIndex === -1 ? line : line.slice(0, spaceIndex));
  }
  return ids;
};

interface SkewedExclusionFixture {
  readonly dir: string;
  /** Newest commit, on the shared ancestor. */
  readonly tip: string;
  /** Reaches the ancestor through six commits dated before it. */
  readonly farTip: string;
  /** Reaches the ancestor through three commits dated before it. */
  readonly nearTip: string;
  /** Reuses the tree of an ancestor the walk lists before `lateTip` reaches it. */
  readonly sharedTreeTip: string;
  /** Reaches `sharedTreeTip`'s ancestors only through a commit dated after them. */
  readonly lateTip: string;
}

/** A plumbing-built commit at `1_700_000_000 + offset`, owning one file named `name`. */
const commitAt = (
  dir: string,
  name: string,
  offset: number,
  parents: ReadonlyArray<string>,
  tree?: string,
): string => {
  const blob = runGit(['-C', dir, 'hash-object', '-w', '--stdin'], { input: name }).trim();
  const ownTree =
    tree ?? runGit(['-C', dir, 'mktree'], { input: `100644 blob ${blob}\t${name}.txt\n` }).trim();
  const parentArgs = parents.flatMap((parent) => ['-p', parent]);
  return runGit(['-C', dir, 'commit-tree', ownTree, '-m', name, ...parentArgs], {
    env: datedEnv(1_700_000_000 + offset),
  }).trim();
};

const skewedLine = (dir: string, base: string, depth: number): string => {
  let line = base;
  for (let step = 1; step <= depth; step += 1) {
    line = commitAt(dir, `line${depth}-${step}`, 300 - step, [line]);
  }
  return commitAt(dir, `tip${depth}`, 400, [line]);
};

const annotatedTag = (dir: string, name: string, target: string): void => {
  runGit(['-C', dir, 'tag', '-a', '-m', name, name, target], { env: datedEnv(1_700_000_000) });
};

/** `base` <- `main`; refs name each one's tree and blob, plus tags of a tree and of a tag. */
const buildNonCommitTipFixture = async (): Promise<string> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-rev-list-non-commit-'));
  git(dir, 'init', '-q', '-b', 'main');
  const base = commitAt(dir, 'base', 0, []);
  const baseBlob = git(dir, 'rev-parse', `${base}:base.txt`).trim();
  const tipBlob = runGit(['-C', dir, 'hash-object', '-w', '--stdin'], { input: 'tip' }).trim();
  const tipTree = runGit(['-C', dir, 'mktree'], {
    input: `100644 blob ${baseBlob}\tbase.txt\n100644 blob ${tipBlob}\ttip.txt\n`,
  }).trim();
  git(dir, 'update-ref', 'refs/heads/main', commitAt(dir, 'tip', 100, [base], tipTree));
  git(dir, 'update-ref', 'refs/heads/base', base);
  git(dir, 'update-ref', 'refs/tags/tip-tree', tipTree);
  git(dir, 'update-ref', 'refs/tags/tip-blob', tipBlob);
  git(dir, 'update-ref', 'refs/tags/base-tree', git(dir, 'rev-parse', `${base}^{tree}`).trim());
  git(dir, 'update-ref', 'refs/tags/base-blob', baseBlob);
  annotatedTag(dir, 'tag-tree', tipTree);
  annotatedTag(dir, 'tag-tag', 'tag-tree');
  annotatedTag(dir, 'tag-base', base);
  return dir;
};

const buildSkewedExclusionFixture = async (): Promise<SkewedExclusionFixture> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-rev-list-skewed-'));
  git(dir, 'init', '-q', '-b', 'main');
  const ancestor = commitAt(dir, 'ancestor', 500, []);
  const tip = commitAt(dir, 'tip', 1000, [ancestor]);
  const older = commitAt(dir, 'older', 700, []);
  const olderTree = git(dir, 'rev-parse', `${older}^{tree}`).trim();
  const middle = commitAt(dir, 'middle', 800, [older]);
  const sharedTreeTip = commitAt(dir, 'sharedTreeTip', 1000, [middle], olderTree);
  const late = commitAt(dir, 'late', 900, [middle]);
  return {
    dir,
    tip,
    farTip: skewedLine(dir, ancestor, 6),
    nearTip: skewedLine(dir, ancestor, 3),
    sharedTreeTip,
    lateTip: commitAt(dir, 'late-tip', 500, [late]),
  };
};

interface SharedSubtreeFixture {
  readonly dir: string;
  readonly ctx: Context;
}

/**
 * `c0` adds `a/one`, `a/two`, `b/one`; `c1` edits `a/one` (tree `a` changes,
 * tree `b` is reused wholesale); `c2` adds `b/two` (tree `b` changes, tree
 * `a` is reused wholesale from `c1`); `c3` is `commit --allow-empty` on
 * `c2`, so its root tree is `c2`'s own tree verbatim.
 */
const buildSharedSubtreeFixture = async (): Promise<SharedSubtreeFixture> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-rev-list-objects-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'A U Thor');
  git(dir, 'config', 'user.email', 'author@example.com');
  git(dir, 'config', 'commit.gpgsign', 'false');

  await mkdir(path.join(dir, 'a'), { recursive: true });
  await mkdir(path.join(dir, 'b'), { recursive: true });
  await writeFile(path.join(dir, 'a', 'one'), 'a/one v0\n');
  await writeFile(path.join(dir, 'a', 'two'), 'a/two\n');
  await writeFile(path.join(dir, 'b', 'one'), 'b/one\n');
  git(dir, 'add', '-A');
  commit(dir, 'c0', 1_700_000_000);

  await writeFile(path.join(dir, 'a', 'one'), 'a/one v1\n');
  git(dir, 'add', '-A');
  commit(dir, 'c1', 1_700_000_001);

  await writeFile(path.join(dir, 'b', 'two'), 'b/two\n');
  git(dir, 'add', '-A');
  commit(dir, 'c2', 1_700_000_002);

  commit(dir, 'c3', 1_700_000_003, ['--allow-empty']);

  const ctx = createNodeContext({ workDir: dir });
  return { dir, ctx };
};

interface MissingNotTreeFixture {
  readonly dir: string;
  readonly notTip: string;
}

/**
 * `base` writes `a/one` and `b/one`; `have` edits `a/one` (subtree `a`
 * changes, `b` is reused wholesale); `want` edits `b/one`, reusing `have`'s
 * subtree `a` wholesale. `have`'s own root tree object is then removed from
 * the object store — the promisor gap a `--filter=tree:0` partial clone (or a
 * pruned/corrupt repository) leaves behind on the negative side.
 */
const buildMissingNotTreeFixture = async (): Promise<MissingNotTreeFixture> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-rev-list-missing-not-tree-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'A U Thor');
  git(dir, 'config', 'user.email', 'author@example.com');
  git(dir, 'config', 'commit.gpgsign', 'false');

  await mkdir(path.join(dir, 'a'), { recursive: true });
  await mkdir(path.join(dir, 'b'), { recursive: true });
  await writeFile(path.join(dir, 'a', 'one'), 'a/one v0\n');
  await writeFile(path.join(dir, 'b', 'one'), 'b/one v0\n');
  git(dir, 'add', '-A');
  commit(dir, 'base', 1_700_000_000);

  await writeFile(path.join(dir, 'a', 'one'), 'a/one v1\n');
  git(dir, 'add', '-A');
  commit(dir, 'have', 1_700_000_001);

  await writeFile(path.join(dir, 'b', 'one'), 'b/one v1\n');
  git(dir, 'add', '-A');
  commit(dir, 'want', 1_700_000_002);

  const notTip = git(dir, 'rev-parse', 'HEAD~1').trim();
  const notRootTree = git(dir, 'rev-parse', 'HEAD~1^{tree}').trim();
  await rm(path.join(dir, '.git', 'objects', notRootTree.slice(0, 2), notRootTree.slice(2)), {
    force: true,
  });
  return { dir, notTip };
};

interface UnrelatedSharedBlobFixture {
  readonly dir: string;
  readonly wantTip: string;
  readonly notTip: string;
}

/**
 * Two commits with NO common history that name the same blob: `W` (on `main`)
 * carries `shared` and `w`; `T` (an orphan root) carries only `shared`. git's
 * limited `rev-list --objects W ^T` never marks `T`'s tree (it is not an edge
 * parent of the interesting walk), so the shared blob — reachable from `W` too
 * — is still emitted. Pins that a non-boundary `not` tip leaves its own tree
 * unmarked.
 */
const buildUnrelatedSharedBlobFixture = async (): Promise<UnrelatedSharedBlobFixture> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-rev-list-unrelated-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'A U Thor');
  git(dir, 'config', 'user.email', 'author@example.com');
  git(dir, 'config', 'commit.gpgsign', 'false');

  await writeFile(path.join(dir, 'shared'), 'shared\n');
  await writeFile(path.join(dir, 'w'), 'w\n');
  git(dir, 'add', '-A');
  commit(dir, 'W', 1_700_000_000);
  const wantTip = git(dir, 'rev-parse', 'HEAD').trim();

  git(dir, 'checkout', '-q', '--orphan', 'other');
  git(dir, 'rm', '-q', '-rf', '.');
  await writeFile(path.join(dir, 'shared'), 'shared\n');
  git(dir, 'add', '-A');
  commit(dir, 'T', 1_700_000_001);
  const notTip = git(dir, 'rev-parse', 'HEAD').trim();

  return { dir, wantTip, notTip };
};

interface BoundaryBeyondCountFixture {
  readonly dir: string;
  readonly w2: string;
  readonly w3: string;
  readonly notTip: string;
}

/**
 * Linear P `{shared, t}` <- W2 `{+w2}` <- W3 `{+w3}`. With `^P`, P is the edge
 * parent of W2, so git marks P's tree over the WHOLE interesting walk before
 * `--max-count` truncates the output and regardless of `--no-walk` (which git
 * ignores once a range is present). Pins both cases against git.
 */
const buildBoundaryBeyondCountFixture = async (): Promise<BoundaryBeyondCountFixture> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-rev-list-boundary-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'A U Thor');
  git(dir, 'config', 'user.email', 'author@example.com');
  git(dir, 'config', 'commit.gpgsign', 'false');

  await writeFile(path.join(dir, 'shared'), 'shared\n');
  await writeFile(path.join(dir, 't'), 't\n');
  git(dir, 'add', '-A');
  commit(dir, 'P', 1_700_000_000);
  const notTip = git(dir, 'rev-parse', 'HEAD').trim();

  await writeFile(path.join(dir, 'w2'), 'w2\n');
  git(dir, 'add', '-A');
  commit(dir, 'W2', 1_700_000_001);
  const w2 = git(dir, 'rev-parse', 'HEAD').trim();

  await writeFile(path.join(dir, 'w3'), 'w3\n');
  git(dir, 'add', '-A');
  commit(dir, 'W3', 1_700_000_002);
  const w3 = git(dir, 'rev-parse', 'HEAD').trim();

  return { dir, w2, w3, notTip };
};

describe.skipIf(!GIT_AVAILABLE)('rev-list objects interop — closure prune', () => {
  describe('Given a shared-subtree history whose tip reuses its parent tree verbatim', () => {
    let fixture: SharedSubtreeFixture;

    beforeAll(async () => {
      fixture = await buildSharedSubtreeFixture();
    }, SETUP_TIMEOUT);

    afterAll(async () => rm(fixture.dir, { recursive: true, force: true }));

    describe('When revList walks the objects closure from HEAD', () => {
      it('Then the object ids match git rev-list --objects HEAD exactly, in order', async () => {
        // Arrange
        const expected = gitIdSet(fixture.dir, '--objects', 'HEAD');
        const sut = revList;

        // Act
        const result = await sut(fixture.ctx, { wants: ['HEAD'], objects: true });

        // Assert
        expect(result.entries.map((entry) => entry.id)).toEqual([...expected]);
      });
    });

    describe('When revList walks the objects closure from the empty tip commit', () => {
      it('Then the tip and its parent share one root-tree entry, not two', async () => {
        // Arrange — `rev-parse HEAD^{tree}` equals `rev-parse HEAD~1^{tree}`;
        // that shared oid must appear exactly once among tsgit's entries.
        const sharedRootTreeId = git(fixture.dir, 'rev-parse', 'HEAD^{tree}').trim();
        const parentRootTreeId = git(fixture.dir, 'rev-parse', 'HEAD~1^{tree}').trim();
        expect(sharedRootTreeId).toBe(parentRootTreeId);
        const sut = revList;

        // Act
        const result = await sut(fixture.ctx, { wants: ['HEAD'], objects: true });

        // Assert
        const rootTreeOccurrences = result.entries.filter((entry) => entry.id === sharedRootTreeId);
        expect(rootTreeOccurrences).toHaveLength(1);
      });
    });

    describe('When revList walks the objects closure from HEAD excluding HEAD~2', () => {
      it('Then the object id set matches git rev-list --objects HEAD ^HEAD~2 — including its over-report', async () => {
        // Arrange — a fresh Context: the graph/fanout caches are per session,
        // and the prior rows already read through this one.
        const freshCtx = createNodeContext({ workDir: fixture.dir });
        const notTipId = git(fixture.dir, 'rev-parse', 'HEAD~2').trim();
        const expected = gitIdSet(fixture.dir, '--objects', 'HEAD', '--not', notTipId);
        const sut = revList;

        // Act
        const result = await sut(freshCtx, {
          wants: ['HEAD'],
          not: [notTipId],
          objects: true,
        });

        // Assert
        const actual = new Set(result.entries.map((entry) => entry.id));
        expect([...actual].sort()).toEqual([...expected].sort());
      });
    });
  });

  describe('Given a history whose not tip has no root tree object in the object store', () => {
    let fixture: MissingNotTreeFixture;

    beforeAll(async () => {
      fixture = await buildMissingNotTreeFixture();
    }, SETUP_TIMEOUT);

    afterAll(async () => rm(fixture.dir, { recursive: true, force: true }));

    describe('When revList walks the objects closure excluding that tip', () => {
      it('Then the object id set matches git rev-list --objects want ^have, over-report and all', async () => {
        // Arrange — `gitIdSet` spawns git through `execFileSync`, which throws
        // on any non-zero exit: git succeeding here IS the pinned behaviour.
        // A fresh Context, cut after the object was removed, so no cache
        // carries a reading of the vanished tree.
        const expected = gitIdSet(fixture.dir, '--objects', 'HEAD', '--not', fixture.notTip);
        const ctx = createNodeContext({ workDir: fixture.dir });
        const sut = revList;

        // Act
        const result = await sut(ctx, {
          wants: ['HEAD'],
          not: [fixture.notTip],
          objects: true,
        });

        // Assert
        const actual = new Set(result.entries.map((entry) => entry.id));
        expect([...actual].sort()).toEqual([...expected].sort());
      });
    });
  });
  describe('Given two unrelated commits that share a blob', () => {
    let fixture: UnrelatedSharedBlobFixture;

    beforeAll(async () => {
      fixture = await buildUnrelatedSharedBlobFixture();
    }, SETUP_TIMEOUT);

    afterAll(async () => rm(fixture.dir, { recursive: true, force: true }));

    describe('When revList walks the objects closure from the want excluding the unrelated tip', () => {
      it('Then the shared blob is still emitted — the set matches git rev-list --objects want ^T', async () => {
        // Arrange
        const expected = gitIdSet(
          fixture.dir,
          '--objects',
          fixture.wantTip,
          '--not',
          fixture.notTip,
        );
        const ctx = createNodeContext({ workDir: fixture.dir });
        const sut = revList;

        // Act
        const result = await sut(ctx, {
          wants: [fixture.wantTip],
          not: [fixture.notTip],
          objects: true,
        });

        // Assert
        const actual = new Set(result.entries.map((entry) => entry.id));
        expect([...actual].sort()).toEqual([...expected].sort());
      });
    });
  });
  describe('Given a linear history whose edge parent lies beyond the requested count', () => {
    let fixture: BoundaryBeyondCountFixture;

    beforeAll(async () => {
      fixture = await buildBoundaryBeyondCountFixture();
    }, SETUP_TIMEOUT);

    afterAll(async () => rm(fixture.dir, { recursive: true, force: true }));

    describe('When revList excludes the root with maxCount 1 under objects', () => {
      it('Then it marks the edge parent tree over the full walk — matching git rev-list --objects -n 1 W3 ^P', async () => {
        // Arrange
        const expected = gitIdSet(
          fixture.dir,
          '--objects',
          '-n',
          '1',
          fixture.w3,
          '--not',
          fixture.notTip,
        );
        const ctx = createNodeContext({ workDir: fixture.dir });
        const sut = revList;

        // Act
        const result = await sut(ctx, {
          wants: [fixture.w3],
          not: [fixture.notTip],
          objects: true,
          maxCount: 1,
        });

        // Assert
        const actual = new Set(result.entries.map((entry) => entry.id));
        expect([...actual].sort()).toEqual([...expected].sort());
      });
    });

    describe('When revList excludes the root under noWalk and objects', () => {
      it('Then noWalk is ignored with a range, matching git rev-list --no-walk --objects W2 ^P', async () => {
        // Arrange
        const expected = gitIdSet(
          fixture.dir,
          '--objects',
          '--no-walk',
          fixture.w2,
          '--not',
          fixture.notTip,
        );
        const ctx = createNodeContext({ workDir: fixture.dir });
        const sut = revList;

        // Act
        const result = await sut(ctx, {
          wants: [fixture.w2],
          not: [fixture.notTip],
          objects: true,
          noWalk: true,
        });

        // Assert
        const actual = new Set(result.entries.map((entry) => entry.id));
        expect([...actual].sort()).toEqual([...expected].sort());
      });
    });
  });

  describe('Given excluded lines reaching the shared ancestor through clock-skewed commits', () => {
    let fixture: SkewedExclusionFixture;

    beforeAll(async () => {
      fixture = await buildSkewedExclusionFixture();
    }, SETUP_TIMEOUT);

    afterAll(async () => rm(fixture.dir, { recursive: true, force: true }));

    describe.each([
      { label: 'six', excluded: () => fixture.farTip, objects: false },
      { label: 'six', excluded: () => fixture.farTip, objects: true },
      { label: 'three', excluded: () => fixture.nearTip, objects: true },
    ])(
      'When revList excludes the line $label commits deep (objects: $objects)',
      ({ excluded, objects }) => {
        it('Then it lists what git rev-list lists, giving up on the excluded side as git does', async () => {
          // Arrange
          const flags = objects ? ['--objects'] : [];
          const expected = gitIdSet(fixture.dir, ...flags, fixture.tip, '--not', excluded());
          const ctx = createNodeContext({ workDir: fixture.dir });
          const sut = revList;

          // Act
          const result = await sut(ctx, { wants: [fixture.tip], not: [excluded()], objects });

          // Assert
          const actual = new Set(result.entries.map((entry) => entry.id));
          expect([...actual].sort()).toEqual([...expected].sort());
        });
      },
    );

    describe('When packObjects packs the tip excluding the line six commits deep', () => {
      it('Then it packs as many objects as git pack-objects --revs', async () => {
        // Arrange
        const out = await mkdtemp(path.join(os.tmpdir(), 'tsgit-skewed-pack-'));
        const stem = runGit(['-C', fixture.dir, 'pack-objects', '--revs', '-q', `${out}/git`], {
          input: `${fixture.tip}\n^${fixture.farTip}\n`,
        }).trim();
        const gitCount = runGit(['show-index'], {
          input: await readFile(`${out}/git-${stem}.idx`),
        })
          .split('\n')
          .filter((line) => line.length > 0).length;
        const ctx = createNodeContext({ workDir: fixture.dir });
        const sut = packObjects;

        // Act
        const result = await sut(ctx, {
          wants: [fixture.tip],
          not: [fixture.farTip],
          outputDirectory: path.join(fixture.dir, '.git', 'tsgit-pack-out'),
        });

        // Assert
        expect(result.objectCount).toBe(gitCount);
        await rm(out, { recursive: true, force: true });
      });
    });

    describe('When revList lists, with objects, a want whose listed ancestor the excluded side reaches late', () => {
      it("Then that ancestor's tree is excluded as git rev-list --objects excludes it", async () => {
        // Arrange
        const expected = gitIdSet(
          fixture.dir,
          '--objects',
          fixture.sharedTreeTip,
          '--not',
          fixture.lateTip,
        );
        const ctx = createNodeContext({ workDir: fixture.dir });
        const sut = revList;

        // Act
        const result = await sut(ctx, {
          wants: [fixture.sharedTreeTip],
          not: [fixture.lateTip],
          objects: true,
        });

        // Assert
        const actual = new Set(result.entries.map((entry) => entry.id));
        expect([...actual].sort()).toEqual([...expected].sort());
      });
    });
  });
  describe('Given tag, tree and blob tips on either side of a range', () => {
    let dir: string;

    beforeAll(async () => {
      dir = await buildNonCommitTipFixture();
    }, SETUP_TIMEOUT);

    afterAll(async () => rm(dir, { recursive: true, force: true }));

    describe.each([
      { wants: ['tip-tree'], not: ['tip-tree'] },
      { wants: ['main', 'base-tree'], not: ['base'] },
      { wants: ['main', 'base-blob'], not: ['base'] },
      { wants: ['tag-tree'], not: ['tip-tree'] },
      { wants: ['tag-tree'], not: ['tag-tree'] },
      { wants: ['main', 'tag-tree'], not: ['tag-tag'] },
      { wants: ['tip-blob'], not: ['tip-tree'] },
      { wants: ['tip-tree'], not: ['main'] },
      { wants: ['tag-base'], not: ['base'] },
    ])('When revList lists $wants ^$not with objects', ({ wants, not }) => {
      it('Then it shows the pending objects git rev-list --objects shows', async () => {
        // Arrange
        const expected = gitIdSet(dir, '--objects', ...wants, '--not', ...not);
        const ctx = createNodeContext({ workDir: dir });
        const sut = revList;

        // Act
        const result = await sut(ctx, { wants, not, objects: true });

        // Assert
        const actual = new Set(result.entries.map((entry) => entry.id));
        expect([...actual].sort()).toEqual([...expected].sort());
      });
    });
  });
  describe('Given a merge whose first parent is dated before its second', () => {
    let fixture: SkewedMergeFixture;

    beforeAll(async () => {
      fixture = await buildSkewedMergeFixture();
    }, SETUP_TIMEOUT);

    afterAll(async () => rm(fixture.dir, { recursive: true, force: true }));

    describe.each([
      { wants: ['m'], flags: [], maxCount: 2 },
      { wants: ['t', 'm'], flags: ['--first-parent'], maxCount: 3 },
      { wants: ['t', 'm'], flags: ['--objects'], maxCount: 3 },
    ])('When revList walks $wants $flags with maxCount $maxCount', ({ wants, flags, maxCount }) => {
      it('Then it keeps the commits git rev-list -n shows first, in commit-date order', async () => {
        // Arrange
        const tips = wants.map((name) => fixture.ids[name] as string);
        const expected = gitIdSet(fixture.dir, ...flags, '-n', `${maxCount}`, ...tips);
        const ctx = createNodeContext({ workDir: fixture.dir });
        const sut = revList;

        // Act
        const result = await sut(ctx, {
          wants: tips,
          maxCount,
          firstParent: flags.includes('--first-parent'),
          objects: flags.includes('--objects'),
        });

        // Assert
        const actual = new Set(result.entries.map((entry) => entry.id));
        expect([...actual].sort()).toEqual([...expected].sort());
      });
    });
  });
});

/** One commit on `main`, then each of `looseRefs` written verbatim under `.git/`. */
const buildLooseRefFixture = async (
  looseRefs: Readonly<Record<string, string>>,
): Promise<string> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-rev-list-all-broken-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'A U Thor');
  git(dir, 'config', 'user.email', 'author@example.com');
  commit(dir, 'base', 1_700_000_000, ['--allow-empty']);
  for (const [name, content] of Object.entries(looseRefs)) {
    await writeFile(path.join(dir, '.git', name), content);
  }
  return dir;
};

/** git's `die("bad object %s")` line, rebuilt from the refusal's structured data. */
const badObjectLine = (error: unknown): string =>
  `fatal: bad object ${String((error as { data?: { id?: string } }).data?.id)}\n`;

describe.skipIf(!GIT_AVAILABLE)('rev-list all interop — broken refs', () => {
  const dirs: string[] = [];
  afterAll(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  describe.each([
    ['a loose branch holding garbage', { 'refs/heads/broken': 'garbage\n' }],
    ['two broken branches', { 'refs/heads/z-broken': 'garbage\n', 'refs/heads/a-broken': 'x\n' }],
    [
      'a symbolic branch whose target is broken',
      { 'refs/heads/zz': 'garbage\n', 'refs/heads/aa': 'ref: refs/heads/zz\n' },
    ],
    ['a branch naming an absent object', { 'refs/heads/missing': `${'1'.repeat(40)}\n` }],
    [
      'an absent object after a broken branch',
      { 'refs/heads/b-missing': `${'1'.repeat(40)}\n`, 'refs/heads/a-broken': 'x\n' },
    ],
  ] as const)('Given %s', (_label, looseRefs) => {
    describe('When rev-list --all runs on both tools', () => {
      it('Then both refuse with the same bad-object line', async () => {
        // Arrange
        const dir = await buildLooseRefFixture(looseRefs);
        dirs.push(dir);
        const peer = tryRunGitWithExit(['-C', dir, 'rev-list', '--all']);
        const sut = revList;

        // Act
        let caught: unknown;
        try {
          await sut(createNodeContext({ workDir: dir }), { all: true });
        } catch (error) {
          caught = error;
        }

        // Assert
        expect(peer.exitCode).toBe(128);
        expect(badObjectLine(caught)).toBe(peer.stderr);
      });
    });
  });

  describe('Given a symbolic branch whose target does not exist', () => {
    describe('When rev-list --all runs on both tools', () => {
      it('Then both skip it and list the same commits', async () => {
        // Arrange
        const dir = await buildLooseRefFixture({ 'refs/heads/sym': 'ref: refs/heads/nope\n' });
        dirs.push(dir);
        const peer = new Set(git(dir, 'rev-list', '--all').split('\n').filter(Boolean));
        const sut = revList;

        // Act
        const result = await sut(createNodeContext({ workDir: dir }), { all: true });

        // Assert
        expect(new Set(result.entries.map((entry) => entry.id))).toEqual(peer);
      });
    });
  });
});

describe.skipIf(!GIT_AVAILABLE)('rev-list interop — explicit tips naming absent objects', () => {
  const ABSENT = '1'.repeat(40);
  const dirs: string[] = [];
  afterAll(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  describe.each([
    ['an absent full id', [ABSENT], { wants: [ABSENT] }],
    ['a negated absent full id', ['HEAD', `^${ABSENT}`], { wants: ['HEAD', `^${ABSENT}`] }],
    ['an absent full id before an unknown name', [ABSENT, 'nope'], { wants: [ABSENT, 'nope'] }],
    ['the parents of an absent full id', [`${ABSENT}^@`], { wants: [`${ABSENT}^@`] }],
    ['a branch naming an absent object', ['missing'], { wants: ['missing'] }],
    [
      'an excluded branch naming an absent object',
      ['HEAD', '--not', 'missing'],
      { wants: ['HEAD'], not: ['missing'] },
    ],
    ['a tag of an absent commit', ['t'], { wants: ['t'] }],
    ['the parents of a tag of an absent commit', ['t^@'], { wants: ['t^@'] }],
    ['a tag of an absent commit without its parents', ['t^!'], { wants: ['t^!'] }],
    ['a tag of an absent commit without its first parent', ['t^-'], { wants: ['t^-'] }],
  ] as const)('Given %s', (_label, args, opts) => {
    describe('When rev-list runs on both tools', () => {
      it('Then both refuse with the same bad-object line', async () => {
        // Arrange
        const dir = await buildLooseRefFixture({ 'refs/heads/missing': `${ABSENT}\n` });
        dirs.push(dir);
        const tag = runGit(['-C', dir, 'hash-object', '-t', 'tag', '-w', '--stdin'], {
          input: `object ${ABSENT}\ntype commit\ntag t\ntagger a <a@b> 1700000000 +0000\n\nt\n`,
        }).trim();
        git(dir, 'update-ref', 'refs/tags/t', tag);
        const peer = tryRunGitWithExit(['-C', dir, 'rev-list', ...args]);
        const sut = revList;

        // Act
        let caught: unknown;
        try {
          await sut(createNodeContext({ workDir: dir }), opts);
        } catch (error) {
          caught = error;
        }

        // Assert
        expect(peer.exitCode).toBe(128);
        expect(badObjectLine(caught)).toBe(peer.stderr);
      });
    });
  });
});

describe.skipIf(!GIT_AVAILABLE)('rev-list all interop — other worktrees', () => {
  const openTrackedRepository = trackedRepositories();
  const dirs: string[] = [];
  afterAll(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  /** A repository with a detached linked worktree `wt` one commit ahead of every ref. */
  const buildLinkedFixture = async (): Promise<{ readonly dir: string; readonly wt: string }> => {
    const dir = await buildLooseRefFixture({});
    const wt = `${dir}-wt`;
    dirs.push(dir, wt);
    git(dir, 'worktree', 'add', '-q', '--detach', wt);
    commit(wt, 'linked', 1_700_000_100, ['--allow-empty']);
    return { dir, wt };
  };

  describe('Given a linked worktree whose detached HEAD only it reaches', () => {
    describe('When rev-list --all runs on both tools from the main worktree', () => {
      it('Then both list the same commits', async () => {
        // Arrange
        const { dir } = await buildLinkedFixture();
        const peer = new Set(git(dir, 'rev-list', '--all').split('\n').filter(Boolean));
        const sut = revList;

        // Act
        const result = await sut(createNodeContext({ workDir: dir }), { all: true });

        // Assert
        expect(new Set(result.entries.map(({ id }) => id))).toEqual(peer);
      });
    });
  });

  describe.each([
    ['unreadable', 'garbage\n'],
    ['a dangling symref', 'ref: refs/heads/nope\n'],
  ])('Given a linked worktree whose HEAD is %s', (_label, content) => {
    describe('When rev-list --all runs on both tools from the main worktree', () => {
      it('Then both skip it and list the same commits', async () => {
        // Arrange
        const { dir } = await buildLinkedFixture();
        await writeFile(
          path.join(dir, '.git', 'worktrees', path.basename(`${dir}-wt`), 'HEAD'),
          content,
        );
        const peer = new Set(git(dir, 'rev-list', '--all').split('\n').filter(Boolean));
        const sut = revList;

        // Act
        const result = await sut(createNodeContext({ workDir: dir }), { all: true });

        // Assert
        expect(new Set(result.entries.map(({ id }) => id))).toEqual(peer);
      });
    });
  });

  describe.each([
    ['a linked worktree HEAD', 'linked'],
    ['the main worktree HEAD read from the linked one', 'main'],
  ] as const)('Given %s naming an absent object', (_label, broken) => {
    describe('When rev-list --all runs on both tools', () => {
      it('Then both refuse with the same bad-object line', async () => {
        // Arrange
        const { dir, wt } = await buildLinkedFixture();
        const head =
          broken === 'main'
            ? path.join(dir, '.git', 'HEAD')
            : path.join(dir, '.git', 'worktrees', path.basename(wt), 'HEAD');
        await writeFile(head, `${'1'.repeat(40)}\n`);
        const from = broken === 'main' ? wt : dir;
        const peer = tryRunGitWithExit(['-C', from, 'rev-list', '--all']);
        const sut = await openTrackedRepository({ cwd: from });

        // Act
        let caught: unknown;
        try {
          await sut.revList({ all: true });
        } catch (error) {
          caught = error;
        }

        // Assert
        expect(peer.exitCode).toBe(128);
        expect(badObjectLine(caught)).toBe(peer.stderr);
      });
    });
  });
});

describe.skipIf(!GIT_AVAILABLE)('rev-list interop — object types assigned in one run', () => {
  const dirs: string[] = [];
  afterAll(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  /** `refs/tags/t` naming a tag that declares `type commit` for blob `B`. */
  const buildMistypedTagFixture = async (): Promise<{
    readonly dir: string;
    readonly blob: string;
  }> => {
    const dir = await buildLooseRefFixture({});
    dirs.push(dir);
    const blob = runGit(['-C', dir, 'hash-object', '-w', '--stdin'], { input: 'hi\n' }).trim();
    const tag = runGit(['-C', dir, 'hash-object', '-t', 'tag', '-w', '--stdin'], {
      input: `object ${blob}\ntype commit\ntag t\ntagger a <a@b> 1700000000 +0000\n\nt\n`,
    }).trim();
    git(dir, 'update-ref', '--no-deref', 'refs/tags/t', tag);
    return { dir, blob };
  };

  /** git's stderr, rebuilt from the logged `error:` lines and the refusal's data. */
  const stderrOf = (logged: ReadonlyArray<string>, error: unknown): string =>
    `${logged.map((line) => `error: ${line}\n`).join('')}${badObjectLine(error)}`;

  const capturing = (dir: string): { readonly ctx: Context; readonly logged: string[] } => {
    const logged: string[] = [];
    const base = createNodeContext({ workDir: dir });
    return { ctx: { ...base, logger: { error: (line: string) => logged.push(line) } }, logged };
  };

  describe.each([
    ['the tag alone', () => ['t'], () => ({ wants: ['t'] })],
    ['every ref', () => ['--all'], () => ({ all: true })],
    [
      'the blob, then the tag',
      (blob: string) => ['--objects', blob, 't'],
      (blob: string) => ({ wants: [blob, 't'], objects: true }),
    ],
  ] as const)('Given a tag declaring a commit for a blob, walked from %s', (_label, args, opts) => {
    describe('When rev-list runs on both tools', () => {
      it('Then both log the same typing errors and refuse the same bad object', async () => {
        // Arrange
        const { dir, blob } = await buildMistypedTagFixture();
        const peer = tryRunGitWithExit(['-C', dir, 'rev-list', ...args(blob)]);
        const { ctx, logged } = capturing(dir);
        const sut = revList;

        // Act
        let caught: unknown;
        try {
          await sut(ctx, opts(blob));
        } catch (error) {
          caught = error;
        }

        // Assert
        expect(peer.exitCode).toBe(128);
        expect(stderrOf(logged, caught)).toBe(peer.stderr);
      });
    });
  });

  describe('Given a tag declaring a commit for a blob', () => {
    describe('When pack-objects --revs reads it on both tools', () => {
      it('Then both log the same typing error and refuse the same bad object', async () => {
        // Arrange
        const { dir } = await buildMistypedTagFixture();
        const peer = tryRunGitWithExit(['-C', dir, 'pack-objects', '--revs', '--stdout'], {
          input: 't\n',
        });
        const { ctx, logged } = capturing(dir);
        const sut = packObjects;

        // Act
        let caught: unknown;
        try {
          await sut(ctx, { wants: ['t'] });
        } catch (error) {
          caught = error;
        }

        // Assert
        expect(peer.exitCode).toBe(128);
        expect(stderrOf(logged, caught)).toBe(peer.stderr);
      });
    });
  });

  const IDENT_LINES = 'author a <a@b> 1700000000 +0000\ncommitter a <a@b> 1700000000 +0000\n\nm\n';

  /** A commit stored as spelt, naming `tree` and `parents` whatever they are. */
  const writeLiteralCommit = (dir: string, tree: string, parents: ReadonlyArray<string>): string =>
    runGit(['-C', dir, 'hash-object', '-t', 'commit', '-w', '--stdin', '--literally'], {
      input: `tree ${tree}\n${parents.map((p) => `parent ${p}\n`).join('')}${IDENT_LINES}`,
    }).trim();

  const emptyTreeOf = (dir: string): string => runGit(['-C', dir, 'mktree'], { input: '' }).trim();

  describe.each([
    ['its tree', (dir: string, blob: string) => writeLiteralCommit(dir, blob, [])],
    ['a parent', (dir: string, blob: string) => writeLiteralCommit(dir, emptyTreeOf(dir), [blob])],
  ] as const)('Given a blob tip before a commit naming it as %s', (_label, commitNaming) => {
    describe('When rev-list parses the commit on both tools', () => {
      it('Then both log the same bad pointer and refuse the same bad object', async () => {
        // Arrange
        const { dir, blob } = await buildMistypedTagFixture();
        const named = commitNaming(dir, blob);
        const peer = tryRunGitWithExit(['-C', dir, 'rev-list', blob, named]);
        const { ctx, logged } = capturing(dir);
        const sut = revList;

        // Act
        let caught: unknown;
        try {
          await sut(ctx, { wants: [blob, named] });
        } catch (error) {
          caught = error;
        }

        // Assert
        expect(peer.exitCode).toBe(128);
        expect(stderrOf(logged, caught)).toBe(peer.stderr);
      });
    });
  });

  /** git's walk death, rebuilt from the refusal's data. */
  const walkFatalOf = (error: unknown): string => {
    const commit = (error as { data?: { commit?: string } }).data?.commit;
    return commit === undefined
      ? 'fatal: revision walk setup failed\n'
      : `fatal: Failed to traverse parents of commit ${commit}\n`;
  };

  const walkStderrOf = (logged: ReadonlyArray<string>, error: unknown): string =>
    `${logged.map((line) => `error: ${line}\n`).join('')}${walkFatalOf(error)}`;

  const settled = async (run: () => Promise<unknown>): Promise<unknown> => {
    try {
      await run();
    } catch (error) {
      return error;
    }
    return undefined;
  };

  describe.each([
    ['its tree', (dir: string, blob: string) => writeLiteralCommit(dir, blob, [])],
    ['a parent', (dir: string, blob: string) => writeLiteralCommit(dir, emptyTreeOf(dir), [blob])],
  ] as const)(
    'Given a blob tip before a commit whose parent names it as %s',
    (_label, parentNaming) => {
      describe.each([
        ['rev-list', false],
        ['rev-list --objects', true],
      ] as const)('When %s walks to that parent on both tools', (_command, objects) => {
        it('Then both log the same bad pointer and fail to traverse the same commit', async () => {
          // Arrange
          const { dir, blob } = await buildMistypedTagFixture();
          const child = writeLiteralCommit(dir, emptyTreeOf(dir), [parentNaming(dir, blob)]);
          const flags = objects ? ['--objects'] : [];
          const peer = tryRunGitWithExit(['-C', dir, 'rev-list', ...flags, blob, child]);
          const { ctx, logged } = capturing(dir);
          const sut = revList;

          // Act
          const result = await settled(() => sut(ctx, { wants: [blob, child], objects }));

          // Assert
          expect(peer.exitCode).toBe(128);
          expect(walkStderrOf(logged, result)).toBe(peer.stderr);
        });
      });
    },
  );

  describe('Given a blob, an annotated tag of it and a tree wanted without --objects', () => {
    describe('When rev-list lists them on both tools', () => {
      it('Then neither lists anything, commits being all git shows then', async () => {
        // Arrange
        const { dir, blob } = await buildMistypedTagFixture();
        runGit(['-C', dir, 'tag', '-a', 'tb', '-m', 'tb', blob]);
        const tree = emptyTreeOf(dir);
        const peer = runGit(['-C', dir, 'rev-list', blob, 'tb', tree]);
        const sut = revList;

        // Act
        const result = await sut(createNodeContext({ workDir: dir }), {
          wants: [blob, 'tb', tree],
        });

        // Assert
        expect(result.entries.map((entry) => `${entry.id}\n`).join('')).toBe(peer);
      });
    });
  });

  describe('Given a blob tip, a newer excluded line and an included line whose parents name it', () => {
    describe('When rev-list limits the walk on both tools', () => {
      it('Then both log the excluded line, go on, and fail the walk setup on the included one', async () => {
        // Arrange
        const { dir, blob } = await buildMistypedTagFixture();
        const empty = emptyTreeOf(dir);
        const excludedParent = writeLiteralCommit(dir, blob, []);
        const excluded = runGit(
          ['-C', dir, 'hash-object', '-t', 'commit', '-w', '--stdin', '--literally'],
          {
            input: `tree ${empty}\nparent ${excludedParent}\n${IDENT_LINES.replaceAll('1700000000', '1700000001')}`,
          },
        ).trim();
        const included = writeLiteralCommit(dir, empty, [writeLiteralCommit(dir, empty, [blob])]);
        const peer = tryRunGitWithExit(['-C', dir, 'rev-list', blob, included, '--not', excluded]);
        const { ctx, logged } = capturing(dir);
        const sut = revList;

        // Act
        const result = await settled(() => sut(ctx, { wants: [blob, included], not: [excluded] }));

        // Assert
        expect(peer.exitCode).toBe(128);
        expect(walkStderrOf(logged, result)).toBe(peer.stderr);
      });
    });
  });

  describe('Given a commit whose parent is a blob nothing typed before', () => {
    describe('When rev-list walks to that parent on both tools', () => {
      it('Then both find it is not a commit and fail to traverse the commit naming it', async () => {
        // Arrange
        const { dir, blob } = await buildMistypedTagFixture();
        const empty = emptyTreeOf(dir);
        const child = writeLiteralCommit(dir, empty, [writeLiteralCommit(dir, empty, [blob])]);
        const peer = tryRunGitWithExit(['-C', dir, 'rev-list', child]);
        const { ctx, logged } = capturing(dir);
        const sut = revList;

        // Act
        const result = await settled(() => sut(ctx, { wants: [child] }));

        // Assert
        expect(peer.exitCode).toBe(128);
        expect(walkStderrOf(logged, result)).toBe(peer.stderr);
      });
    });
  });

  describe('Given a shallow commit whose stored parent is a blob tip before it', () => {
    describe('When rev-list --objects parses the commit on both tools', () => {
      it('Then neither types the cut parent and both list the same objects in order', async () => {
        // Arrange
        const { dir, blob } = await buildMistypedTagFixture();
        const named = writeLiteralCommit(dir, emptyTreeOf(dir), [blob]);
        await writeFile(path.join(dir, '.git', 'shallow'), `${named}\n`);
        const peer = runGit(['-C', dir, 'rev-list', '--objects', blob, named]);
        const { ctx, logged } = capturing(dir);
        const sut = revList;

        // Act
        const result = await sut(ctx, { wants: [blob, named], objects: true });

        // Assert
        const listed = result.entries.map((e) => `${e.id} ${e.path ?? ''}`.trimEnd());
        expect({ listed, logged }).toEqual({
          listed: peer.split('\n').flatMap((line) => (line === '' ? [] : [line.trimEnd()])),
          logged: [],
        });
      });
    });
  });

  /** A tree stored as spelt: `[mode, name, id]` entries, whatever their objects are. */
  const writeLiteralTree = (
    dir: string,
    entries: ReadonlyArray<readonly [string, string, string]>,
  ): string =>
    runGit(['-C', dir, 'hash-object', '-t', 'tree', '-w', '--stdin', '--literally'], {
      input: Buffer.concat(
        entries.map(([mode, name, id]) =>
          Buffer.concat([Buffer.from(`${mode} ${name}\0`), Buffer.from(id, 'hex')]),
        ),
      ),
    }).trim();

  /** git's `process_tree_contents` death, rebuilt from the refusal's data. */
  const entryMismatchLine = (error: unknown): string => {
    const { tree, entry, mode } = (error as { data: { tree: string; entry: string; mode: string } })
      .data;
    return `fatal: entry '${entry}' in tree ${tree} has ${mode} mode, but is not a ${mode}\n`;
  };

  describe.each([
    [
      'one tree listed as a tree, then as a blob',
      (dir: string) => {
        const empty = emptyTreeOf(dir);
        return {
          tips: [],
          tree: writeLiteralTree(dir, [
            ['40000', 'a', empty],
            ['100644', 'b', empty],
          ]),
        };
      },
    ],
    [
      'a blob tip listed as a tree',
      (dir: string, blob: string) => ({
        tips: [blob],
        tree: writeLiteralTree(dir, [['40000', 'b', blob]]),
      }),
    ],
  ] as const)('Given %s', (_label, layout) => {
    describe('When rev-list --objects walks it on both tools', () => {
      it('Then both log the same typing error and die on the same entry', async () => {
        // Arrange
        const { dir, blob } = await buildMistypedTagFixture();
        const { tips, tree } = layout(dir, blob);
        const named = writeLiteralCommit(dir, tree, []);
        const peer = tryRunGitWithExit(['-C', dir, 'rev-list', '--objects', ...tips, named]);
        const { ctx, logged } = capturing(dir);
        const sut = revList;

        // Act
        let caught: unknown;
        try {
          await sut(ctx, { wants: [...tips, named], objects: true });
        } catch (error) {
          caught = error;
        }

        // Assert
        expect(peer.exitCode).toBe(128);
        expect(
          `${logged.map((line) => `error: ${line}\n`).join('')}${entryMismatchLine(caught)}`,
        ).toBe(peer.stderr);
      });
    });
  });

  describe('Given the tag and its blob walked by two concurrent runs', () => {
    describe('When rev-list runs both at once on both tools', () => {
      it('Then only the tag run refuses, the blob run listing the blob as git does', async () => {
        // Arrange
        const { dir, blob } = await buildMistypedTagFixture();
        const tagPeer = tryRunGitWithExit(['-C', dir, 'rev-list', 't']);
        const blobPeer = tryRunGitWithExit(['-C', dir, 'rev-list', '--objects', blob]);
        const { ctx, logged } = capturing(dir);
        const sut = revList;

        // Act
        const [tagRun, blobRun] = await Promise.allSettled([
          sut(ctx, { wants: ['t'] }),
          sut(ctx, { wants: [blob], objects: true }),
        ]);

        // Assert
        const tagError = tagRun.status === 'rejected' ? tagRun.reason : undefined;
        const listed = blobRun.status === 'fulfilled' ? blobRun.value.entries : [];
        expect({ tag: stderrOf(logged, tagError), blob: listed.map((e) => `${e.id} \n`) }).toEqual({
          tag: tagPeer.stderr,
          blob: [blobPeer.stdout],
        });
      });
    });
  });
});
