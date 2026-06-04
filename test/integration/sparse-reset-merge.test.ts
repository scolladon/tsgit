/**
 * Integration — sparse-checkout awareness in `reset` / `merge`.
 *
 * Drives the real command surface and asserts the property the unit tests
 * cannot: that `status` stays truthful afterwards (no phantom "deleted" entry
 * for an excluded file). A final `describe.skipIf` block cross-checks the
 * index a tsgit `reset --mixed` writes against canonical `git`.
 *
 * @proves
 *   surface: sparseResetMerge
 *   bucket:  multi-adapter-parity
 *   unique:  reset and merge keep skip-worktree truthful and status clean under sparse cones
 */
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../src/adapters/memory/memory-adapter.js';
import { add } from '../../src/application/commands/add.js';
import { branchCreate } from '../../src/application/commands/branch.js';
import { checkout } from '../../src/application/commands/checkout.js';
import { commit } from '../../src/application/commands/commit.js';
import { init } from '../../src/application/commands/init.js';
import { mergeRun } from '../../src/application/commands/merge.js';
import { reset } from '../../src/application/commands/reset.js';
import { sparseCheckoutSet } from '../../src/application/commands/sparse-checkout.js';
import { status } from '../../src/application/commands/status.js';
import { __resetConfigCacheForTests } from '../../src/application/primitives/config-read.js';
import { readIndex } from '../../src/application/primitives/read-index.js';
import type { AuthorIdentity } from '../../src/domain/objects/index.js';
import { openRepository } from '../../src/index.node.js';
import { runGit } from './interop-helpers.js';

const author: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

afterEach(() => {
  __resetConfigCacheForTests();
});

describe('integration — sparse reset/merge (memory adapter)', () => {
  it('Given a sparse cone repo, When reset --mixed rebuilds the index, Then the excluded path stays skip-worktree and status is clean', async () => {
    // Arrange — `docs/guide.md` is out of the `src/app` cone: sparse removed it
    // from disk and set its skip-worktree bit. A non-sparse-aware reset --mixed
    // would rebuild the index WITHOUT that bit, and status would then report
    // the (deliberately absent) file as `deleted`.
    const ctx = createMemoryContext();
    await init(ctx);
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/src/app/main.ts`, 'export const main = 1;\n');
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/docs/guide.md`, '# guide\n');
    await add(ctx, ['src/app/main.ts', 'docs/guide.md']);
    const seed = await commit(ctx, { message: 'seed', author });
    await sparseCheckoutSet(ctx, { patterns: ['src/app'], cone: true });
    expect(await ctx.fs.exists(`${ctx.layout.workDir}/docs/guide.md`)).toBe(false);

    // Act
    await reset(ctx, { mode: 'mixed', target: seed.id });

    // Assert
    const index = await readIndex(ctx);
    expect(index.entries.find((e) => e.path === 'docs/guide.md')?.flags.skipWorktree).toBe(true);
    expect((await status(ctx)).clean).toBe(true);
  });

  it('Given a sparse cone repo with a dirty in-cone file, When reset --hard runs, Then the file reverts, excluded files stay absent, and status is clean', async () => {
    // Arrange
    const ctx = createMemoryContext();
    await init(ctx);
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/src/app/main.ts`, 'export const main = 1;\n');
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/docs/guide.md`, '# guide\n');
    await add(ctx, ['src/app/main.ts', 'docs/guide.md']);
    const seed = await commit(ctx, { message: 'seed', author });
    await sparseCheckoutSet(ctx, { patterns: ['src/app'], cone: true });
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/src/app/main.ts`, 'LOCAL EDIT\n');

    // Act
    await reset(ctx, { mode: 'hard', target: seed.id });

    // Assert — the in-cone file reverts, the excluded file is not re-created.
    expect(await ctx.fs.readUtf8(`${ctx.layout.workDir}/src/app/main.ts`)).toBe(
      'export const main = 1;\n',
    );
    expect(await ctx.fs.exists(`${ctx.layout.workDir}/docs/guide.md`)).toBe(false);
    const index = await readIndex(ctx);
    expect(index.entries.find((e) => e.path === 'docs/guide.md')?.flags.skipWorktree).toBe(true);
    expect((await status(ctx)).clean).toBe(true);
  });

  it('Given a sparse cone repo, When a conflicting merge runs, Then the excluded clean file stays absent and skip-worktree', async () => {
    // Arrange — base has `src/app/main.ts` + `docs/guide.md`; both branches
    // change only the in-cone file (→ conflict). `docs/guide.md` is unchanged
    // everywhere and out of the cone.
    const ctx = createMemoryContext();
    await init(ctx);
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/src/app/main.ts`, 'base\n');
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/docs/guide.md`, '# guide\n');
    await add(ctx, ['src/app/main.ts', 'docs/guide.md']);
    await commit(ctx, { message: 'seed', author });
    await branchCreate(ctx, { name: 'feature' });
    await checkout(ctx, { target: 'feature' });
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/src/app/main.ts`, 'FEATURE\n');
    await add(ctx, ['src/app/main.ts']);
    await commit(ctx, { message: 'on-feature', author });
    await checkout(ctx, { target: 'main' });
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/src/app/main.ts`, 'MAIN\n');
    await add(ctx, ['src/app/main.ts']);
    await commit(ctx, { message: 'on-main', author });
    await sparseCheckoutSet(ctx, { patterns: ['src/app'], cone: true });
    expect(await ctx.fs.exists(`${ctx.layout.workDir}/docs/guide.md`)).toBe(false);

    // Act
    const sut = await mergeRun(ctx, { target: 'feature', author });

    // Assert — the conflict is materialised, the excluded clean file is not.
    expect(sut.kind).toBe('conflict');
    expect(await ctx.fs.readUtf8(`${ctx.layout.workDir}/src/app/main.ts`)).toContain('<<<<<<<');
    expect(await ctx.fs.exists(`${ctx.layout.workDir}/docs/guide.md`)).toBe(false);
    const index = await readIndex(ctx);
    expect(index.entries.find((e) => e.path === 'docs/guide.md')?.flags.skipWorktree).toBe(true);
    // `status` reflects the conflict but never the excluded file: its
    // skip-worktree bit keeps the absent `docs/guide.md` out of the change set.
    const st = await status(ctx);
    expect(st.clean).toBe(false);
    const changedPaths = [...st.indexChanges, ...st.workingTreeChanges].map((c) => c.path);
    expect(changedPaths).not.toContain('docs/guide.md');
  });
});

const findGit = (): string | undefined => {
  try {
    runGit(['--version']);
    return 'git';
  } catch {
    return undefined;
  }
};

const GIT = findGit();

describe.skipIf(GIT === undefined)('integration — sparse reset interop with canonical git', () => {
  let tmpdir: string;

  beforeEach(async () => {
    tmpdir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-sparse-rm-interop-'));
  });

  afterEach(async () => {
    __resetConfigCacheForTests();
    await rm(tmpdir, { recursive: true, force: true });
  });

  it('Given a sparse repo where tsgit ran reset --mixed, When git reads the index, Then the excluded path keeps its skip-worktree flag and git status is clean', async () => {
    // Arrange — a real on-disk repo driven by tsgit's Node adapter.
    const repo = await openRepository({ cwd: tmpdir });
    try {
      await repo.init();
      const { writeFile, mkdir } = await import('node:fs/promises');
      await writeFile(path.join(tmpdir, 'kept.ts'), 'export const kept = 1;\n');
      await mkdir(path.join(tmpdir, 'out'), { recursive: true });
      await writeFile(path.join(tmpdir, 'out', 'gone.ts'), 'export const gone = 2;\n');
      await repo.add(['kept.ts', 'out/gone.ts']);
      const seed = await repo.commit({ message: 'seed', author });
      await repo.sparseCheckout.set({ patterns: ['kept.ts'], cone: true });

      // Act — tsgit rebuilds the index from the same commit.
      await repo.reset({ mode: 'mixed', target: seed.id });

      // Assert — canonical git still sees the skip-worktree (`S`) bit and
      // reports a clean tree (no phantom deletion of `out/gone.ts`).
      const lsFiles = runGit(['-C', tmpdir, 'ls-files', '-t']);
      expect(lsFiles).toContain('S out/gone.ts');
      const gitStatus = runGit(['-C', tmpdir, 'status', '--porcelain']);
      expect(gitStatus.trim()).toBe('');
    } finally {
      await repo.dispose();
    }
  });
});
