/**
 * Precondition check for the suites that run against the shipped bundle
 * rather than `src/` — a plain `node` child process cannot resolve this
 * tree's `.js`-specifier-for-`.ts`-file imports, so those suites read
 * `dist/`.
 *
 * **Why this is a check and not a build.** These suites used to run
 * `npm run build` from a `beforeAll`. That script is wireit, so the build
 * nested a second wireit invocation inside whichever one was already
 * running: `npm run validate` reaches `test:integration` while `check:size`,
 * `check:exports` and `check:tarball` are also in its graph, and every one of
 * those builds. Two wireit processes then contended for one `.wireit`
 * directory — the nested build either blocked until the 600 000 ms hook
 * timeout fired (three of them, turning a 90-second suite into a 20-minute
 * one that then failed) or tripped wireit's own
 * `Did not expect <cache path> to already exist` internal error. It presented
 * as an intermittent hang because a warm cache makes the nested build an
 * instant no-op; only a cold `.wireit` exposed it.
 *
 * `test:integration` now declares `build` among its wireit dependencies, so
 * the artefacts are guaranteed fresh before the first test runs and the
 * ordering is the task graph's job. What remains here is a precondition with
 * a legible failure: a bare `vitest run` skips wireit entirely, and without
 * this the suite would fail on an opaque module-resolution error instead.
 */
import { stat } from 'node:fs/promises';

/** Fails loudly, and with the remedy, when the shipped bundle is absent. */
export const requireBuiltArtefact = async (entry: string): Promise<void> => {
  try {
    await stat(entry);
  } catch {
    throw new Error(
      `missing build output: ${entry} — this suite reads the shipped bundle, not src/. ` +
        'Run it through `npm run test:integration` or `npm run validate`, which build first; ' +
        'a bare `vitest run` does not.',
    );
  }
};
