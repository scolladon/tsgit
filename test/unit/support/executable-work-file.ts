import { vi } from 'vitest';
import type { Context } from '../../../src/ports/context.js';

export const EXECUTABLE_STAT_MODE = 0o100755;

const STAT_PROBES = ['lstat', 'lstatIfReachable', 'tryLstat'] as const;

/**
 * Makes work-tree stats report the exec bits set, so a file differs from its index entry by mode alone;
 * `only` narrows it to the paths ending in that name.
 */
export const withExecutableWorkFile = (ctx: Context, only?: string): void => {
  for (const probe of STAT_PROBES) {
    const original = ctx.fs[probe]?.bind(ctx.fs);
    if (original === undefined) continue;
    vi.spyOn(ctx.fs, probe).mockImplementation(async (path: string) => {
      const stat = await original(path);
      if (stat === undefined) return stat;
      return only === undefined || path.endsWith(`/${only}`)
        ? { ...stat, mode: EXECUTABLE_STAT_MODE }
        : stat;
    });
  }
};
