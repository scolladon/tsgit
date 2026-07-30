import type { FileSystem } from '../ports/file-system.js';
import type { LayoutProbe } from '../ports/layout-probe.js';

/**
 * Adapts a `FileSystem` to the narrower `LayoutProbe` surface the discovery
 * walk needs. Both methods catch and map every rejection to `undefined` —
 * see `LayoutProbe`'s JSDoc for why this is a documented absence /
 * containment-denial contract rather than a swallowed error.
 */
export const fileSystemLayoutProbe = (fs: FileSystem): LayoutProbe => ({
  stat: async (path) => {
    const stat = await fs.stat(path).catch(() => undefined);
    return stat === undefined
      ? undefined
      : { isDirectory: stat.isDirectory, isFile: stat.isFile, size: stat.size };
  },
  readUtf8: (path) => fs.readUtf8(path).catch(() => undefined),
});
