import type { FileSystem } from '../ports/file-system.js';
import type { LayoutProbe } from '../ports/layout-probe.js';
import type { RepositoryLayoutInput } from '../repository.js';
import { fileSystemLayoutProbe } from './file-system-layout-probe.js';
import type { WalkOutcome } from './find-layout.js';
import { layoutFromGitfile } from './find-layout.js';
import { portablePosixPolicy } from './portable-posix-policy.js';
import { finishLayout, resolveAgainst } from './resolve-layout.js';

/**
 * Overrides `resolveFixedEntryLayout` layers on top of the resolved structural
 * finding — the fixed-entry counterpart of `LayoutOverrides`
 * (`resolve-layout.ts`), which these parameters become downstream anyway.
 */
interface FixedEntryOverrides {
  readonly bare?: boolean;
  readonly workDir?: string;
  /** The argument-tier equivalent of git's `GIT_COMMON_DIR`, resolved against `workDir` before either branch below sees it. */
  readonly commonDir?: string;
}

/** The already-performed `probe.stat(gitDir)` result, threaded in so `locateFixedEntry` never re-stats it. */
type FixedEntryStat = Awaited<ReturnType<LayoutProbe['stat']>>;

/**
 * The structural half of `resolveFixedEntryLayout`: when `entry` is a *file*
 * (a linked worktree's `.git` gitfile), resolves it through the same pointer
 * + commondir grammar `findLayout` uses; otherwise the literal entry is kept,
 * folding in `commonDirOverride` exactly as the gitfile branch does — a plain
 * directory entry never reads a `commondir` file at all on this shim, so the
 * override is the only way one reaches it. Extracted so
 * `resolveFixedEntryLayout` itself stays short.
 */
const locateFixedEntry = async (
  probe: LayoutProbe,
  workDir: string,
  gitDir: string,
  entry: FixedEntryStat,
  commonDirOverride: string | undefined,
): Promise<{ readonly gitDir: string; readonly commonDir?: string }> => {
  if (entry?.isFile === true) {
    return layoutFromGitfile(
      probe,
      workDir,
      gitDir,
      portablePosixPolicy,
      entry.size,
      commonDirOverride,
    );
  }
  return {
    gitDir,
    // `normalizeForCompare`, not raw `!==` — the same degenerate-value rule
    // the walk and explicit routes apply.
    ...(commonDirOverride !== undefined &&
    portablePosixPolicy.normalizeForCompare(commonDirOverride) !==
      portablePosixPolicy.normalizeForCompare(gitDir)
      ? { commonDir: commonDirOverride }
      : {}),
  };
};

/**
 * Resolves a runtime's FIXED `gitDir` entry, pointer-aware — the no-walk
 * counterpart to `findLayout` for shims whose work dir is a constant root
 * (the browser's OPFS `/`). When the entry is a *file* (a linked worktree's
 * `.git` gitfile), it resolves through the same pointer + commondir grammar
 * `findLayout` uses; otherwise the literal entry is kept. Either way the
 * structural finding is always treated as `route: 'DISCOVERED'` with `origin:
 * workDir` — there is no walk here to ever produce a `BARE_DIR` route, so
 * `core.bare` alone (read by the shared Stage 2/3 in `finishLayout`) is what
 * decides bareness, exactly as it does for the node/memory shims.
 * `overrides.bare`, when given, overrides `core.bare` outright — the
 * argument-tier-wins rule. `overrides.workDir`, when given, overrides every
 * config-driven work-tree row the same way `opts.workDir` does on the
 * node/memory shims. `overrides.commonDir`, when given, is resolved against
 * `workDir` ONCE (the browser's cwd is always the fixed root, which is also
 * this parameter) and replaces the file-derived common dir on every branch —
 * see `locateFixedEntry`.
 * Uses `portablePosixPolicy` rather than the Node-backed `posixPolicy` — see
 * that module's doc comment for why.
 */
export const resolveFixedEntryLayout = async (
  fs: FileSystem,
  workDir: string,
  gitDir: string,
  overrides: FixedEntryOverrides = {},
): Promise<RepositoryLayoutInput> => {
  const probe = fileSystemLayoutProbe(fs);
  const resolvedOverride =
    overrides.commonDir === undefined
      ? undefined
      : resolveAgainst(workDir, overrides.commonDir, portablePosixPolicy);
  const entry = await probe.stat(gitDir);
  // Bootstrap shape (nothing at the entry yet): the override — value AND
  // marker — is inert, matching the walk shims' found-nothing doctrine.
  // `init`/`clone` create a normal repository, never the split layout git
  // itself cannot reopen.
  const commonDirOverride = entry === undefined ? undefined : resolvedOverride;
  const located = await locateFixedEntry(probe, workDir, gitDir, entry, commonDirOverride);
  const outcome: WalkOutcome = {
    ...located,
    route: 'DISCOVERED',
    origin: workDir,
    ...(commonDirOverride !== undefined ? { commonDirSupplied: true as const } : {}),
  };
  // No trust options threaded here: this shim always produces `route:
  // 'DISCOVERED'` (there is no walk, so `BARE_DIR` is unreachable) and
  // `fileSystemLayoutProbe` omits `isOwnedByCaller`, so both gates are inert
  // by construction — a parameter here could only ever be ignored.
  const layout = await finishLayout(probe, outcome, portablePosixPolicy, workDir, {
    ...(overrides.bare !== undefined ? { bare: overrides.bare } : {}),
    ...(overrides.workDir !== undefined ? { workDir: overrides.workDir } : {}),
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
