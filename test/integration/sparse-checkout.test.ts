/**
 * Integration — sparse checkout end to end (Phase 17.3).
 *
 * Drives the real command surface through the memory adapter and asserts
 * observable state: files on disk, index entry skip-worktree flags, the
 * committed tree's path set, and `status` cleanliness. Covers the full cone
 * lifecycle and the non-cone lifecycle, the `checkout`/`status`/`add --all`
 * integrations,
 * and the dirty-file retention policy. A final `describe.skipIf` block
 * cross-checks tsgit's index + pattern file against canonical `git`.
 *
 * @proves
 *   surface: sparseCheckout
 *   bucket:  multi-adapter-parity
 *   unique:  cone + non-cone lifecycles, skip-worktree flags, status truthfulness end to end
 */
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../src/adapters/memory/memory-adapter.js';
import { add } from '../../src/application/commands/add.js';
import { branch } from '../../src/application/commands/branch.js';
import { checkout } from '../../src/application/commands/checkout.js';
import { commit } from '../../src/application/commands/commit.js';
import { init } from '../../src/application/commands/init.js';
import { sparseCheckout } from '../../src/application/commands/sparse-checkout.js';
import { status } from '../../src/application/commands/status.js';
import { __resetConfigCacheForTests } from '../../src/application/primitives/config-read.js';
import { readIndex } from '../../src/application/primitives/read-index.js';
import { readTree } from '../../src/application/primitives/read-tree.js';
import { walkTree } from '../../src/application/primitives/walk-tree.js';
import type { AuthorIdentity, ObjectId } from '../../src/domain/objects/index.js';
import { isDirectory } from '../../src/domain/objects/index.js';
import { openRepository } from '../../src/index.node.js';
import type { Context } from '../../src/ports/context.js';

const author: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

afterEach(() => {
  __resetConfigCacheForTests();
});

/** Seed a memory-adapter repo with `tree`, stage everything, and commit it. */
const seedRepo = async (tree: Readonly<Record<string, string>>): Promise<Context> => {
  const ctx = createMemoryContext();
  await init(ctx);
  for (const [name, content] of Object.entries(tree)) {
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/${name}`, content);
  }
  await add(ctx, Object.keys(tree));
  await commit(ctx, { message: 'seed', author });
  return ctx;
};

/** Paths whose working-tree file is present on disk, sorted. */
const filesOnDisk = async (ctx: Context, candidates: ReadonlyArray<string>): Promise<string[]> => {
  const present: string[] = [];
  for (const candidate of candidates) {
    if (await ctx.fs.exists(`${ctx.layout.workDir}/${candidate}`)) present.push(candidate);
  }
  return present.sort();
};

/** Index entry paths carrying the skip-worktree bit, sorted. */
const skipWorktreePaths = async (ctx: Context): Promise<string[]> => {
  const idx = await readIndex(ctx);
  return idx.entries
    .filter((entry) => entry.flags.skipWorktree)
    .map((entry) => entry.path)
    .sort();
};

/** All blob paths reachable from a commit's tree, sorted. */
const treePaths = async (ctx: Context, commitId: ObjectId): Promise<string[]> => {
  const tree = await readTree(ctx, commitId);
  const paths: string[] = [];
  for await (const entry of walkTree(ctx, tree.id)) {
    if (!isDirectory(entry.mode)) paths.push(entry.path);
  }
  return paths.sort();
};

const indexPaths = async (ctx: Context): Promise<string[]> =>
  (await readIndex(ctx)).entries.map((entry) => entry.path).sort();

describe('integration — sparse checkout (memory adapter)', () => {
  it('Given a multi-directory repo, When set/reapply/disable cone, Then disk, index flags, status, and commit tree stay git-faithful', async () => {
    // Arrange — four directories plus a root file, all committed.
    const tree: Readonly<Record<string, string>> = {
      'README.md': '# repo\n',
      'src/app/main.ts': 'export const main = 1;\n',
      'src/app/util.ts': 'export const util = 2;\n',
      'src/lib/core.ts': 'export const core = 3;\n',
      'docs/guide.md': '# guide\n',
    };
    const allPaths = Object.keys(tree);
    const sut = await seedRepo(tree);

    // Act — narrow the cone to `src/app` only.
    const setResult = await sparseCheckout(sut, {
      action: 'set',
      patterns: ['src/app'],
      cone: true,
    });

    // Assert — only in-cone files materialise; the root file is always in.
    expect(setResult.kind).toBe('applied');
    expect(await filesOnDisk(sut, allPaths)).toEqual([
      'README.md',
      'src/app/main.ts',
      'src/app/util.ts',
    ]);
    // The index still records EVERY tracked entry — nothing is dropped.
    expect(await indexPaths(sut)).toEqual([...allPaths].sort());
    // The excluded entries (and only those) carry the skip-worktree bit.
    expect(await skipWorktreePaths(sut)).toEqual(['docs/guide.md', 'src/lib/core.ts']);
    // The index serialises as v3 because a skip-worktree entry exists.
    expect((await readIndex(sut)).version).toBe(3);

    // Assert — `status` reports clean: no phantom `deleted` for excluded files.
    const sparseStatus = await status(sut);
    expect(sparseStatus.clean).toBe(true);
    expect(sparseStatus.workingTreeChanges).toEqual([]);

    // Act — edit an in-cone file and commit.
    await sut.fs.writeUtf8(`${sut.layout.workDir}/src/app/main.ts`, 'export const main = 99;\n');
    await add(sut, ['src/app/main.ts']);
    const committed = await commit(sut, { message: 'edit in-cone', author });

    // Assert — the new commit's tree STILL contains the excluded paths.
    expect(await treePaths(sut, committed.id)).toEqual([...allPaths].sort());

    // Act — reapply is idempotent; disk and flags are unchanged.
    const reapplyResult = await sparseCheckout(sut, { action: 'reapply' });
    expect(reapplyResult.kind).toBe('applied');
    expect(await filesOnDisk(sut, allPaths)).toEqual([
      'README.md',
      'src/app/main.ts',
      'src/app/util.ts',
    ]);
    expect(await skipWorktreePaths(sut)).toEqual(['docs/guide.md', 'src/lib/core.ts']);

    // Act — disable restores every file and clears every skip-worktree bit.
    const disableResult = await sparseCheckout(sut, { action: 'disable' });

    // Assert — full materialization, no skip-worktree entries, index back to v2.
    expect(disableResult.kind).toBe('applied');
    expect(await filesOnDisk(sut, allPaths)).toEqual([...allPaths].sort());
    expect(await skipWorktreePaths(sut)).toEqual([]);
    expect((await readIndex(sut)).version).toBe(2);
  });

  it('Given a repo, When set non-cone gitignore-style patterns, Then materialization and list match the raw patterns', async () => {
    // Arrange.
    const tree: Readonly<Record<string, string>> = {
      'README.md': '# repo\n',
      'src/app.ts': 'export const app = 1;\n',
      'src/app.js': 'module.exports = 1;\n',
      'src/vendor/lib.ts': 'export const lib = 2;\n',
      'keep/data.ts': 'export const data = 3;\n',
    };
    const allPaths = Object.keys(tree);
    const sut = await seedRepo(tree);

    // Act — `*.ts` everywhere, but exclude `src/vendor/`; also keep `keep/`.
    const patterns = ['*.ts', '!/src/vendor/', '/keep/'];
    const setResult = await sparseCheckout(sut, { action: 'set', patterns, cone: false });

    // Assert — non-cone last-match-wins: `.ts` minus the vendor subtree, plus keep/.
    expect(setResult.kind).toBe('applied');
    if (setResult.kind === 'applied') expect(setResult.cone).toBe(false);
    expect(await filesOnDisk(sut, allPaths)).toEqual(['keep/data.ts', 'src/app.ts']);
    // `README.md` and `src/app.js` (no `.ts`) and `src/vendor/lib.ts` (negated) are out.
    expect(await skipWorktreePaths(sut)).toEqual(['README.md', 'src/app.js', 'src/vendor/lib.ts']);

    // Act — `list` returns the raw pattern lines verbatim, in file order.
    const listResult = await sparseCheckout(sut, { action: 'list' });

    // Assert.
    expect(listResult).toEqual({ kind: 'list', cone: false, patterns });
  });

  it('Given a sparse cone repo, When checkout switches branch, Then only in-cone files of the new tree materialise', async () => {
    // Arrange — a base commit, then a feature branch adding files in every dir.
    const sut = await seedRepo({
      'README.md': '# repo\n',
      'src/app/main.ts': 'export const main = 1;\n',
      'src/lib/core.ts': 'export const core = 1;\n',
    });
    await branch(sut, { kind: 'create', name: 'feature', startPoint: 'main' });
    await checkout(sut, { target: 'feature' });
    await sut.fs.writeUtf8(`${sut.layout.workDir}/src/app/extra.ts`, 'export const extra = 2;\n');
    await sut.fs.writeUtf8(`${sut.layout.workDir}/src/lib/helper.ts`, 'export const helper = 2;\n');
    await add(sut, ['src/app/extra.ts', 'src/lib/helper.ts']);
    await commit(sut, { message: 'feature work', author });
    await checkout(sut, { target: 'main' });

    // Act — narrow to `src/app`, then switch to the feature branch.
    await sparseCheckout(sut, { action: 'set', patterns: ['src/app'], cone: true });
    await checkout(sut, { target: 'feature' });

    // Assert — only in-cone files of the feature tree are on disk.
    const featurePaths = [
      'README.md',
      'src/app/main.ts',
      'src/app/extra.ts',
      'src/lib/core.ts',
      'src/lib/helper.ts',
    ];
    expect(await filesOnDisk(sut, featurePaths)).toEqual([
      'README.md',
      'src/app/extra.ts',
      'src/app/main.ts',
    ]);
    // The out-of-cone entries of the new tree are skip-worktree.
    expect(await skipWorktreePaths(sut)).toEqual(['src/lib/core.ts', 'src/lib/helper.ts']);
    // The index still holds every feature-branch path.
    expect(await indexPaths(sut)).toEqual([...featurePaths].sort());
    // The sparse repo reads clean after the branch switch.
    expect((await status(sut)).clean).toBe(true);
  });

  it('Given a sparse repo, When add --all runs, Then skip-worktree entries are not phantom-removed; after disable add --all is normal', async () => {
    // Arrange — a sparse cone leaving `docs/` and `src/lib/` out of the worktree.
    const tree: Readonly<Record<string, string>> = {
      'README.md': '# repo\n',
      'src/app/main.ts': 'export const main = 1;\n',
      'src/lib/core.ts': 'export const core = 2;\n',
      'docs/guide.md': '# guide\n',
    };
    const allPaths = Object.keys(tree);
    const sut = await seedRepo(tree);
    await sparseCheckout(sut, { action: 'set', patterns: ['src/app'], cone: true });

    // Act — bulk add over the sparse worktree.
    const sparseAdd = await add(sut, [], { all: true });

    // Assert — the absent skip-worktree files are NOT staged as deletions.
    expect(sparseAdd.removed).toEqual([]);
    // The index still carries every entry, the excluded ones still skip-worktree.
    expect(await indexPaths(sut)).toEqual([...allPaths].sort());
    expect(await skipWorktreePaths(sut)).toEqual(['docs/guide.md', 'src/lib/core.ts']);
    expect((await status(sut)).clean).toBe(true);

    // Act — disable, then add --all again.
    await sparseCheckout(sut, { action: 'disable' });
    const normalAdd = await add(sut, [], { all: true });

    // Assert — no skip-worktree entries remain; add --all behaves normally.
    expect(normalAdd.removed).toEqual([]);
    expect(await skipWorktreePaths(sut)).toEqual([]);

    // A genuinely deleted file IS now staged as removed (no skip-worktree shield).
    await sut.fs.rm(`${sut.layout.workDir}/docs/guide.md`);
    const afterDelete = await add(sut, [], { all: true });
    expect(afterDelete.removed).toEqual(['docs/guide.md']);
  });

  it('Given a modified out-of-cone file, When set narrows the cone, Then it is retained; force removes it', async () => {
    // Arrange — commit two directories, then locally modify a soon-excluded file.
    const sut = await seedRepo({
      'src/app/main.ts': 'export const main = 1;\n',
      'src/lib/core.ts': 'export const core = 1;\n',
    });
    await sut.fs.writeUtf8(`${sut.layout.workDir}/src/lib/core.ts`, 'export const core = 999;\n');

    // Act — narrow to `src/app`; `src/lib/core.ts` is dirty and out of cone.
    const retainResult = await sparseCheckout(sut, {
      action: 'set',
      patterns: ['src/app'],
      cone: true,
    });

    // Assert — the dirty file is retained: surfaced, on disk, NOT skip-worktree.
    expect(retainResult.kind).toBe('applied');
    if (retainResult.kind === 'applied') {
      expect(retainResult.retained).toEqual(['src/lib/core.ts']);
    }
    expect(await sut.fs.exists(`${sut.layout.workDir}/src/lib/core.ts`)).toBe(true);
    expect(await skipWorktreePaths(sut)).toEqual([]);

    // Act — re-run the same `set` with `force: true`.
    const forceResult = await sparseCheckout(sut, {
      action: 'set',
      patterns: ['src/app'],
      cone: true,
      force: true,
    });

    // Assert — force discards the local change: file gone, entry skip-worktree.
    expect(forceResult.kind).toBe('applied');
    if (forceResult.kind === 'applied') expect(forceResult.retained).toEqual([]);
    expect(await sut.fs.exists(`${sut.layout.workDir}/src/lib/core.ts`)).toBe(false);
    expect(await skipWorktreePaths(sut)).toEqual(['src/lib/core.ts']);
  });

  it('Given a sparse cone repo, When add folds in another directory, Then list reports both directories', async () => {
    // Arrange.
    const tree: Readonly<Record<string, string>> = {
      'src/app/main.ts': 'export const main = 1;\n',
      'src/lib/core.ts': 'export const core = 2;\n',
      'docs/guide.md': '# guide\n',
    };
    const allPaths = Object.keys(tree);
    const sut = await seedRepo(tree);
    await sparseCheckout(sut, { action: 'set', patterns: ['src/app'], cone: true });

    // Act — fold `docs` into the cone.
    const addResult = await sparseCheckout(sut, { action: 'add', patterns: ['docs'] });

    // Assert — `docs/` is now materialised; only `src/lib` stays excluded.
    expect(addResult.kind).toBe('applied');
    expect(await filesOnDisk(sut, allPaths)).toEqual(['docs/guide.md', 'src/app/main.ts']);
    expect(await skipWorktreePaths(sut)).toEqual(['src/lib/core.ts']);

    // `list` (cone) returns the sorted recursive directory set.
    const listResult = await sparseCheckout(sut, { action: 'list' });
    expect(listResult).toEqual({ kind: 'list', cone: true, patterns: ['docs', 'src/app'] });
  });
});

const findGit = (): string | undefined => {
  try {
    execFileSync('git', ['--version']);
    return 'git';
  } catch {
    return undefined;
  }
};

const GIT = findGit();

describe.skipIf(GIT === undefined)(
  'integration — sparse checkout interop with canonical git',
  () => {
    let tmpdir: string;

    beforeEach(async () => {
      tmpdir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-sparse-interop-'));
    });

    afterEach(async () => {
      __resetConfigCacheForTests();
      await rm(tmpdir, { recursive: true, force: true });
    });

    it('Given an index tsgit wrote with a skip-worktree entry, When git ls-files -t reads it, Then the S flag is shown', async () => {
      // Arrange — a real on-disk repo driven by tsgit's Node adapter.
      const repo = await openRepository({ cwd: tmpdir });
      try {
        await repo.init();
        const { writeFile, mkdir } = await import('node:fs/promises');
        await writeFile(path.join(tmpdir, 'kept.ts'), 'export const kept = 1;\n');
        await mkdir(path.join(tmpdir, 'out'), { recursive: true });
        await writeFile(path.join(tmpdir, 'out', 'gone.ts'), 'export const gone = 2;\n');
        await repo.add(['kept.ts', 'out/gone.ts']);
        await repo.commit({ message: 'seed', author });

        // Act — narrow the cone so `out/gone.ts` becomes skip-worktree.
        await repo.sparseCheckout({ action: 'set', patterns: ['kept.ts'], cone: true });
        const lsFiles = execFileSync('git', ['-C', tmpdir, 'ls-files', '-t']).toString();

        // Assert — canonical git surfaces the skip-worktree bit as the `S` tag.
        expect(lsFiles).toContain('S out/gone.ts');
        expect(lsFiles).toContain('H kept.ts');
      } finally {
        await repo.dispose();
      }
    });

    it('Given a sparse-checkout file tsgit wrote, When git sparse-checkout list/reapply runs, Then git accepts it', async () => {
      // Arrange — a tsgit-driven repo with a cone pattern file on disk.
      const repo = await openRepository({ cwd: tmpdir });
      try {
        await repo.init();
        const { writeFile, mkdir } = await import('node:fs/promises');
        await mkdir(path.join(tmpdir, 'src'), { recursive: true });
        await writeFile(path.join(tmpdir, 'src', 'main.ts'), 'export const main = 1;\n');
        await mkdir(path.join(tmpdir, 'docs'), { recursive: true });
        await writeFile(path.join(tmpdir, 'docs', 'guide.md'), '# guide\n');
        await repo.add(['src/main.ts', 'docs/guide.md']);
        await repo.commit({ message: 'seed', author });
        await repo.sparseCheckout({ action: 'set', patterns: ['src'], cone: true });

        // Act — canonical git reads the `.git/info/sparse-checkout` tsgit wrote.
        const list = execFileSync('git', ['-C', tmpdir, 'sparse-checkout', 'list']).toString();
        // `reapply` exercises git's own cone parser against the tsgit-written file.
        execFileSync('git', ['-C', tmpdir, 'sparse-checkout', 'reapply']);

        // Assert — git's `list` recognises the cone directory tsgit serialised.
        expect(list.trim().split('\n')).toContain('src');
      } finally {
        await repo.dispose();
      }
    });
  },
);
