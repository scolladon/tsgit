/**
 * Copies a cached scaled fixture (`fixture-generator.ts`'s `ScaledFixture.cwd`)
 * into a disposable scratch directory. Any bench whose `sut` writes into the
 * fixture — `checkout`, `gc`, or anything else that moves `HEAD`, rewrites the
 * index or rewrites packs — must copy first: the cache is shared byte-for-byte
 * by every other bench file that resolves the same spec, and mutating it in
 * place corrupts every later reader.
 *
 * The copy lives NEXT TO its source, as `<label>-v<N>.scratch.<pid>.<random>`,
 * for two reasons: it lands on the same filesystem as every other measured
 * fixture (a `TMPDIR` on another device would skew the write-heavy benches
 * against their siblings), and a copy orphaned by a killed run is then a
 * leftover `bench:fixture -- --prune` can recognise and reclaim once its pid
 * is gone.
 */
import { rmSync } from 'node:fs';
import { cp, mkdtemp, rm } from 'node:fs/promises';

export interface FixtureScratch {
  /** Disposable byte-copy of a cached fixture — safe to mutate. */
  readonly cwd: string;
  dispose(): Promise<void>;
  /**
   * The removal a bench scenario's `teardown` must use: tinybench fires that
   * hook without awaiting it, so an async removal in the last scenario of a
   * file is cut off when the worker exits and the copy leaks into the cache.
   */
  disposeSync(): void;
}

// Windows refuses to unlink files still held open by the repository handle;
// bounded retries give the handle's asynchronous close a moment to land.
const RM_RETRIES = 10;
const RM_RETRY_DELAY_MS = 100;

export const copyFixtureToScratch = async (sourceCwd: string): Promise<FixtureScratch> => {
  const cwd = await mkdtemp(`${sourceCwd}.scratch.${process.pid}.`);
  await cp(sourceCwd, cwd, { recursive: true, preserveTimestamps: true });
  return {
    cwd,
    dispose: async (): Promise<void> => {
      await rm(cwd, { recursive: true, force: true });
    },
    disposeSync: (): void => {
      rmSync(cwd, {
        recursive: true,
        force: true,
        maxRetries: RM_RETRIES,
        retryDelay: RM_RETRY_DELAY_MS,
      });
    },
  };
};
