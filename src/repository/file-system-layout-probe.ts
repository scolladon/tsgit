import type { FileSystem } from '../ports/file-system.js';
import type { LayoutProbe } from '../ports/layout-probe.js';

/**
 * Adapts a `FileSystem` to the narrower `LayoutProbe` surface the discovery
 * walk needs. Both methods catch and map every rejection to `undefined` —
 * see `LayoutProbe`'s JSDoc for why this is a documented absence /
 * containment-denial contract rather than a swallowed error.
 */
export const fileSystemLayoutProbe = (fs: FileSystem): LayoutProbe => ({
  // No `isOwnedByCaller`: every `FileSystem` reachable here is a sandboxed
  // adapter (memory, browser) that hardcodes `uid: 0` for every entry. A
  // predicate derived from that constant would declare every sandboxed
  // repository foreign-owned for any non-root caller — the omission is what
  // keeps a sandbox trusted.
  stat: async (path) => {
    const stat = await fs.stat(path).catch(() => undefined);
    return stat === undefined
      ? undefined
      : { isDirectory: stat.isDirectory, isFile: stat.isFile, size: stat.size };
  },
  readUtf8: (path) => fs.readUtf8(path).catch(() => undefined),
  // Not-a-symlink, absence, and unsupported-operation (OPFS throws; partial
  // test doubles may omit the method entirely) all collapse to undefined —
  // the walk only cares whether usable link text exists, and the async
  // wrapper folds a synchronous throw into the same documented contract.
  readLink: async (path) => {
    try {
      return await fs.readlink(path);
    } catch {
      return undefined;
    }
  },
});
