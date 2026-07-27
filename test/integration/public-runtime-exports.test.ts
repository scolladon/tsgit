/**
 * `export type *` in `public-types.ts` silently drops runtime VALUES from a
 * barrel that mixes types and values, so a symbol the built `.d.ts` declares
 * as a value (`MAX_SCORE`, `toSimilarityPercent`, …) can vanish from the
 * shipped runtime bundle while a TypeScript consumer still compiles green
 * against the stale declaration — the crash only surfaces at the consumer's
 * own runtime.
 *
 * Scope: `domain/diff`'s own value surface — the barrel the accompanying fix
 * touches. The built `dist/types/index.node.d.ts` also *syntactically*
 * declares values for other type-only-barrel-forwarded symbols (e.g.
 * `application/primitives`' `readBlob`) because rollup-plugin-dts shares
 * chunks across the package's several published entry points (`tsgit`,
 * `tsgit/primitives`, `tsgit/commands`, …) — a symbol that is a genuine
 * value at one entry point's declaration carries that shape into every
 * other entry point's re-export of the same chunk, even one that only
 * intended a type-only forward. Those symbols are reachable as real values
 * from their own dedicated entry points (verified separately) and are a
 * distinct, wider surface than this fix's scope — auditing them here would
 * assert the main entry exposes every primitive/command as a loose
 * function, which is not this change's decision to make.
 *
 * `domain/diff`'s own runtime export keys already ARE its value surface —
 * `export type` re-exports never produce a runtime binding, so no `.d.ts`
 * parsing is needed to enumerate them, only the built runtime entry needs
 * checking.
 *
 * Runs against the BUILT `dist/esm/index.node.js`, not `src/`: the
 * declared-vs-runtime pairing this guard locks is a property of the shipped
 * bundle, not reproducible by importing TypeScript source directly (mirrors
 * `dispose-free-exit.test.ts`).
 *
 * @proves
 *   surface:  public-types
 *   bucket:   coverage-gap
 *   unique:   every domain/diff value the .d.ts declares is defined at runtime, not just typed
 */
import { execFile } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { beforeAll, describe, expect, it } from 'vitest';
import * as diffDomainBarrel from '../../src/domain/diff/index.js';

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
