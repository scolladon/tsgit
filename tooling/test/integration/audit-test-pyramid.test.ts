import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const SCRIPT = path.join(REPO_ROOT, 'tooling', 'audit-test-pyramid.ts');

interface ManifestOverrides {
  readonly gating?: Record<string, boolean>;
}

const buildManifest = (overrides: ManifestOverrides = {}): Record<string, unknown> => ({
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
    gwtTitle: {
      tier: 'unit',
      regex: '^Given .+?, When .+?, Then .+$',
    },
    aaaBody: { tier: 'unit', required: ['Arrange', 'Assert'] },
    sutNaming: {
      tier: 'unit',
      banned: ['subject', 'objectUnderTest', 'systemUnderTest', 'cut'],
    },
    bareClassToThrow: {
      tier: 'unit',
      regex: '\\.toThrow(?:Error)?\\s*\\(\\s*([A-Z]\\w*)\\s*\\)',
    },
    emptyAaaSection: { tier: 'unit' },
  },
  ...(overrides.gating === undefined ? {} : { gating: overrides.gating }),
});

const PASSING_MANIFEST = buildManifest();

interface CliRun {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

const runScript = async (root: string, extraArgs: ReadonlyArray<string> = []): Promise<CliRun> => {
  const outDir = path.join(root, 'out');
  try {
    const { stdout, stderr } = await execFileAsync('node', [
      '--experimental-strip-types',
      SCRIPT,
      '--root',
      root,
      '--out',
      outDir,
      ...extraArgs,
    ]);
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code ?? 1 };
  }
};

const writeManifest = async (root: string, manifest: Record<string, unknown>): Promise<void> => {
  await writeFile(path.join(root, 'test-pyramid-budgets.json'), JSON.stringify(manifest));
};

describe('tooling/audit-test-pyramid (integration)', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'pyramid-audit-'));
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('Given a fixture repo with one unit/integration/e2e file, When the script runs, Then both report files are written and exit code is 0', async () => {
    // Arrange
    await writeManifest(tmpRoot, PASSING_MANIFEST);
    await mkdir(path.join(tmpRoot, 'test', 'unit'), { recursive: true });
    await mkdir(path.join(tmpRoot, 'test', 'integration'), { recursive: true });
    await mkdir(path.join(tmpRoot, 'test', 'browser'), { recursive: true });
    await writeFile(
      path.join(tmpRoot, 'test', 'unit', 'a.test.ts'),
      "it('Given x, When y, Then z', () => {\n  // Arrange\n  const sut = 1;\n  // Assert\n  expect(sut).toBe(1);\n});\n",
    );
    await writeFile(
      path.join(tmpRoot, 'test', 'integration', 'b.test.ts'),
      "it('integration test', () => { expect(1).toBe(1); });\n",
    );
    await writeFile(
      path.join(tmpRoot, 'test', 'browser', 'c.spec.ts'),
      "it('e2e test', () => { expect(1).toBe(1); });\n",
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
    expect(json.findings.badTitle).toEqual([]);
    expect(json.findings.missingAaa).toEqual([]);
    expect(json.findings.bannedSut).toEqual([]);
    expect(json.findings.bareClassThrow).toEqual([]);
    expect(json.findings.emptyAaaSection).toEqual([]);
    const md = await readFile(path.join(tmpRoot, 'out', 'test-pyramid.md'), 'utf8');
    expect(md).toContain('# Testing-pyramid audit');
  });

  it('Given an integration file that calls vi.mock with no gating, When the script runs, Then the over-mocked finding is reported and exit is 0', async () => {
    // Arrange
    await writeManifest(tmpRoot, PASSING_MANIFEST);
    await mkdir(path.join(tmpRoot, 'test', 'integration'), { recursive: true });
    await writeFile(
      path.join(tmpRoot, 'test', 'integration', 'bad.test.ts'),
      "vi.mock('foo');\nit('bad', () => { expect(1).toBe(1); });\n",
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

  it('Given a unit test with zero assertions and no gating, When the script runs, Then the under-asserted finding is reported and exit is 0', async () => {
    // Arrange
    await writeManifest(tmpRoot, PASSING_MANIFEST);
    await mkdir(path.join(tmpRoot, 'test', 'unit'), { recursive: true });
    await writeFile(
      path.join(tmpRoot, 'test', 'unit', 'empty.test.ts'),
      "it('Given x, When y, Then z', () => {\n  // Arrange\n  const sut = 1;\n  // Assert\n});\n",
    );

    // Act
    const sut = await runScript(tmpRoot);

    // Assert
    expect(sut.code).toBe(0);
    const json = JSON.parse(await readFile(path.join(tmpRoot, 'out', 'test-pyramid.json'), 'utf8'));
    expect(json.findings.underAsserted).toHaveLength(1);
  });

  it('Given gwtTitle gated on and a non-GWT title, When the script runs, Then exit is 1 and stderr names gwtTitle', async () => {
    // Arrange
    await writeManifest(tmpRoot, buildManifest({ gating: { gwtTitle: true } }));
    await mkdir(path.join(tmpRoot, 'test', 'unit'), { recursive: true });
    await writeFile(
      path.join(tmpRoot, 'test', 'unit', 'bad.test.ts'),
      "it('not gwt', () => {\n  // Arrange\n  const sut = 1;\n  // Assert\n  expect(sut).toBe(1);\n});\n",
    );

    // Act
    const sut = await runScript(tmpRoot);

    // Assert
    expect(sut.code).toBe(1);
    expect(sut.stderr).toContain('gwtTitle');
    const json = JSON.parse(await readFile(path.join(tmpRoot, 'out', 'test-pyramid.json'), 'utf8'));
    expect(json.findings.badTitle).toHaveLength(1);
  });

  it('Given gating on and a violation, When --report-only is set, Then exit is 0 despite the finding', async () => {
    // Arrange
    await writeManifest(tmpRoot, buildManifest({ gating: { gwtTitle: true } }));
    await mkdir(path.join(tmpRoot, 'test', 'unit'), { recursive: true });
    await writeFile(
      path.join(tmpRoot, 'test', 'unit', 'bad.test.ts'),
      "it('not gwt', () => {\n  // Arrange\n  const sut = 1;\n  // Assert\n  expect(sut).toBe(1);\n});\n",
    );

    // Act
    const sut = await runScript(tmpRoot, ['--report-only']);

    // Assert
    expect(sut.code).toBe(0);
  });

  it('Given aaaBody gated on and a body missing markers, When the script runs, Then exit is 1 and stderr names aaaBody', async () => {
    // Arrange
    await writeManifest(tmpRoot, buildManifest({ gating: { aaaBody: true } }));
    await mkdir(path.join(tmpRoot, 'test', 'unit'), { recursive: true });
    await writeFile(
      path.join(tmpRoot, 'test', 'unit', 'no-aaa.test.ts'),
      "it('Given x, When y, Then z', () => { expect(1).toBe(1); });\n",
    );

    // Act
    const sut = await runScript(tmpRoot);

    // Assert
    expect(sut.code).toBe(1);
    expect(sut.stderr).toContain('aaaBody');
  });

  it('Given sutNaming gated on and a banned synonym, When the script runs, Then exit is 1 and stderr names sutNaming', async () => {
    // Arrange
    await writeManifest(tmpRoot, buildManifest({ gating: { sutNaming: true } }));
    await mkdir(path.join(tmpRoot, 'test', 'unit'), { recursive: true });
    await writeFile(
      path.join(tmpRoot, 'test', 'unit', 'subject.test.ts'),
      "it('Given x, When y, Then z', () => {\n  // Arrange\n  const subject = 1;\n  // Assert\n  expect(subject).toBe(1);\n});\n",
    );

    // Act
    const sut = await runScript(tmpRoot);

    // Assert
    expect(sut.code).toBe(1);
    expect(sut.stderr).toContain('sutNaming');
  });

  it('Given bareClassToThrow gated on and a `.toThrow(Class)` call, When the script runs, Then exit is 1 and stderr names bareClassToThrow', async () => {
    // Arrange
    await writeManifest(tmpRoot, buildManifest({ gating: { bareClassToThrow: true } }));
    await mkdir(path.join(tmpRoot, 'test', 'unit'), { recursive: true });
    await writeFile(
      path.join(tmpRoot, 'test', 'unit', 'throws.test.ts'),
      "it('Given x, When y, Then z', () => {\n  // Arrange\n  const sut = () => { throw new Error('boom'); };\n  // Assert\n  expect(sut).toThrow(TsgitError);\n});\n",
    );

    // Act
    const sut = await runScript(tmpRoot);

    // Assert
    expect(sut.code).toBe(1);
    expect(sut.stderr).toContain('bareClassToThrow');
  });

  it('Given underAssertedUnit gated on and a unit test with zero assertions, When the script runs, Then exit is 1', async () => {
    // Arrange
    await writeManifest(tmpRoot, buildManifest({ gating: { underAssertedUnit: true } }));
    await mkdir(path.join(tmpRoot, 'test', 'unit'), { recursive: true });
    await writeFile(
      path.join(tmpRoot, 'test', 'unit', 'empty.test.ts'),
      "it('Given x, When y, Then z', () => {\n  // Arrange\n  const sut = 1;\n  // Assert\n});\n",
    );

    // Act
    const sut = await runScript(tmpRoot);

    // Assert
    expect(sut.code).toBe(1);
    expect(sut.stderr).toContain('underAssertedUnit');
  });

  it('Given a unit test with an empty Arrange section but no gating, When the script runs, Then the emptyAaaSection finding is reported and exit is 0', async () => {
    // Arrange
    await writeManifest(tmpRoot, PASSING_MANIFEST);
    await mkdir(path.join(tmpRoot, 'test', 'unit'), { recursive: true });
    await writeFile(
      path.join(tmpRoot, 'test', 'unit', 'empty-aaa.test.ts'),
      "it('Given x, When y, Then z', () => {\n  // Arrange\n  // Assert\n  expect(1).toBe(1);\n});\n",
    );

    // Act
    const sut = await runScript(tmpRoot);

    // Assert
    expect(sut.code).toBe(0);
    const json = JSON.parse(await readFile(path.join(tmpRoot, 'out', 'test-pyramid.json'), 'utf8'));
    expect(json.findings.emptyAaaSection).toHaveLength(1);
    expect(json.findings.emptyAaaSection[0]).toMatchObject({
      path: 'test/unit/empty-aaa.test.ts',
      marker: 'Arrange',
    });
  });

  it('Given emptyAaaSection gated on and an empty Arrange section, When the script runs, Then exit is 1 and stderr names emptyAaaSection', async () => {
    // Arrange
    await writeManifest(tmpRoot, buildManifest({ gating: { emptyAaaSection: true } }));
    await mkdir(path.join(tmpRoot, 'test', 'unit'), { recursive: true });
    await writeFile(
      path.join(tmpRoot, 'test', 'unit', 'empty-aaa.test.ts'),
      "it('Given x, When y, Then z', () => {\n  // Arrange\n  // Assert\n  expect(1).toBe(1);\n});\n",
    );

    // Act
    const sut = await runScript(tmpRoot);

    // Assert
    expect(sut.code).toBe(1);
    expect(sut.stderr).toContain('emptyAaaSection');
  });

  it('Given emptyAaaSection gated on and an empty Arrange section, When --report-only is set, Then exit is 0 despite the finding', async () => {
    // Arrange
    await writeManifest(tmpRoot, buildManifest({ gating: { emptyAaaSection: true } }));
    await mkdir(path.join(tmpRoot, 'test', 'unit'), { recursive: true });
    await writeFile(
      path.join(tmpRoot, 'test', 'unit', 'empty-aaa.test.ts'),
      "it('Given x, When y, Then z', () => {\n  // Arrange\n  // Assert\n  expect(1).toBe(1);\n});\n",
    );

    // Act
    const sut = await runScript(tmpRoot, ['--report-only']);

    // Assert
    expect(sut.code).toBe(0);
  });
});
