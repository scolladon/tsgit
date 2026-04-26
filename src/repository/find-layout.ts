import * as nodePath from 'node:path';

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
 * The walk uses POSIX `nodePath.dirname` semantics; on Windows it traverses
 * up the drive root identically. Cross-platform safe because both Node and
 * the in-memory FS treat `/` as the boundary.
 */
export const findLayout = async (
  fs: FileSystem,
  cwd: string,
): Promise<RepositoryLayoutInput | undefined> => {
  let current = nodePath.resolve(cwd);
  while (true) {
    const candidate = `${current}/.git`;
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
    const parent = nodePath.dirname(current);
    if (parent === current) return undefined; // reached filesystem root
    current = parent;
  }
};
