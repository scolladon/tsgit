/**
 * Copies a cached scaled fixture (`fixture-generator.ts`'s `ScaledFixture.cwd`)
 * into a disposable scratch directory. Any bench whose `sut` writes into the
 * fixture — `checkout`, `gc`, or anything else that moves `HEAD`, rewrites the
 * index or rewrites packs — must copy first: the cache is shared byte-for-byte
 * by every other bench file that resolves the same spec, and mutating it in
 * place corrupts every later reader.
 */
import { cp, mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

export interface FixtureScratch {
  /** Disposable byte-copy of a cached fixture — safe to mutate. */
  readonly cwd: string;
  dispose(): Promise<void>;
}

export const copyFixtureToScratch = async (
  sourceCwd: string,
  slug: string,
): Promise<FixtureScratch> => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), `tsgit-bench-${slug}-`));
  await cp(sourceCwd, cwd, { recursive: true, preserveTimestamps: true });
  return {
    cwd,
    dispose: async (): Promise<void> => {
      await rm(cwd, { recursive: true, force: true });
    },
  };
};
