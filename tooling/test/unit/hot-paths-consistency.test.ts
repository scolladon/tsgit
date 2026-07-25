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

// Substring detection is a heuristic; strip whole-line comments first so a
// disabled `// await tieredScenario(...)` cannot masquerade as a tiered bench.
const callsTieredScenario = (source: string): boolean =>
  source
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n')
    .includes(TIERED_SCENARIO_MARKER);

const tieredBenchBasenames = (): readonly string[] =>
  readdirSync(BENCH_DIR)
    .filter((fileName) => fileName.endsWith(BENCH_FILE_SUFFIX))
    .filter((fileName) => callsTieredScenario(readFileSync(path.join(BENCH_DIR, fileName), 'utf8')))
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
