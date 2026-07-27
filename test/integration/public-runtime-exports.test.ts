/**
 * `export type *` in `public-types.ts` silently drops runtime VALUES from a
 * barrel that mixes types and values, so a symbol the built `.d.ts` declares
 * as a value (`MAX_SCORE`, `toSimilarityPercent`, …) can vanish from the
 * shipped runtime bundle while a TypeScript consumer still compiles green
 * against the stale declaration — the crash only surfaces at the consumer's
 * own runtime.
 *
 * Two sweeps live here:
 *  - `domain/diff`'s own value surface — the original barrel the fix
 *    touched. Its runtime export keys already ARE its value surface
 *    (`export type` re-exports never produce a runtime binding), so no
 *    `.d.ts` parsing is needed to enumerate them.
 *  - Every published package entry (each unique `(types, runtime)` pair
 *    `package.json`'s `exports` map exposes). rollup-plugin-dts shares
 *    declaration chunks across the package's several entry points, so a
 *    symbol that is a genuine value at one entry's declaration can carry
 *    that value shape into another entry's re-export of the same chunk,
 *    even one whose runtime bundle never binds it — `readBlob` leaking
 *    onto the main entry from `application/primitives`' chunk is the
 *    running example. `tooling/truthful-dts.ts` fixes this at build time
 *    by downgrading such leaks to `export type`; this sweep parses each
 *    entry's built `.d.ts`/`.d.cts` for its declared VALUE exports
 *    (`tooling/dts-value-exports.ts`) and asserts every one resolves at
 *    runtime in that SAME entry's own built module.
 *
 * Runs against the BUILT dist output, not `src/`: the declared-vs-runtime
 * pairing this guard locks is a property of the shipped bundle, not
 * reproducible by importing TypeScript source directly (mirrors
 * `dispose-free-exit.test.ts`).
 *
 * @proves
 *   surface:  public-types
 *   bucket:   coverage-gap
 *   unique:   every published entry's declared value export is defined in that entry's own built runtime module, not just typed
 */
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { beforeAll, describe, expect, it } from 'vitest';
import * as diffDomainBarrel from '../../src/domain/diff/index.js';
import { getPublishedEntries, type PublishedEntry } from '../../tooling/dts-entries.ts';
import {
  analyzeDeclaredExports,
  type EntryDeclarations,
  findUndeclaredRuntimeExports,
  findUndefinedValueExports,
} from '../../tooling/dts-value-exports.ts';

const execFileAsync = promisify(execFile);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DIST_ESM = path.join(ROOT, 'dist', 'esm', 'index.node.js');
const BUILD_TIMEOUT_MS = 120_000;

// `diffTrees` is excluded: public-types.ts deliberately keeps it type-only on
// the main entry (the name clashes with application/primitives' diffTrees —
// the one `repo.primitives.diffTrees` actually binds — so re-exporting the
// domain value here would reintroduce that ambiguity).
const DIFF_BARREL_VALUE_NAMES = Object.keys(diffDomainBarrel).filter(
  (name) => name !== 'diffTrees',
);

type RequireFn = ReturnType<typeof createRequire>;

const loadRuntimeExportNames = async (
  entry: PublishedEntry,
  requireCjs: RequireFn,
): Promise<ReadonlySet<string>> => {
  const runtimeModule =
    entry.format === 'cjs'
      ? requireCjs(entry.runtimePath)
      : await import(pathToFileURL(entry.runtimePath).href);
  return new Set(Object.keys(runtimeModule as Record<string, unknown>));
};

const collectUndeclaredRuntimeValues = async (
  entries: readonly PublishedEntry[],
  declaredByPath: ReadonlyMap<string, EntryDeclarations>,
  requireCjs: RequireFn,
): Promise<readonly string[]> => {
  const violations: string[] = [];
  for (const entry of entries) {
    const declarations = declaredByPath.get(entry.dtsPath);
    const runtimeNames = await loadRuntimeExportNames(entry, requireCjs);
    const undeclared = findUndeclaredRuntimeExports(declarations?.exports ?? [], runtimeNames);
    violations.push(...undeclared.map((name) => `${entry.label}: ${name}`));
  }
  return violations;
};

const collectUndefinedDeclaredValues = async (
  entries: readonly PublishedEntry[],
  declaredByPath: ReadonlyMap<string, EntryDeclarations>,
  requireCjs: RequireFn,
): Promise<readonly string[]> => {
  const violations: string[] = [];
  for (const entry of entries) {
    const declarations = declaredByPath.get(entry.dtsPath);
    const runtimeNames = await loadRuntimeExportNames(entry, requireCjs);
    const undefinedNames = findUndefinedValueExports(declarations?.exports ?? [], runtimeNames);
    violations.push(...undefinedNames.map((name) => `${entry.label}: ${name}`));
  }
  return violations;
};

describe('Given the built public Node runtime entry', () => {
  beforeAll(async () => {
    // Build the shipped artefacts once — the declared/runtime pairing this
    // guard locks is a property of the rollup-bundled output, not of `src/`.
    await execFileAsync('npm', ['run', 'build'], { cwd: ROOT, timeout: BUILD_TIMEOUT_MS });
  }, BUILD_TIMEOUT_MS);

  describe('When importing the two similarity-scoring symbols the built .d.ts declares as values', () => {
    it('Then MAX_SCORE and toSimilarityPercent are defined at runtime', async () => {
      // Arrange
      const sut = (await import(DIST_ESM)) as Record<string, unknown>;

      // Act
      const result = { maxScore: sut.MAX_SCORE, toSimilarityPercent: sut.toSimilarityPercent };

      // Assert
      expect(result.maxScore).not.toBeUndefined();
      expect(result.toSimilarityPercent).not.toBeUndefined();
    });
  }, 600_000);

  describe('When auditing every domain/diff value export against the runtime bundle', () => {
    it('Then none of them are undefined at runtime', async () => {
      // Arrange
      const sut = (await import(DIST_ESM)) as Record<string, unknown>;

      // Act
      const result = DIFF_BARREL_VALUE_NAMES.filter((name) => sut[name] === undefined);

      // Assert
      expect(result).toStrictEqual([]);
    });
  });
});

describe('Given every published package entry', () => {
  beforeAll(async () => {
    // Build the shipped artefacts once — the declared/runtime pairing this
    // guard locks is a property of the rollup-bundled output, not of `src/`.
    await execFileAsync('npm', ['run', 'build'], { cwd: ROOT, timeout: BUILD_TIMEOUT_MS });
  }, BUILD_TIMEOUT_MS);

  describe("When auditing each entry's declared value exports against its own runtime bundle", () => {
    it('Then none of them are undefined in the matching runtime module', async () => {
      // Arrange
      const sut = getPublishedEntries(ROOT);
      const requireCjs = createRequire(import.meta.url);
      const declaredByPath = analyzeDeclaredExports(sut.map((entry) => entry.dtsPath));

      // Act
      const result = await collectUndefinedDeclaredValues(sut, declaredByPath, requireCjs);

      // Assert
      expect(result).toStrictEqual([]);
    });
  }, 600_000);

  describe("When auditing each entry's runtime value exports against its declaration file", () => {
    it('Then every runtime export is declared as a value (never downgraded or missing)', async () => {
      // Arrange
      const sut = getPublishedEntries(ROOT);
      const requireCjs = createRequire(import.meta.url);
      const declaredByPath = analyzeDeclaredExports(sut.map((entry) => entry.dtsPath));

      // Act
      const result = await collectUndeclaredRuntimeValues(sut, declaredByPath, requireCjs);

      // Assert — the reverse direction: an over-downgraded genuine runtime
      // export would vanish from the declared-value set and surface here
      expect(result).toStrictEqual([]);
    });
  }, 600_000);
});
