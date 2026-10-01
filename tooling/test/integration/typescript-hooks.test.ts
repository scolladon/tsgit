/**
 * @proves
 *   surface: typescriptHooks.registration
 *   bucket:  coverage-gap
 *   unique:  only a spawned node process can show the registered hooks load a `.ts` graph with Node's stripper disabled, and that the disabled stripper turns an unhooked `.ts` into a hard failure
 */
import { execFile } from 'node:child_process';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import benchSweepConfig from '../../../vitest.bench.config.ts';

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const REGISTER_HOOKS = path.join(REPO_ROOT, 'tooling', 'register-typescript-hooks.mjs');
const ENTRY = path.join(REPO_ROOT, 'tooling', 'test', 'fixtures', 'typescript-hooks', 'entry.ts');
const STRIPPER_OFF = '--no-experimental-strip-types';
const EXPECTED_OUTPUT = 'loaded through the transpile hooks';
const SPAWN_KILL_TIMEOUT_MS = 30_000;

interface NodeRun {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

const runNode = async (args: readonly string[]): Promise<NodeRun> => {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [...args], {
      cwd: REPO_ROOT,
      timeout: SPAWN_KILL_TIMEOUT_MS,
    });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code ?? 1 };
  }
};

describe('typescript transpile hooks (integration)', () => {
  describe('Given the hooks are registered and Node’s stripper is disabled', () => {
    describe('When node runs a TypeScript entry importing a sibling through a .js specifier', () => {
      it('Then the whole graph loads and runs', async () => {
        // Arrange
        const sut = runNode;

        // Act
        const result = await sut([
          STRIPPER_OFF,
          '--import',
          pathToFileURL(REGISTER_HOOKS).href,
          ENTRY,
        ]);

        // Assert
        expect(result).toEqual({ stdout: EXPECTED_OUTPUT, stderr: '', code: 0 });
      });
    });
  });

  describe('Given Node’s stripper is disabled and no hooks are registered', () => {
    describe('When node runs the same TypeScript entry', () => {
      it('Then it refuses the .ts file instead of stripping it', async () => {
        // Arrange
        const sut = runNode;

        // Act
        const result = await sut([STRIPPER_OFF, ENTRY]);

        // Assert
        expect(result.code).not.toBe(0);
        expect(result.stderr).toContain('ERR_UNKNOWN_FILE_EXTENSION');
      });
    });
  });
});

describe('the real bench sweep config', () => {
  describe('Given its test options, When the loading setup is read', () => {
    it('Then benches load natively through the hooks with the stripper disabled', () => {
      // Arrange
      const sut = benchSweepConfig.test;

      // Act
      const loading = {
        experimental: sut?.experimental,
        execArgv: sut?.execArgv,
        setupFiles: sut?.setupFiles,
      };

      // Assert
      expect(loading).toEqual({
        experimental: { viteModuleRunner: false, nodeLoader: false },
        execArgv: [STRIPPER_OFF],
        setupFiles: ['tooling/register-typescript-hooks.mjs'],
      });
    });
  });
});
