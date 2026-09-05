import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';

import { minimatch } from 'minimatch';
import { describe, expect, it } from 'vitest';

import benchSweepConfig from '../../../vitest.bench.config.ts';

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const VITEST_BIN = path.join(REPO_ROOT, 'node_modules', '.bin', 'vitest');
const FIXTURE = path.join(
  REPO_ROOT,
  'tooling',
  'test',
  'fixtures',
  'bench',
  'throwing-warmup.bench.ts',
);
const FIXTURE_RELATIVE_TO_ROOT = path.relative(REPO_ROOT, FIXTURE).split(path.sep).join('/');
// Not imported from the fixture: loading that module outside benchmark mode
// calls vitest's `bench()` before it is registered, which throws. Keep this
// literal in sync with the `throw` in throwing-warmup.bench.ts.
const WARMUP_ERROR_MESSAGE = 'warmup boom: this scenario must fail the run';

// The spawned vitest process should fail promptly; this is a safety net
// against a regression that makes it hang instead.
const SPAWN_KILL_TIMEOUT_MS = 60_000;
const TEST_TIMEOUT_MS = 90_000;

interface CliRun {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

const runVitestBenchAgainstFixture = async (configPath: string): Promise<CliRun> => {
  try {
    const { stdout, stderr } = await execFileAsync(
      VITEST_BIN,
      ['bench', '--run', '--config', configPath],
      { cwd: REPO_ROOT, timeout: SPAWN_KILL_TIMEOUT_MS },
    );
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code ?? 1 };
  }
};

/** Scopes a throwaway vitest run to exactly the fixture — the real sweep
 * (`vitest.bench.config.ts`) must never pick it up; see the sibling test
 * below that pins that. */
const writeFixtureOnlyConfig = async (configPath: string): Promise<void> => {
  await writeFile(
    configPath,
    [
      "import { defineConfig } from 'vitest/config';",
      '',
      'export default defineConfig({',
      '  test: {',
      `    root: ${JSON.stringify(REPO_ROOT)},`,
      '    benchmark: {',
      `      include: [${JSON.stringify(FIXTURE)}],`,
      '    },',
      '  },',
      '});',
      '',
    ].join('\n'),
    'utf8',
  );
};

describe('the real bench sweep config', () => {
  describe('Given its include glob and the throwing-warmup fixture path', () => {
    describe('When the glob is matched against the fixture', () => {
      it('Then the fixture falls outside the sweep and is never picked up by it', () => {
        // Arrange
        const sut = minimatch;
        const includeGlobs = benchSweepConfig.test?.benchmark?.include ?? [];

        // Act
        const matchesSweep = includeGlobs.some((glob) => sut(FIXTURE_RELATIVE_TO_ROOT, glob));

        // Assert
        expect(includeGlobs).not.toEqual([]);
        expect(matchesSweep).toBe(false);
      });
    });
  });
});

describe('vitest bench run-phase-throw guard (integration)', () => {
  describe('Given a bench scenario whose sut throws on its first (warmup) call', () => {
    describe('When vitest bench runs it in isolation under throws: true', () => {
      it(
        'Then the run fails, naming the warmup error, instead of hanging or passing silently',
        async () => {
          // Arrange
          const configDir = await mkdtemp(path.join(REPO_ROOT, '.bench-warmup-throw-'));
          const configPath = path.join(configDir, 'vitest.config.ts');
          await writeFixtureOnlyConfig(configPath);

          try {
            // Act
            const result = await runVitestBenchAgainstFixture(configPath);

            // Assert
            expect(result.code).not.toBe(0);
            expect(`${result.stdout}${result.stderr}`).toContain(WARMUP_ERROR_MESSAGE);
          } finally {
            await rm(configDir, { recursive: true, force: true });
          }
        },
        TEST_TIMEOUT_MS,
      );
    });
  });
});
