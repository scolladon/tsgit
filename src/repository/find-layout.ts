import { nativePolicy, type PathPolicy } from '../adapters/node/path-policy.js';
import type { FileSystem } from '../ports/file-system.js';
import type { RepositoryLayoutInput } from '../repository.js';

/**
 * Walk up from `cwd` looking for a `.git` directory. Returns the resolved
 * `RepositoryLayoutInput` when found.
 *
 * Returns `undefined` when no `.git` is found before reaching the filesystem
 * root — callers can choose to default to a fresh repo at `cwd` (init/clone
 * paths) or surface NOT_A_REPOSITORY (most other commands).
 *
 * Accepts a `pathPolicy` so the walk's `resolve` / `dirname` / `join`
 * semantics match the input form. Production code uses `nativePolicy`
 * (host-matching). Tests that pair a POSIX-only adapter (e.g. the
 * in-memory FS) with POSIX-shaped paths can inject `posixPolicy` to keep
 * the walk POSIX-rooted on any host.
 */
export const findLayout = async (
  fs: FileSystem,
  cwd: string,
  pathPolicy: PathPolicy = nativePolicy,
): Promise<RepositoryLayoutInput | undefined> => {
  let current = pathPolicy.resolve(cwd);
  while (true) {
    const candidate = pathPolicy.join(current, '.git');
    // Single stat call — exists() + stat() were redundant since both can
    // throw on path-confined adapters (MemoryFileSystem rejects paths
    // outside rootDir with PERMISSION_DENIED). Any throw OR a non-directory
    // result means "not found at this level"; the walk continues to the
    // parent until either a real .git directory is found or the filesystem
    // root is reached.
    const stat = await fs.stat(candidate).catch(() => undefined);
    if (stat?.isDirectory === true) {
      return { workDir: current, gitDir: candidate, bare: false };
    }
    const parent = pathPolicy.dirname(current);
    if (parent === current) return undefined; // reached filesystem root
    current = parent;
  }
};
