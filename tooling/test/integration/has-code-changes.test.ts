import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { assertInitialised, cleanGitEnv, spawnGitInTmp } from './git-tmp.js';

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const SCRIPT = path.join(REPO_ROOT, '.github', 'scripts', 'has-code-changes.sh');

interface GitCtx {
  readonly dir: string;
  readonly outputFile: string;
  git: (...args: readonly string[]) => Promise<string>;
}

const setupRepo = (): GitCtx => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tsgit-changes-'));
  const outputFile = path.join(dir, 'github-output.txt');
  writeFileSync(outputFile, '');
  const git = (...args: readonly string[]): Promise<string> => spawnGitInTmp(dir, args);
  return { dir, outputFile, git };
};

const runScript = async (
  ctx: GitCtx,
  baseRef: string,
  headRef = 'HEAD',
): Promise<{ stdout: string; output: string }> => {
  const { stdout } = await execFileAsync('bash', [SCRIPT, baseRef, headRef], {
    cwd: ctx.dir,
    env: cleanGitEnv({ GITHUB_OUTPUT: ctx.outputFile }),
  });
  const output = await readFile(ctx.outputFile, 'utf8');
  return { stdout, output };
};

const writeRel = (root: string, relPath: string, content = '// placeholder\n'): void => {
  const full = path.join(root, relPath);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
};

describe('has-code-changes.sh', () => {
  let ctx: GitCtx;

  beforeEach(async () => {
    ctx = setupRepo();
    await ctx.git('init', '-q');
    assertInitialised(ctx.dir);
    await ctx.git('config', 'user.email', 't@test');
    await ctx.git('config', 'user.name', 'test');
    await ctx.git('commit', '--allow-empty', '-m', 'base');
  });

  afterEach(() => {
    rmSync(ctx.dir, { recursive: true, force: true });
  });

  it('Given only a docs/ change, When run, Then code=false', async () => {
    // Arrange
    writeRel(ctx.dir, 'docs/foo.md', '# hi\n');
    await ctx.git('add', '.');
    await ctx.git('commit', '-m', 'docs');

    // Act
    const sut = await runScript(ctx, 'HEAD~1');

    // Assert
    expect(sut.output).toContain('code=false');
    expect(sut.stdout).toMatch(/only non-code paths changed/);
  });

  it('Given a README.md change only, When run, Then code=false', async () => {
    // Arrange
    writeRel(ctx.dir, 'README.md', '# tsgit\n');
    await ctx.git('add', '.');
    await ctx.git('commit', '-m', 'readme');

    // Act
    const sut = await runScript(ctx, 'HEAD~1');

    // Assert
    expect(sut.output).toContain('code=false');
  });

  it('Given a src/ change, When run, Then code=true', async () => {
    // Arrange
    writeRel(ctx.dir, 'src/domain/foo.ts', 'export const x = 1;\n');
    await ctx.git('add', '.');
    await ctx.git('commit', '-m', 'src');

    // Act
    const sut = await runScript(ctx, 'HEAD~1');

    // Assert
    expect(sut.output).toContain('code=true');
    expect(sut.stdout).toMatch(/code paths changed/);
  });

  it('Given a test/ change only, When run, Then code=true', async () => {
    // Arrange
    writeRel(ctx.dir, 'test/unit/foo.test.ts', '// test\n');
    await ctx.git('add', '.');
    await ctx.git('commit', '-m', 'test');

    // Act
    const sut = await runScript(ctx, 'HEAD~1');

    // Assert
    expect(sut.output).toContain('code=true');
  });

  it('Given a tooling/ change only, When run, Then code=true', async () => {
    // Arrange
    writeRel(ctx.dir, 'tooling/foo.ts', '// tooling\n');
    await ctx.git('add', '.');
    await ctx.git('commit', '-m', 'tooling');

    // Act
    const sut = await runScript(ctx, 'HEAD~1');

    // Assert
    expect(sut.output).toContain('code=true');
  });

  it('Given a .github/ change only (workflow edit), When run, Then code=true', async () => {
    // Arrange
    writeRel(ctx.dir, '.github/workflows/foo.yml', 'name: foo\n');
    await ctx.git('add', '.');
    await ctx.git('commit', '-m', 'workflow');

    // Act
    const sut = await runScript(ctx, 'HEAD~1');

    // Assert
    expect(sut.output).toContain('code=true');
  });

  it('Given a package.json bump only, When run, Then code=true', async () => {
    // Arrange
    writeRel(ctx.dir, 'package.json', '{"name":"x","version":"1.0.1"}\n');
    await ctx.git('add', '.');
    await ctx.git('commit', '-m', 'bump');

    // Act
    const sut = await runScript(ctx, 'HEAD~1');

    // Assert
    expect(sut.output).toContain('code=true');
  });

  it('Given a tsconfig.json edit only, When run, Then code=true', async () => {
    // Arrange
    writeRel(ctx.dir, 'tsconfig.json', '{}\n');
    await ctx.git('add', '.');
    await ctx.git('commit', '-m', 'tsconfig');

    // Act
    const sut = await runScript(ctx, 'HEAD~1');

    // Assert
    expect(sut.output).toContain('code=true');
  });

  it('Given mixed src + docs changes, When run, Then code=true (code wins)', async () => {
    // Arrange
    writeRel(ctx.dir, 'src/foo.ts', '// src\n');
    writeRel(ctx.dir, 'docs/foo.md', '# docs\n');
    await ctx.git('add', '.');
    await ctx.git('commit', '-m', 'mixed');

    // Act
    const sut = await runScript(ctx, 'HEAD~1');

    // Assert
    expect(sut.output).toContain('code=true');
  });

  it('Given an empty diff (no changes), When run, Then code=false', async () => {
    // Arrange — diff a commit against itself
    // Act
    const sut = await runScript(ctx, 'HEAD', 'HEAD');

    // Assert
    expect(sut.output).toContain('code=false');
    expect(sut.stdout).toMatch(/empty diff/);
  });

  it('Given no BASE_SHA argument (push-event simulation), When run, Then code=true (full pipeline)', async () => {
    // Arrange + Act — invoke with no args at all
    const { stdout } = await execFileAsync('bash', [SCRIPT], {
      cwd: ctx.dir,
      env: cleanGitEnv({ GITHUB_OUTPUT: ctx.outputFile }),
    });
    const output = await readFile(ctx.outputFile, 'utf8');

    // Assert
    expect(stdout).toMatch(/no base SHA \(push event\) - assuming code=true/);
    expect(output).toContain('code=true');
  });

  it('Given a BASE_SHA with shell metacharacters, When run, Then exits 2 (SHA guard)', async () => {
    // Arrange
    let failed = false;
    let exitCode = 0;

    // Act
    try {
      await execFileAsync('bash', [SCRIPT, 'main;rm -rf /', 'HEAD'], {
        cwd: ctx.dir,
        env: cleanGitEnv({ GITHUB_OUTPUT: ctx.outputFile }),
      });
    } catch (err) {
      failed = true;
      const e = err as { code?: number };
      exitCode = typeof e.code === 'number' ? e.code : 0;
    }

    // Assert
    expect(failed).toBe(true);
    expect(exitCode).toBe(2);
  });
});
