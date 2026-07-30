import type { FileSystem } from '../ports/file-system.js';
import type { RepositoryLayoutInput } from '../repository.js';
import { fileSystemLayoutProbe } from './file-system-layout-probe.js';
import { layoutFromGitfile } from './find-layout.js';
import { portablePosixPolicy } from './portable-posix-policy.js';

/**
 * Resolves a runtime's FIXED `gitDir` entry, pointer-aware — the no-walk
 * counterpart to `findLayout` for shims whose work dir is a constant root
 * (the browser's OPFS `/`). When the entry is a *file* (a linked worktree's
 * `.git` gitfile), it resolves through the same pointer + commondir grammar
 * `findLayout` uses; otherwise the literal layout is kept. `layoutFromGitfile`
 * always reports `bare: false`, so the caller-supplied `bare` is applied on
 * top of whichever branch resolved the layout — discovery never decides
 * bare-ness. Uses `portablePosixPolicy` rather than the Node-backed
 * `posixPolicy` — see that module's doc comment for why.
 */
export const resolveFixedEntryLayout = async (
  fs: FileSystem,
  workDir: string,
  gitDir: string,
  bare: boolean,
): Promise<RepositoryLayoutInput> => {
  const probe = fileSystemLayoutProbe(fs);
  const entry = await probe.stat(gitDir);
  if (entry?.isFile === true) {
    const resolved = await layoutFromGitfile(
      probe,
      workDir,
      gitDir,
      portablePosixPolicy,
      entry.size,
    );
    return { ...resolved, bare };
  }
  return { workDir, gitDir, bare };
};
