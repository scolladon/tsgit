import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const BENCH_DIR = path.join(REPO_ROOT, 'test', 'bench');
const REGISTRY_PATH = path.join(REPO_ROOT, 'docs', 'perf', 'hot-paths.json');
const BENCH_FILE_SUFFIX = '.bench.ts';
const TIERED_SCENARIO_MARKER = 'tieredScenario(';

interface HotPathsRegistry {
  readonly hotOperations: readonly string[];
}

const tieredBenchBasenames = (): readonly string[] =>
  readdirSync(BENCH_DIR)
    .filter((fileName) => fileName.endsWith(BENCH_FILE_SUFFIX))
    .filter((fileName) =>
      readFileSync(path.join(BENCH_DIR, fileName), 'utf8').includes(TIERED_SCENARIO_MARKER),
    )
    .map((fileName) => fileName.slice(0, -BENCH_FILE_SUFFIX.length));

describe('Given the hot-paths registry and the tiered bench files', () => {
  describe('When the tiered bench set is compared against the registry', () => {
    it('Then every tiered bench operation is registered and no registered operation is untiered', () => {
      // Arrange
      const registry = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8')) as HotPathsRegistry;
      const sut = tieredBenchBasenames;

      // Act
      const result = sut();

      // Assert
      expect(new Set(result)).toEqual(new Set(registry.hotOperations));
    });
  });
});
