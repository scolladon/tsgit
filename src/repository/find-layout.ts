import type { PathPolicy } from '../adapters/node/path-policy.js';
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
 * `pathPolicy` is required so the walk's `resolve` / `dirname` / `join`
 * semantics match the input form. Callers in production code source the
 * host-matching policy from the adapter they constructed; tests that pair
 * a POSIX-only adapter (e.g. the in-memory FS) with POSIX-shaped paths
 * inject `posixPolicy` to keep the walk POSIX-rooted on any host. The
 * previous `nativePolicy = …` default crossed the hexagonal boundary
 * (repository → adapter); per §14.5.8 the default moved to the call
 * site.
 */
export const findLayout = async (
  fs: FileSystem,
  cwd: string,
  pathPolicy: PathPolicy,
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
