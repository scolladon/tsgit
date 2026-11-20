import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { presentPaths } from '../../../../src/domain/sparse/missing-directory.js';

const NUM_RUNS = 100;
const SLASH = '/';
const arbSegment = fc.stringMatching(/^[abc]{1,2}$/);
const arbPath = fc
  .array(arbSegment, { minLength: 1, maxLength: 4 })
  .map((segments) => segments.join(SLASH));
const arbPaths = fc.uniqueArray(arbPath, { maxLength: 12 }).map((paths) => [...paths].sort());
const arbPresent = fc.uniqueArray(arbPath, { maxLength: 12 });

const parentDirectories = (path: string): string[] =>
  path
    .split(SLASH)
    .slice(0, -1)
    .map((_, i, parents) => `${parents.slice(0, i + 1).join(SLASH)}${SLASH}`);

/** lstat semantics: a directory exists under its name with or without a trailing slash. */
const exists = (
  path: string,
  files: ReadonlySet<string>,
  directories: ReadonlySet<string>,
): boolean =>
  path.endsWith(SLASH)
    ? directories.has(path)
    : files.has(path) || directories.has(`${path}${SLASH}`);

const directoryComponents = (path: string): number => path.split(SLASH).length - 1;

describe('presentPaths properties', () => {
  describe('Given an arbitrary tree closed under parents', () => {
    describe('When probing paths in index order', () => {
      it('Then the result equals the naive exists filter', async () => {
        await fc.assert(
          fc.asyncProperty(arbPaths, arbPresent, async (paths, present) => {
            // Arrange
            const files = new Set(present);
            const directories = new Set(present.flatMap(parentDirectories));
            const probe = async (path: string): Promise<boolean> =>
              exists(path, files, directories);

            // Act
            const result = await presentPaths(paths, probe);

            // Assert
            expect([...result]).toEqual(paths.filter((path) => exists(path, files, directories)));
          }),
          { numRuns: NUM_RUNS },
        );
      });

      it('Then it spends at most one probe per path plus one per directory component', async () => {
        await fc.assert(
          fc.asyncProperty(arbPaths, arbPresent, async (paths, present) => {
            // Arrange
            const files = new Set(present);
            const directories = new Set(present.flatMap(parentDirectories));
            let probes = 0;
            const probe = async (path: string): Promise<boolean> => {
              probes += 1;
              return exists(path, files, directories);
            };

            // Act
            await presentPaths(paths, probe);

            // Assert
            const budget = paths.reduce((sum, p) => sum + 1 + directoryComponents(p), 0);
            expect(probes).toBeLessThanOrEqual(budget);
          }),
          { numRuns: NUM_RUNS },
        );
      });
    });
  });
});
