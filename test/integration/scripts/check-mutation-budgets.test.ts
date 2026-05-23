import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'check-mutation-budgets.ts');

const PASSING_MANIFEST = {
  buckets: [
    {
      name: 'domain',
      globs: ['src/domain/**'],
      thresholds: { high: 100, low: 100, break: 99 },
    },
    {
      name: 'application',
      globs: ['src/application/**'],
      thresholds: { high: 100, low: 98, break: 95 },
    },
    {
      name: 'adapters',
      globs: ['src/adapters/**'],
      thresholds: { high: 95, low: 90, break: 85 },
    },
    {
      name: 'infra',
      globs: ['src/operators/**'],
      thresholds: { high: 100, low: 95, break: 90 },
    },
  ],
};

const fileResult = (statuses: readonly string[]) => ({
  language: 'typescript',
  source: '// elided',
  mutants: statuses.map((status, id) => ({ id: String(id), status })),
});

const baseReport = (files: Record<string, ReturnType<typeof fileResult>>) => ({
  schemaVersion: '1.0',
  thresholds: { high: 100, low: 95, break: 90 },
  files,
});

interface CliRun {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const isExecFileException = (
  err: unknown,
): err is { code?: number | null; stdout?: string; stderr?: string } =>
  typeof err === 'object' && err !== null;

const runCli = async (cwd: string, extraArgs: readonly string[] = []): Promise<CliRun> => {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ['--experimental-strip-types', SCRIPT, ...extraArgs],
      { cwd },
    );
    return { exitCode: 0, stdout, stderr };
  } catch (err) {
    if (!isExecFileException(err)) {
      throw err;
    }
    const code = typeof err.code === 'number' ? err.code : 1;
    return {
      exitCode: code,
      stdout: typeof err.stdout === 'string' ? err.stdout : '',
      stderr: typeof err.stderr === 'string' ? err.stderr : '',
    };
  }
};

describe('check-mutation-budgets CLI', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-mutbudget-'));
    await mkdir(path.join(tmpDir, 'reports', 'mutation'), { recursive: true });
  });

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('Given a passing report + manifest, When CLI runs, Then exit 0 and stdout shows PASS', async () => {
    // Arrange
    await writeFile(path.join(tmpDir, 'mutation-budgets.json'), JSON.stringify(PASSING_MANIFEST));
    await writeFile(
      path.join(tmpDir, 'reports', 'mutation', 'mutation-report.json'),
      JSON.stringify(
        baseReport({
          'src/domain/foo.ts': fileResult(['Killed', 'Killed', 'Killed']),
        }),
      ),
    );

    // Act
    const sut = await runCli(tmpDir);

    // Assert
    expect(sut.exitCode).toBe(0);
    expect(sut.stdout).toMatch(/PASS/);
    expect(sut.stdout).toMatch(/Mutation budget gate passed/);
  });

  it('Given an adapters file at 80 percent (below break 85), When CLI runs, Then exit 1 and stderr shows FAILED', async () => {
    // Arrange
    await writeFile(path.join(tmpDir, 'mutation-budgets.json'), JSON.stringify(PASSING_MANIFEST));
    await writeFile(
      path.join(tmpDir, 'reports', 'mutation', 'mutation-report.json'),
      JSON.stringify(
        baseReport({
          'src/adapters/node/x.ts': fileResult([
            'Killed',
            'Killed',
            'Killed',
            'Killed',
            'Survived',
          ]),
        }),
      ),
    );

    // Act
    const sut = await runCli(tmpDir);

    // Assert
    expect(sut.exitCode).toBe(1);
    expect(sut.stdout).toMatch(/FAIL/);
    expect(sut.stderr).toMatch(/Mutation budget gate FAILED/);
  });

  it('Given a missing report file, When CLI runs, Then exit 1 with not-found error', async () => {
    // Arrange
    await writeFile(path.join(tmpDir, 'mutation-budgets.json'), JSON.stringify(PASSING_MANIFEST));
    await rm(path.join(tmpDir, 'reports', 'mutation', 'mutation-report.json'), {
      force: true,
    });

    // Act
    const sut = await runCli(tmpDir);

    // Assert
    expect(sut.exitCode).toBe(1);
    expect(sut.stderr).toMatch(/report not found/);
  });

  it('Given a malformed manifest, When CLI runs, Then exit 1 with manifest-invalid error', async () => {
    // Arrange
    await writeFile(path.join(tmpDir, 'mutation-budgets.json'), JSON.stringify({ buckets: [] }));
    await writeFile(
      path.join(tmpDir, 'reports', 'mutation', 'mutation-report.json'),
      JSON.stringify(baseReport({})),
    );

    // Act
    const sut = await runCli(tmpDir);

    // Assert
    expect(sut.exitCode).toBe(1);
    expect(sut.stderr).toMatch(/manifest invalid: buckets array must not be empty/);
  });

  it('Given a file matching no bucket, When CLI runs, Then exit 1 and stdout flags unassigned', async () => {
    // Arrange
    await writeFile(path.join(tmpDir, 'mutation-budgets.json'), JSON.stringify(PASSING_MANIFEST));
    await writeFile(
      path.join(tmpDir, 'reports', 'mutation', 'mutation-report.json'),
      JSON.stringify(
        baseReport({
          'src/orphan/foo.ts': fileResult(['Killed']),
        }),
      ),
    );

    // Act
    const sut = await runCli(tmpDir);

    // Assert
    expect(sut.exitCode).toBe(1);
    expect(sut.stdout).toMatch(/Unassigned files/);
    expect(sut.stdout).toMatch(/src\/orphan\/foo\.ts/);
  });

  it('Given --report flag pointing at an alt path, When CLI runs, Then it uses the alt path', async () => {
    // Arrange
    const altPath = path.join(tmpDir, 'alt-report.json');
    await writeFile(path.join(tmpDir, 'mutation-budgets.json'), JSON.stringify(PASSING_MANIFEST));
    await writeFile(
      altPath,
      JSON.stringify(
        baseReport({
          'src/domain/y.ts': fileResult(['Killed']),
        }),
      ),
    );

    // Act
    const sut = await runCli(tmpDir, ['--report', altPath]);

    // Assert
    expect(sut.exitCode).toBe(0);
  });

  it('Given an unknown CLI flag, When CLI runs, Then exit 1 with unknown-argument error', async () => {
    // Arrange — manifest + report present (so error is purely from arg parsing)
    await writeFile(path.join(tmpDir, 'mutation-budgets.json'), JSON.stringify(PASSING_MANIFEST));
    await writeFile(
      path.join(tmpDir, 'reports', 'mutation', 'mutation-report.json'),
      JSON.stringify(baseReport({})),
    );

    // Act
    const sut = await runCli(tmpDir, ['--bogus']);

    // Assert
    expect(sut.exitCode).toBe(1);
    expect(sut.stderr).toMatch(/unknown argument: --bogus/);
  });
});
