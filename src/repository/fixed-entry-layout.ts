import type { FileSystem } from '../ports/file-system.js';
import type { RepositoryLayoutInput } from '../repository.js';
import { fileSystemLayoutProbe } from './file-system-layout-probe.js';
import type { WalkOutcome } from './find-layout.js';
import { layoutFromGitfile } from './find-layout.js';
import { portablePosixPolicy } from './portable-posix-policy.js';
import { finishLayout } from './resolve-layout.js';

/**
 * Resolves a runtime's FIXED `gitDir` entry, pointer-aware — the no-walk
 * counterpart to `findLayout` for shims whose work dir is a constant root
 * (the browser's OPFS `/`). When the entry is a *file* (a linked worktree's
 * `.git` gitfile), it resolves through the same pointer + commondir grammar
 * `findLayout` uses; otherwise the literal entry is kept. Either way the
 * structural finding is always treated as `route: 'DISCOVERED'` with `origin:
 * workDir` — there is no walk here to ever produce a `BARE_DIR` route, so
 * `core.bare` alone (read by the shared Stage 2/3 in `finishLayout`) is what
 * decides bareness, exactly as it does for the node/memory shims. `bare`, when
 * given, overrides `core.bare` outright — the argument-tier-wins rule.
 * `explicitWorkDir`, when given, overrides every config-driven work-tree row
 * the same way `opts.workDir` does on the node/memory shims.
 * Uses `portablePosixPolicy` rather than the Node-backed `posixPolicy` — see
 * that module's doc comment for why.
 */
export const resolveFixedEntryLayout = async (
  fs: FileSystem,
  workDir: string,
  gitDir: string,
  bare?: boolean,
  explicitWorkDir?: string,
): Promise<RepositoryLayoutInput> => {
  const probe = fileSystemLayoutProbe(fs);
  const entry = await probe.stat(gitDir);
  const located =
    entry?.isFile === true
      ? await layoutFromGitfile(probe, workDir, gitDir, portablePosixPolicy, entry.size)
      : { gitDir };
  const outcome: WalkOutcome = { ...located, route: 'DISCOVERED', origin: workDir };
  // No trust options threaded here: this shim always produces `route:
  // 'DISCOVERED'` (there is no walk, so `BARE_DIR` is unreachable) and
  // `fileSystemLayoutProbe` omits `isOwnedByCaller`, so both gates are inert
  // by construction — a parameter here could only ever be ignored.
  const layout = await finishLayout(probe, outcome, portablePosixPolicy, workDir, {
    ...(bare !== undefined ? { bare } : {}),
    ...(explicitWorkDir !== undefined ? { workDir: explicitWorkDir } : {}),
  });
  if (entry !== undefined) return layout;
  // Nothing exists at the entry yet — this is the bootstrap shape `init` and
  // `clone` open before there is a repository to describe. `finishLayout`
  // states `objectFormat` UNCONDITIONALLY (sha1 when the key is absent),
  // which is right for a repository that EXISTS and simply declares nothing,
  // but wrong here: a format nobody has written yet is unknown, not sha1.
  // Reporting sha1 makes `resolveAlgorithm` treat a defaulted value as a
  // declaration and refuse `openRepository({ algorithm: 'sha256' })` with
  // OBJECT_FORMAT_CONFLICT — on the walk-based shims the same call succeeds,
  // because a found-nothing walk yields `syntheticFallbackLayout`, which
  // never sets the field. Dropping it here restores that parity.
  const { objectFormat: _undeclared, ...bootstrap } = layout;
  return bootstrap;
};
