import { vi } from 'vitest';
import type { Context } from '../../../src/ports/context.js';

export const EXECUTABLE_STAT_MODE = 0o100755;

const STAT_PROBES = ['lstat', 'lstatIfReachable', 'tryLstat'] as const;

/** Makes every work-tree stat report the exec bits set, so a file differs from its index entry by mode alone. */
export const withExecutableWorkFile = (ctx: Context): void => {
  for (const probe of STAT_PROBES) {
    const original = ctx.fs[probe]?.bind(ctx.fs);
    if (original === undefined) continue;
    vi.spyOn(ctx.fs, probe).mockImplementation(async (path: string) => {
      const stat = await original(path);
      return stat === undefined ? stat : { ...stat, mode: EXECUTABLE_STAT_MODE };
    });
  }
};
