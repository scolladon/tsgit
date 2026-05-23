import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const SCRIPT = path.join(REPO_ROOT, '.github', 'scripts', 'compute-mutation-scope.sh');

interface GitCtx {
  readonly dir: string;
  git: (...args: readonly string[]) => Promise<string>;
}

const setupRepo = (): GitCtx => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tsgit-mutscope-'));
  const git = async (...args: readonly string[]): Promise<string> => {
    const { stdout } = await execFileAsync('git', args as string[], { cwd: dir });
    return stdout;
  };
  return { dir, git };
};

const runScope = async (ctx: GitCtx, baseRef: string, headRef = 'HEAD'): Promise<string[]> => {
  const { stdout } = await execFileAsync('bash', [SCRIPT, baseRef, headRef], {
    cwd: ctx.dir,
  });
  return stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
};

const writeRel = (root: string, relPath: string, content = '// placeholder\n'): void => {
  const full = path.join(root, relPath);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
};

describe('compute-mutation-scope.sh', () => {
  let ctx: GitCtx;

  beforeEach(async () => {
    ctx = setupRepo();
    await ctx.git('init', '-q');
    await ctx.git('config', 'user.email', 't@test');
    await ctx.git('config', 'user.name', 'test');
    await ctx.git('commit', '--allow-empty', '-m', 'base');
  });

  afterEach(() => {
    rmSync(ctx.dir, { recursive: true, force: true });
  });

  it('Given no src/ changes, When run, Then output is empty', async () => {
    // Arrange — change a non-src file only
    writeRel(ctx.dir, 'README.md', '# hi\n');
    await ctx.git('add', '.');
    await ctx.git('commit', '-m', 'docs');

    // Act
    const sut = await runScope(ctx, 'HEAD~1');

    // Assert
    expect(sut).toEqual([]);
  });

  it('Given a single new src/domain file, When run, Then that file is listed', async () => {
    // Arrange
    writeRel(ctx.dir, 'src/domain/foo.ts', 'export const x = 1;\n');
    await ctx.git('add', '.');
    await ctx.git('commit', '-m', 'add foo');

    // Act
    const sut = await runScope(ctx, 'HEAD~1');

    // Assert
    expect(sut).toEqual(['src/domain/foo.ts']);
  });

  it('Given mixed src + test changes, When run, Then only src is listed', async () => {
    // Arrange
    writeRel(ctx.dir, 'src/application/a.ts', 'export const a = 1;\n');
    writeRel(ctx.dir, 'test/unit/a.test.ts', '// test\n');
    await ctx.git('add', '.');
    await ctx.git('commit', '-m', 'mixed');

    // Act
    const sut = await runScope(ctx, 'HEAD~1');

    // Assert
    expect(sut).toEqual(['src/application/a.ts']);
  });

  it('Given a renamed src file, When run, Then only the new path is listed (--diff-filter=R)', async () => {
    // Arrange — create a file under one name, commit, rename via git mv, commit
    writeRel(ctx.dir, 'src/domain/old-name.ts', 'export const value = 1;\n');
    await ctx.git('add', '.');
    await ctx.git('commit', '-m', 'add');
    await ctx.git('mv', 'src/domain/old-name.ts', 'src/domain/new-name.ts');
    await ctx.git('commit', '-m', 'rename');

    // Act
    const sut = await runScope(ctx, 'HEAD~1');

    // Assert — the new path appears; the old path does not.
    expect(sut).toContain('src/domain/new-name.ts');
    expect(sut).not.toContain('src/domain/old-name.ts');
  });

  it('Given a deleted src file, When run, Then it is excluded (--diff-filter=AMR skips D)', async () => {
    // Arrange — set up a file, commit, delete it, commit
    writeRel(ctx.dir, 'src/domain/will-go.ts', 'export const k = 1;\n');
    await ctx.git('add', '.');
    await ctx.git('commit', '-m', 'add');
    unlinkSync(path.join(ctx.dir, 'src', 'domain', 'will-go.ts'));
    await ctx.git('add', '.');
    await ctx.git('commit', '-m', 'remove');

    // Act
    const sut = await runScope(ctx, 'HEAD~1');

    // Assert
    expect(sut).toEqual([]);
  });

  it('Given a browser-adapter file change, When run, Then it is excluded', async () => {
    // Arrange
    writeRel(ctx.dir, 'src/adapters/browser/foo.ts', 'export const b = 1;\n');
    await ctx.git('add', '.');
    await ctx.git('commit', '-m', 'browser');

    // Act
    const sut = await runScope(ctx, 'HEAD~1');

    // Assert
    expect(sut).toEqual([]);
  });

  it('Given a barrel index.ts (src/domain/index.ts) change, When run, Then it is excluded — matches Stryker mutate-exclude', async () => {
    // Arrange — Stryker excludes files literally named `index.ts`, but NOT `index.node.ts`,
    // `index.browser.ts`, `index.default.ts` (those are entry points with logic).
    writeRel(ctx.dir, 'src/domain/index.ts', '// barrel re-exports\n');
    await ctx.git('add', '.');
    await ctx.git('commit', '-m', 'barrel');

    // Act
    const sut = await runScope(ctx, 'HEAD~1');

    // Assert
    expect(sut).toEqual([]);
  });

  it('Given a runtime entry point (src/index.node.ts), When run, Then it is included — matches Stryker include', async () => {
    // Arrange — `src/index.node.ts` has openRepository wiring logic, mutated by Stryker.
    writeRel(ctx.dir, 'src/index.node.ts', 'export const f = () => 1;\n');
    await ctx.git('add', '.');
    await ctx.git('commit', '-m', 'entry');

    // Act
    const sut = await runScope(ctx, 'HEAD~1');

    // Assert
    expect(sut).toEqual(['src/index.node.ts']);
  });

  it('Given a *.d.ts change, When run, Then it is excluded', async () => {
    // Arrange
    writeRel(ctx.dir, 'src/global.d.ts', '// types\n');
    await ctx.git('add', '.');
    await ctx.git('commit', '-m', 'types');

    // Act
    const sut = await runScope(ctx, 'HEAD~1');

    // Assert
    expect(sut).toEqual([]);
  });

  it('Given multiple src files across buckets, When run, Then all are listed', async () => {
    // Arrange
    writeRel(ctx.dir, 'src/domain/a.ts', 'export const a = 1;\n');
    writeRel(ctx.dir, 'src/application/b.ts', 'export const b = 1;\n');
    writeRel(ctx.dir, 'src/adapters/node/c.ts', 'export const c = 1;\n');
    writeRel(ctx.dir, 'src/operators/d.ts', 'export const d = 1;\n');
    await ctx.git('add', '.');
    await ctx.git('commit', '-m', 'multi');

    // Act
    const sut = await runScope(ctx, 'HEAD~1');

    // Assert
    expect(sut.sort()).toEqual([
      'src/adapters/node/c.ts',
      'src/application/b.ts',
      'src/domain/a.ts',
      'src/operators/d.ts',
    ]);
  });
});
