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
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { revList } from '../../src/application/commands/rev-list.js';
import type { Context } from '../../src/ports/context.js';
import { GIT_AVAILABLE, git, runGit, runGitEnv } from './interop-helpers.js';

const SETUP_TIMEOUT = 60_000;

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

describe.skipIf(!GIT_AVAILABLE)('rev-list objects interop — closure prune', () => {
  describe('Given a shared-subtree history whose tip reuses its parent tree verbatim', () => {
    let fixture: SharedSubtreeFixture;

    beforeAll(async () => {
      fixture = await buildSharedSubtreeFixture();
    }, SETUP_TIMEOUT);

    afterAll(async () => rm(fixture.dir, { recursive: true, force: true }));

    describe('When revList walks the objects closure from HEAD', () => {
      it('Then the object id set matches git rev-list --objects HEAD exactly', async () => {
        // Arrange
        const expected = gitIdSet(fixture.dir, '--objects', 'HEAD');
        const sut = revList;

        // Act
        const result = await sut(fixture.ctx, { wants: ['HEAD'], objects: true });

        // Assert
        const actual = new Set(result.entries.map((entry) => entry.id));
        expect([...actual].sort()).toEqual([...expected].sort());
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
});
