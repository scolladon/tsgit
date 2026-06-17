/**
 * Cross-tool interop — `show`. Builds a repository with canonical git
 * (deterministic author/committer dates, signing off), then asserts that the
 * `git show` stream **reconstructed** from `show`'s structured `ShowResult`
 * (via the relocated default renderers + the `renderPatch` serializer) is
 * byte-identical to real `git show` across every object kind: root / modify /
 * rename commits, annotated and lightweight tags, trees (by peel and by raw
 * oid), a blob, a multi-rev stream, and `<rev>:<path>` lookups. Merges are
 * pinned against `git show -m` (the `perParent` structure; git's textual
 * combined diff is not a library surface).
 *
 * @proves
 *   surface:        show
 *   bucket:         cross-tool-interop
 *   unique:         `show`'s structured data reconstructs canonical `git show` byte-for-byte
 *   interopSurface: show
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { show } from '../../src/application/commands/show.js';
import type { Context } from '../../src/ports/context.js';
import { GIT_AVAILABLE, git, runGit, runGitEnv } from './interop-helpers.js';
import { reconstructShow } from './show-render/reconstruct.js';

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

const dateEnv = (epoch: number): NodeJS.ProcessEnv => ({
  ...runGitEnv(),
  GIT_AUTHOR_NAME: 'A U Thor',
  GIT_AUTHOR_EMAIL: 'author@example.com',
  GIT_AUTHOR_DATE: `${epoch} +0000`,
  GIT_COMMITTER_NAME: 'A U Thor',
  GIT_COMMITTER_EMAIL: 'author@example.com',
  GIT_COMMITTER_DATE: `${epoch} +0000`,
});

const writeRepoFile = async (dir: string, rel: string, content: string): Promise<void> => {
  const full = path.join(dir, rel);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, content);
};

interface Built {
  readonly dir: string;
  readonly ctx: Context;
  readonly root: string;
  readonly modify: string;
  readonly merge: string;
  readonly rename: string;
  readonly tree: string;
  readonly blob: string;
  /** A merge that combines changes to different lines from both sides. */
  readonly combinedMerge: string;
  /** A three-parent octopus merge. */
  readonly octopus: string;
}

const buildRepo = async (dir: string): Promise<Built> => {
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'A U Thor');
  git(dir, 'config', 'user.email', 'author@example.com');
  // git with pinned author/committer dates (date-sensitive verbs only).
  const dated = (epoch: number, ...args: string[]): string =>
    runGit(['-C', dir, ...args], { env: dateEnv(epoch) });

  await writeRepoFile(dir, 'a.txt', 'hello\nworld\n');
  await writeRepoFile(dir, 'sub/b.txt', 'nested\n');
  git(dir, 'add', '-A');
  dated(1_700_000_000, 'commit', '-q', '-m', 'initial commit', '-m', 'second paragraph of body');
  const root = git(dir, 'rev-parse', 'HEAD').trim();

  await writeRepoFile(dir, 'a.txt', 'hello\nWORLD\nextra\n');
  git(dir, 'add', '-A');
  dated(1_700_000_100, 'commit', '-q', '-m', 'modify a.txt');
  const modify = git(dir, 'rev-parse', 'HEAD').trim();

  dated(1_700_000_100, 'tag', '-a', 'v1.0', '-m', 'release one');
  git(dir, 'tag', 'light', modify);

  git(dir, 'checkout', '-q', '-b', 'feature', root);
  await writeRepoFile(dir, 'c.txt', 'feature line\n');
  git(dir, 'add', '-A');
  dated(1_700_000_200, 'commit', '-q', '-m', 'feature commit');
  git(dir, 'checkout', '-q', 'main');
  dated(1_700_000_300, 'merge', '--no-ff', 'feature', '-m', 'merge feature');
  const merge = git(dir, 'rev-parse', 'HEAD').trim();

  git(dir, 'mv', 'a.txt', 'renamed.txt');
  dated(1_700_000_400, 'commit', '-q', '-m', 'rename a.txt');
  const rename = git(dir, 'rev-parse', 'HEAD').trim();

  // A non-trivial merge: each side edits a different line of m.txt, so each
  // parent's diff is distinct (exercises per-parent reconstruction).
  await writeRepoFile(dir, 'm.txt', 'l1\nl2\nl3\nl4\nl5\n');
  git(dir, 'add', '-A');
  dated(1_700_000_500, 'commit', '-q', '-m', 'add m.txt');
  const mbase = git(dir, 'rev-parse', 'HEAD').trim();
  git(dir, 'checkout', '-q', '-b', 'side', mbase);
  await writeRepoFile(dir, 'm.txt', 'l1\nSIDE2\nl3\nl4\nl5\n');
  git(dir, 'add', '-A');
  dated(1_700_000_600, 'commit', '-q', '-m', 'side change l2');
  git(dir, 'checkout', '-q', 'main');
  await writeRepoFile(dir, 'm.txt', 'l1\nl2\nl3\nMAIN4\nl5\n');
  git(dir, 'add', '-A');
  dated(1_700_000_700, 'commit', '-q', '-m', 'main change l4');
  dated(1_700_000_800, 'merge', '--no-ff', 'side', '-m', 'combined merge');
  const combinedMerge = git(dir, 'rev-parse', 'HEAD').trim();

  // A three-parent octopus merge: each branch edits a distinct file.
  await writeRepoFile(dir, 'o.txt', 'l1\nl2\n');
  await writeRepoFile(dir, 'p.txt', 'l1\nl2\n');
  await writeRepoFile(dir, 'q.txt', 'l1\nl2\n');
  git(dir, 'add', '-A');
  dated(1_700_000_900, 'commit', '-q', '-m', 'add octopus files');
  const obase = git(dir, 'rev-parse', 'HEAD').trim();
  git(dir, 'checkout', '-q', '-b', 'octoA', obase);
  await writeRepoFile(dir, 'o.txt', 'l1\nAAA\n');
  git(dir, 'add', '-A');
  dated(1_700_001_000, 'commit', '-q', '-m', 'octoA change o.txt');
  git(dir, 'checkout', '-q', '-b', 'octoB', obase);
  await writeRepoFile(dir, 'p.txt', 'l1\nBBB\n');
  git(dir, 'add', '-A');
  dated(1_700_001_100, 'commit', '-q', '-m', 'octoB change p.txt');
  git(dir, 'checkout', '-q', 'main');
  await writeRepoFile(dir, 'q.txt', 'l1\nCCC\n');
  git(dir, 'add', '-A');
  dated(1_700_001_200, 'commit', '-q', '-m', 'main change q.txt');
  dated(1_700_001_300, 'merge', '--no-ff', 'octoA', 'octoB', '-m', 'octopus merge');
  const octopus = git(dir, 'rev-parse', 'HEAD').trim();

  const tree = git(dir, 'rev-parse', `${modify}^{tree}`).trim();
  const blob = git(dir, 'rev-parse', `${modify}:a.txt`).trim();
  return {
    dir,
    ctx: createNodeContext({ workDir: dir }),
    root,
    modify,
    merge,
    rename,
    tree,
    blob,
    combinedMerge,
    octopus,
  };
};

describe.skipIf(!GIT_AVAILABLE)('show interop', () => {
  let dir: string;
  let built: Built;

  // `show` is read-only, so the fixture repo is built once and shared. The
  // generous timeout absorbs the ~dozen synchronous `git` spawns (incl. merges)
  // under parallel integration load, where a per-test build times out.
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-interop-show-'));
    built = await buildRepo(dir);
  }, 60_000);

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // Reconstruct git's default `git show <rev>` from the structured result.
  const expectMatch = async (rev: string): Promise<void> => {
    const expected = git(dir, 'show', '--no-color', rev);
    const result = await show(built.ctx, rev);
    const bytes = await reconstructShow(built.ctx, [{ result, rev }]);
    expect(decode(bytes)).toBe(expected);
  };

  // Merges are pinned against `git show -m` (one diff per parent), mirroring
  // the `perParent` structure.
  const expectMatchMerge = async (rev: string): Promise<void> => {
    const expected = git(dir, 'show', '--no-color', '-m', rev);
    const result = await show(built.ctx, rev);
    const bytes = await reconstructShow(built.ctx, [{ result, rev }]);
    expect(decode(bytes)).toBe(expected);
  };

  describe('Given a single revision', () => {
    it('Then a root commit reconstructs git show', async () => {
      await expectMatch(built.root);
    });
    it('Then a non-root commit reconstructs git show', async () => {
      await expectMatch(built.modify);
    });
    it('Then a rename commit reconstructs git show', async () => {
      await expectMatch(built.rename);
    });
    it('Then an annotated tag reconstructs git show', async () => {
      await expectMatch('v1.0');
    });
    it('Then a lightweight tag reconstructs as its commit', async () => {
      await expectMatch('light');
    });
    it('Then a tree by peel echoes the input and reconstructs git show', async () => {
      await expectMatch(`${built.modify}^{tree}`);
    });
    it('Then a tree by raw oid reconstructs git show', async () => {
      await expectMatch(built.tree);
    });
    it('Then a blob reconstructs git show', async () => {
      await expectMatch(built.blob);
    });
  });

  describe('Given a merge commit', () => {
    it('Then a feature merge reconstructs git show -m', async () => {
      await expectMatchMerge(built.merge);
    });
    it('Then a combined (both-sides-edit) merge reconstructs git show -m', async () => {
      await expectMatchMerge(built.combinedMerge);
    });
    it('Then a three-parent octopus merge reconstructs git show -m', async () => {
      await expectMatchMerge(built.octopus);
    });
  });

  describe('Given multiple revisions', () => {
    it('Then the concatenated stream reconstructs git show A B', async () => {
      // Arrange
      const expected = git(dir, 'show', '--no-color', built.modify, built.root);

      // Act
      const results = await show(built.ctx, [built.modify, built.root]);
      const bytes = await reconstructShow(built.ctx, [
        { result: results[0] as (typeof results)[number], rev: built.modify },
        { result: results[1] as (typeof results)[number], rev: built.root },
      ]);

      // Assert
      expect(decode(bytes)).toBe(expected);
    });
  });

  describe('Given a <rev>:<path> tree lookup', () => {
    it('Then a blob path reconstructs the raw blob', async () => {
      await expectMatch(`${built.modify}:a.txt`);
    });
    it('Then a nested blob path resolves through sub-trees', async () => {
      await expectMatch(`${built.modify}:sub/b.txt`);
    });
    it('Then an empty path lists the root tree, echoing the input', async () => {
      await expectMatch(`${built.modify}:`);
    });
    it('Then a sub-directory path lists that tree, echoing the input', async () => {
      await expectMatch(`${built.modify}:sub`);
    });
  });

  describe('Given withStat', () => {
    it('Then a single-file change carries the per-file counts', async () => {
      // Arrange / Act
      const result = await show(built.ctx, built.modify, { withStat: true });

      // Assert — `modify` edits a.txt: structured counts present on the change.
      if (result.kind !== 'commit' || result.patch === undefined) {
        throw new Error('expected a commit with a patch');
      }
      expect(result.patch.changes[0]).toMatchObject({ added: 2, deleted: 1, binary: false });
    });
  });
});
