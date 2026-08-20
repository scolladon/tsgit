import type { PathPolicy } from '../adapters/node/path-policy.js';
import { isAllowlisted } from '../domain/repository/allowlist.js';
import type { LayoutProbe } from '../ports/layout-probe.js';
import type { WalkOutcome } from './find-layout.js';

/**
 * Trust policy options threaded from `OpenRepositoryOptions`
 * (`src/repository.ts`) down to the gate. See there for the user-facing
 * semantics and warnings; this is the internal, resolution-tier mirror.
 */
export interface TrustOptions {
  readonly trust?: 'ownership' | 'always';
  readonly trustedDirectories?: ReadonlyArray<string>;
  readonly bareRepositories?: 'all' | 'explicit';
}

/**
 * The ownership-trust verdict. `foreignPath` names the FIRST member of the
 * checked set (`checkedPathsOf`, below) the ownership predicate reported
 * unowned — one path, never the whole set.
 */
export type TrustVerdict =
  | { readonly trusted: true }
  | { readonly trusted: false; readonly foreignPath: string };

/** The trusted verdict, shared so every short-circuit returns the same identity. */
export const TRUSTED: TrustVerdict = { trusted: true };

/**
 * The path the gate keys on — the repository root, not necessarily the
 * gitdir. Only the `DISCOVERED` route carries an `origin` (the directory
 * holding the `.git` entry); every other route's own `gitDir` IS the
 * repository path. Reproduces every measured shape: a deep subdirectory
 * gives the repository root; a `.git`-file work tree gives the work tree,
 * not the far-away gitdir it points at; a linked worktree gives the
 * worktree dir, not the common dir; a bare gitdir, a `.git` directory
 * entered directly, and a separate gitdir entered directly all give the
 * gitdir. NOT `layout.workDir ?? layout.gitDir`: `workDir` does not exist
 * yet at this point in resolution (Stage 3 runs below the gate), and git
 * keys on the discovery work tree rather than the `core.worktree` one
 * anyway.
 */
export const repositoryPathOf = (outcome: WalkOutcome): string =>
  outcome.route === 'DISCOVERED' ? outcome.origin : outcome.gitDir;

// Preserves first occurrence — the only property `checkedPathsOf` needs.
const dedupe = (paths: ReadonlyArray<string>): ReadonlyArray<string> => {
  const seen: string[] = [];
  for (const path of paths) {
    if (!seen.includes(path)) seen.push(path);
  }
  return seen;
};

/**
 * The checked set, in the load-bearing order: the refusal reports the FIRST
 * foreign member, so the repository path comes first. That way the reported
 * path is absent exactly when the refusal's own `path` already names the
 * offending directory, and present exactly when it names one the caller
 * owns. Collapses by shape: 1 stat for a bare `BARE_DIR` repository, 2 for a
 * normal discovery and for the gitfile shape, 3 for a linked worktree.
 */
const checkedPathsOf = (
  repositoryPath: string,
  gitDir: string,
  commonDir: string,
): ReadonlyArray<string> => dedupe([repositoryPath, gitDir, commonDir]);

/**
 * The trust verdict, in order — the order IS the semantics: `trust:
 * 'always'` short-circuits before the capability is ever consulted;
 * allowlisting the repository path short-circuits next — keyed on ONE path,
 * never the checked set, or allowlisting a work tree would admit a gitdir at
 * an unrelated location; an adapter that omits `isOwnedByCaller` declares
 * that foreign ownership cannot exist in its world and is trusted; otherwise
 * each member of the checked set is queried in order and the FIRST one
 * reported unowned decides the verdict.
 */
export const evaluateTrust = async (
  probe: LayoutProbe,
  outcome: WalkOutcome,
  commonDir: string,
  opts: TrustOptions,
): Promise<TrustVerdict> => {
  if (opts.trust === 'always') return TRUSTED;
  const repositoryPath = repositoryPathOf(outcome);
  if (isAllowlisted(repositoryPath, opts.trustedDirectories ?? [])) return TRUSTED;
  if (probe.isOwnedByCaller === undefined) return TRUSTED;
  for (const path of checkedPathsOf(repositoryPath, outcome.gitDir, commonDir)) {
    if (!(await probe.isOwnedByCaller(path))) return { trusted: false, foreignPath: path };
  }
  return TRUSTED;
};

/**
 * `bareRepositories: 'explicit'`'s refusal condition: discovery reached the
 * gitdir by the cwd-is-a-gitdir route (`BARE_DIR`) AND the gitdir's basename
 * is not literally `.git` — the shape a planted `evil.git` inside your own
 * checkout takes. Bareness plays NO part: two byte-identical gitdirs
 * differing only in name land on opposite verdicts, and flipping
 * `core.bare` changes neither. Computed independently of the allowlist and
 * of `trust` — neither escape hatch lifts this refusal.
 */
// git exempts two admin locations from the implicit-bare heuristic: a
// submodule gitdir under `.git/modules/` and a linked-worktree admin dir under
// `.git/worktrees/`. Both WERE put there by a normal checkout, which is what
// the heuristic is trying to detect the absence of, and both reach the
// cwd-is-a-gitdir route with a basename that is not `.git`. Measured on 2.55.0
// with `safe.bareRepository=explicit`: git ACCEPTS `main/.git/modules/sub` and
// `main/.git/worktrees/wt`, and refuses a planted `evil.git`.
const ADMIN_EXEMPT_DIRS: ReadonlyArray<string> = ['modules', 'worktrees'];

// Built from the policy's separator rather than a hard-coded '/': the basename
// rule beside this one already goes through `pathPolicy`, and under a Windows
// policy a POSIX-only segment never matches, so the exemption would silently
// stop firing and tsgit would refuse legitimate submodule and linked-worktree
// admin dirs on the one platform where this gate still runs without an
// ownership capability.
const isAdminExempt = (gitDir: string, pathPolicy: PathPolicy): boolean => {
  const { sep } = pathPolicy;
  return ADMIN_EXEMPT_DIRS.some((dir) => gitDir.includes(`${sep}.git${sep}${dir}${sep}`));
};

export const isImplicitBare = (
  outcome: WalkOutcome,
  pathPolicy: PathPolicy,
  bareRepositories: 'all' | 'explicit' | undefined,
): boolean =>
  outcome.route === 'BARE_DIR' &&
  pathPolicy.basename(outcome.gitDir) !== '.git' &&
  !isAdminExempt(outcome.gitDir, pathPolicy) &&
  bareRepositories === 'explicit';
