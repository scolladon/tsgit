import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'audit-test-pyramid.ts');

const PASSING_MANIFEST = {
  tiers: [
    {
      name: 'unit',
      glob: 'test/unit/**/*.test.ts',
      target: 80,
      warnBelow: 75,
      warnAbove: null,
    },
    {
      name: 'integration',
      glob: 'test/integration/**/*.test.ts',
      target: 15,
      warnBelow: 10,
      warnAbove: 25,
    },
    {
      name: 'e2e',
      glob: 'test/browser/**/*.spec.ts',
      target: 5,
      warnBelow: 3,
      warnAbove: null,
    },
  ],
  heuristics: {
    overMockedIntegration: {
      tier: 'integration',
      regex: '\\bvi\\.(mock|fn|spyOn|stubGlobal|stubEnv)\\s*\\(',
      threshold: 0,
    },
    underAssertedUnit: { tier: 'unit', minAssertionsPerTest: 1 },
  },
};

interface CliRun {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

const runScript = async (root: string): Promise<CliRun> => {
  const outDir = path.join(root, 'out');
  try {
    const { stdout, stderr } = await execFileAsync('node', [
      '--experimental-strip-types',
      SCRIPT,
      '--root',
      root,
      '--out',
      outDir,
    ]);
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code ?? 1 };
  }
};

describe('scripts/audit-test-pyramid (integration)', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'pyramid-audit-'));
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('Given a fixture repo with one unit, one integration, one e2e file, When the script runs, Then both report files are written and exit code is 0', async () => {
    // Arrange
    await writeFile(
      path.join(tmpRoot, 'test-pyramid-budgets.json'),
      JSON.stringify(PASSING_MANIFEST),
    );
    await mkdir(path.join(tmpRoot, 'test', 'unit'), { recursive: true });
    await mkdir(path.join(tmpRoot, 'test', 'integration'), { recursive: true });
    await mkdir(path.join(tmpRoot, 'test', 'browser'), { recursive: true });
    await writeFile(
      path.join(tmpRoot, 'test', 'unit', 'a.test.ts'),
      `it('first', () => { expect(1).toBe(1); });\n`,
    );
    await writeFile(
      path.join(tmpRoot, 'test', 'integration', 'b.test.ts'),
      `it('second', () => { expect(1).toBe(1); });\n`,
    );
    await writeFile(
      path.join(tmpRoot, 'test', 'browser', 'c.spec.ts'),
      `it('third', () => { expect(1).toBe(1); });\n`,
    );

    // Act
    const sut = await runScript(tmpRoot);

    // Assert
    expect(sut.code).toBe(0);
    expect(sut.stderr).toBe('');
    const jsonRaw = await readFile(path.join(tmpRoot, 'out', 'test-pyramid.json'), 'utf8');
    const json = JSON.parse(jsonRaw);
    expect(json.tally.totalClassified).toBe(3);
    expect(json.findings.overMocked).toEqual([]);
    expect(json.findings.underAsserted).toEqual([]);
    const md = await readFile(path.join(tmpRoot, 'out', 'test-pyramid.md'), 'utf8');
    expect(md).toContain('# Testing-pyramid audit');
    expect(md).toContain('| unit |');
    expect(md).toContain('| integration |');
    expect(md).toContain('| e2e |');
  });

  it('Given an integration file that calls vi.mock, When the script runs, Then the over-mocked finding is reported', async () => {
    // Arrange
    await writeFile(
      path.join(tmpRoot, 'test-pyramid-budgets.json'),
      JSON.stringify(PASSING_MANIFEST),
    );
    await mkdir(path.join(tmpRoot, 'test', 'integration'), { recursive: true });
    await writeFile(
      path.join(tmpRoot, 'test', 'integration', 'bad.test.ts'),
      `vi.mock('foo');\nit('bad', () => { expect(1).toBe(1); });\n`,
    );

    // Act
    const sut = await runScript(tmpRoot);

    // Assert
    expect(sut.code).toBe(0);
    const json = JSON.parse(await readFile(path.join(tmpRoot, 'out', 'test-pyramid.json'), 'utf8'));
    expect(json.findings.overMocked).toEqual([{ path: 'test/integration/bad.test.ts', hits: 1 }]);
  });

  it('Given a malformed manifest, When the script runs, Then exit code is 1 and stderr contains "manifest invalid"', async () => {
    // Arrange
    await writeFile(path.join(tmpRoot, 'test-pyramid-budgets.json'), '{not json');

    // Act
    const sut = await runScript(tmpRoot);

    // Assert
    expect(sut.code).toBe(1);
    expect(sut.stderr).toContain('manifest invalid');
  });

  it('Given a unit test with zero assertions, When the script runs, Then the under-asserted finding is reported', async () => {
    // Arrange
    await writeFile(
      path.join(tmpRoot, 'test-pyramid-budgets.json'),
      JSON.stringify(PASSING_MANIFEST),
    );
    await mkdir(path.join(tmpRoot, 'test', 'unit'), { recursive: true });
    await writeFile(
      path.join(tmpRoot, 'test', 'unit', 'empty.test.ts'),
      `it('says nothing', () => { const x = 1; });\n`,
    );

    // Act
    const sut = await runScript(tmpRoot);

    // Assert
    expect(sut.code).toBe(0);
    const json = JSON.parse(await readFile(path.join(tmpRoot, 'out', 'test-pyramid.json'), 'utf8'));
    expect(json.findings.underAsserted).toHaveLength(1);
    expect(json.findings.underAsserted[0]).toMatchObject({
      path: 'test/unit/empty.test.ts',
      title: 'says nothing',
    });
  });
});
