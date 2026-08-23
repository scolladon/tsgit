import type { PathPolicy } from '../adapters/node/path-policy.js';
import { workTreeUnresolvable } from '../domain/repository/error.js';
import type { LayoutProbe } from '../ports/layout-probe.js';
import type { RepositoryLayoutInput } from '../repository.js';
import { findLayout, resolveCommonDir, resolvePointer, type WalkOutcome } from './find-layout.js';
import { type RepositoryFormat, readRepositoryFormat } from './read-repository-format.js';
import {
  evaluateTrust,
  isImplicitBare,
  TRUSTED,
  type TrustOptions,
  type TrustVerdict,
} from './trust-verdict.js';

/**
 * Explicit layout arguments `resolveLayout` accepts on top of discovery —
 * the argument-tier equivalents of `--git-dir` / `--work-tree` /
 * `--is-bare-repository` (forced) / `GIT_CEILING_DIRECTORIES`. All optional;
 * an empty object behaves exactly like discovery alone.
 */
export interface ExplicitLayoutOptions {
  readonly gitDir?: string;
  readonly workDir?: string;
  readonly bare?: boolean;
  readonly ceilingDirs?: ReadonlyArray<string>;
  readonly trust?: 'ownership' | 'always';
  readonly trustedDirectories?: ReadonlyArray<string>;
  readonly bareRepositories?: 'all' | 'explicit';
}

/**
 * Adapter-supplied physical-path capabilities the resolution may lean on.
 * `realWorkTreePath` physically resolves a RELATIVE `core.worktree` join
 * (symlinks followed), returning `undefined` when the target does not exist —
 * git resolves the relative form by actually changing directory there, so a
 * missing target is a setup refusal, not a lexical fallback. Adapters with no
 * physical notion of a path (memory, browser) omit the capability entirely
 * and stay lexical — the same sandboxed-adapter split every other
 * canonicalisation follows.
 */
export interface LayoutCapabilities {
  readonly realWorkTreePath?: (path: string) => Promise<string | undefined>;
}

/**
 * The work tree a `finishLayout` call resolved, plus whether the work-tree
 * config is bogus (`core.bare` and `core.worktree` both set). Kept as one
 * shape rather than two return values so the two facts travel together and
 * `finishLayout` cannot forget to fold in the bogus flag.
 */
interface WorkTreeResolution {
  readonly workDir?: string;
  readonly workTreeConfigBogus?: boolean;
}

/**
 * A discovered `.git` entry whose `commonDir` differs from its own `gitDir`
 * is a linked worktree's admin dir (the `commondir` file is the ONLY thing
 * that makes them differ — a submodule or `--separate-git-dir` gitdir has no
 * `commondir` file and so is its own common dir). `core.bare` lives in the
 * SHARED config, so a bare main repo's `core.bare = true` is visible from
 * every one of its linked worktrees too — but a linked worktree always HAS a
 * work tree (that is what makes it a worktree), independent of what the
 * shared config says about the main checkout. Measured: `--is-bare-repository`
 * is `false` from inside a linked worktree of a bare repo even though the
 * shared config's `core.bare` reads `true`.
 *
 * Scoped to the `DISCOVERED` route only — no measured row extends this
 * bypass to an explicit gitDir naming a worktree admin dir directly, so the
 * EXPLICIT route falls through to the plain `core.bare` precedence instead.
 */
const isLinkedWorktreeAdmin = (outcome: WalkOutcome): boolean =>
  outcome.route === 'DISCOVERED' && outcome.commonDir !== undefined;

/**
 * Resolve `value` against `base`: absolute verbatim (normalized), relative
 * joined onto `base`. Deliberately NOT `pathPolicy.resolve(base, value)` —
 * `portablePosixPolicy` (the memory/browser shims) does not implement
 * `node:path.resolve`'s "a later absolute argument wins" multi-arg
 * semantics (its own doc comment scopes it to single-base joins only), so a
 * two-arg `resolve` call would silently nest an absolute `value` under
 * `base` instead of using it directly. Branching on `isAbsolute` here works
 * identically under every `PathPolicy` implementation.
 */
export const resolveAgainst = (base: string, value: string, pathPolicy: PathPolicy): string =>
  pathPolicy.isAbsolute(value)
    ? pathPolicy.resolve(value)
    : pathPolicy.resolve(pathPolicy.join(base, value));

/**
 * The work-tree precedence: an explicit work-tree argument (`opts.workDir`,
 * resolved against `cwd`) wins outright, even over `core.bare = true` —
 * silently, no bogus-config warning (that warning is reserved for the
 * `core.bare` + `core.worktree` combination). Absent that, `core.bare` true
 * means no work tree (and marks the config bogus when `core.worktree` is
 * ALSO set) — UNLESS this gitDir is a linked worktree's own admin dir, which
 * always has one; an explicit `core.worktree` wins next, absolute verbatim
 * or resolved lexically against `gitDir` when relative (the node shim
 * realpaths the result afterward — `core.worktree` resolution is physical,
 * but this tier stays lexical so sandboxed adapters, which have no realpath,
 * resolve identically); otherwise the route decides: the directory holding a
 * discovered `.git` entry, cwd itself for an explicit gitDir with nothing
 * else set (the load-bearing surprise a `--git-dir` argument alone defaults
 * a work tree that cwd-is-gitdir discovery of the SAME directory would not),
 * or no work tree for a bare-shaped gitDir found by cwd-is-gitdir discovery.
 */
const resolveWorkTree = async (
  outcome: WalkOutcome,
  fmt: RepositoryFormat,
  bareCfg: boolean | undefined,
  pathPolicy: PathPolicy,
  cwd: string,
  explicitWorkDir: string | undefined,
  caps: LayoutCapabilities,
): Promise<WorkTreeResolution> => {
  if (explicitWorkDir !== undefined) {
    return { workDir: resolveAgainst(cwd, explicitWorkDir, pathPolicy) };
  }
  if (bareCfg === true && !isLinkedWorktreeAdmin(outcome)) {
    return fmt.worktree !== undefined ? { workTreeConfigBogus: true } : {};
  }
  if (fmt.worktree !== undefined) {
    return { workDir: await resolveConfigWorkTree(outcome.gitDir, fmt.worktree, pathPolicy, caps) };
  }
  if (outcome.route === 'DISCOVERED') return { workDir: outcome.origin };
  if (outcome.route === 'EXPLICIT') return { workDir: cwd };
  return {};
};

/**
 * `core.worktree`'s two resolution shapes, mirroring git's setup: an ABSOLUTE
 * value is recorded verbatim (a missing target refuses only later, when a
 * work-tree command runs — the caller's post-hoc canonicalisation follows
 * symlinks best-effort); a RELATIVE value is resolved PHYSICALLY from the
 * gitDir, so on an adapter exposing `realWorkTreePath` a missing target is a
 * setup refusal. Without the capability the join stays lexical — the
 * sandboxed-adapter divergence documented on `LayoutCapabilities`.
 */
const resolveConfigWorkTree = async (
  gitDir: string,
  value: string,
  pathPolicy: PathPolicy,
  caps: LayoutCapabilities,
): Promise<string> => {
  if (pathPolicy.isAbsolute(value)) return pathPolicy.resolve(value);
  const lexical = pathPolicy.resolve(pathPolicy.join(gitDir, value));
  if (caps.realWorkTreePath === undefined) return lexical;
  const physical = await caps.realWorkTreePath(lexical);
  if (physical === undefined) throw workTreeUnresolvable(value, gitDir);
  return physical;
};

/** `bare` / `workDir` overrides `finishLayout` applies on top of config, plus the trust policy gating Stage 2. */
interface LayoutOverrides {
  readonly bare?: boolean;
  readonly workDir?: string;
  readonly trustOptions?: TrustOptions;
}

/**
 * The empty repository-format shape `finishLayout` substitutes when the
 * trust gate refuses discovery — skipping the config read entirely rather
 * than reading a file the caller was told not to trust. A module constant,
 * not an inline literal, is what makes the skip legible at the call site.
 */
const EMPTY_FORMAT: RepositoryFormat = {
  bare: undefined,
  worktree: undefined,
  worktreeConfig: false,
  objectFormat: 'sha1',
  refStorage: 'files',
  refusal: undefined,
};

/** `finishLayout`'s trust-gate outcome: the ownership verdict, the implicit-bare refusal, and whether Stage 2 may run. */
interface TrustGate {
  readonly verdict: TrustVerdict;
  readonly implicitBare: boolean;
  readonly accepted: boolean;
}

/**
 * The ownership-trust gate, evaluated ABOVE the first config byte the open
 * sequence reads (`readRepositoryFormat`, in `finishLayout` below). The
 * explicit-gitDir route is never gated — `evaluateTrust` is skipped
 * outright, matching git's measured behaviour. `accepted` folds the
 * ownership verdict and the implicit-bare refusal into one flag that
 * neither trust escape hatch (`trust: 'always'`, `trustedDirectories`)
 * lifts.
 */
const resolveTrustGate = async (
  probe: LayoutProbe,
  outcome: WalkOutcome,
  commonDir: string,
  pathPolicy: PathPolicy,
  trustOptions: TrustOptions,
): Promise<TrustGate> => {
  const gated = outcome.route !== 'EXPLICIT';
  const implicitBare = isImplicitBare(outcome, pathPolicy, trustOptions.bareRepositories);
  const verdict = gated ? await evaluateTrust(probe, outcome, commonDir, trustOptions) : TRUSTED;
  return { verdict, implicitBare, accepted: verdict.trusted && !implicitBare };
};

/**
 * The found-nothing bootstrap layout: discovery judged that NO repository
 * exists, so nothing on disk is trusted — in particular, a config inside a
 * `.git` entry that failed validation is never read (git reports
 * `not a git repository` there; reading a rejected directory's config would
 * hand a planted file control over bareness, the work tree, and thereby the
 * containment root set). Only the caller's own arguments participate:
 * `overrides.workDir` wins (resolved against `cwd`), `overrides.bare: true`
 * yields a bare bootstrap, and the default is the historical non-bare shape
 * at `defaultWorkDir`.
 */
export const syntheticFallbackLayout = (
  gitDir: string,
  defaultWorkDir: string,
  cwd: string,
  overrides: LayoutOverrides,
  pathPolicy: PathPolicy,
): RepositoryLayoutInput => {
  const workDir =
    overrides.workDir !== undefined
      ? resolveAgainst(cwd, overrides.workDir, pathPolicy)
      : overrides.bare === true
        ? undefined
        : defaultWorkDir;
  return {
    gitDir,
    ...(workDir !== undefined ? { workDir } : {}),
    bare: overrides.bare === true && workDir === undefined,
    // The bootstrap reads nothing from disk (see the JSDoc above), so the
    // ref-storage backend defaults the same way git's own bootstrap does:
    // `bootstrapRepository` writes no `[extensions]` unless a caller asks
    // for reftable explicitly.
    refStorage: 'files',
  };
};

/**
 * Stages 2–4 of layout resolution, given a structural `WalkOutcome` (from the
 * walk, the explicit route, or a fixed-entry shim that has no walk at all):
 * read the repository-format config keys, decide the work tree by
 * precedence, then derive `bare`. `overrides.bare`, when given, wins
 * outright over `core.bare`, and `overrides.workDir` wins outright over
 * every config-driven work-tree row — the argument-tier-beats-config-tier
 * rule every explicit layout option follows. `cwd` is the base an explicit
 * `overrides.workDir` (or an EXPLICIT-route default) resolves against.
 */
export const finishLayout = async (
  probe: LayoutProbe,
  outcome: WalkOutcome,
  pathPolicy: PathPolicy,
  cwd: string,
  overrides: LayoutOverrides = {},
  caps: LayoutCapabilities = {},
): Promise<RepositoryLayoutInput> => {
  const commonDir = outcome.commonDir ?? outcome.gitDir;
  const { verdict, implicitBare, accepted } = await resolveTrustGate(
    probe,
    outcome,
    commonDir,
    pathPolicy,
    overrides.trustOptions ?? {},
  );
  const fmt = accepted
    ? await readRepositoryFormat(probe, outcome.gitDir, commonDir, pathPolicy)
    : EMPTY_FORMAT;
  const bareCfg = overrides.bare ?? fmt.bare;
  const { workDir, workTreeConfigBogus } = await resolveWorkTree(
    outcome,
    fmt,
    bareCfg,
    pathPolicy,
    cwd,
    overrides.workDir,
    caps,
  );
  // `bareCfg` unset (neither an override nor `core.bare`) is TRUTHY here —
  // git's `is_bare_repository_cfg` defaults to -1, not 0.
  const bare = bareCfg !== false && workDir === undefined;
  return {
    gitDir: outcome.gitDir,
    ...(outcome.commonDir !== undefined ? { commonDir: outcome.commonDir } : {}),
    ...(workDir !== undefined ? { workDir } : {}),
    bare,
    ...(workTreeConfigBogus === true ? { workTreeConfigBogus: true as const } : {}),
    ...(implicitBare ? { implicitBare: true as const } : {}),
    ...(verdict.trusted ? {} : { untrusted: true as const, foreignPath: verdict.foreignPath }),
    ...(fmt.refusal !== undefined ? { formatRefusal: fmt.refusal } : {}),
    // Unlike every other optional field above, this one is UNCONDITIONAL:
    // an opened repository's object format is always resolvable (sha1 is
    // the answer when the key is absent, exactly like `bare`), so a caller
    // omitting `objectFormat` here would read as "unknown" rather than "sha1"
    // — collapsing the very distinction `resolveAlgorithm`'s contradiction
    // check depends on to catch a mismatch against an UNDECLARED (sha1)
    // repository, the overwhelmingly common shape. `syntheticFallbackLayout`
    // (the found-nothing bootstrap path `init`/`clone` take) is the one
    // legitimate "unknown" case, and it never sets this field at all.
    objectFormat: fmt.objectFormat,
    // Carries `fmt.refStorage` straight through — never sniffs the
    // filesystem for a `reftable/` directory. The extension, not the
    // directory, is authoritative (measured): a repository declaring
    // reftable with no `reftable/` directory yet is a valid empty-stack
    // reftable repository.
    refStorage: fmt.refStorage,
  };
};

/**
 * Stage 1's explicit-gitDir route: `opts.gitDir` resolves against `cwd`
 * (relative values join against it; an absolute value wins outright — the
 * same "argument tier resolves against cwd but isn't required absolute"
 * rule `validateOptions` leaves unenforced for this reason). A regular FILE
 * is read as a gitfile pointer via the shared grammar, inheriting its
 * refusals; a missing or empty directory resolves LENIENTLY — no candidate
 * validation runs here, unlike the walk's `.git`-directory branch — because
 * that leniency is the only way `init`/`clone` can bootstrap into an empty
 * target. Refusals then surface at first command: `assertRepository` catches
 * the truly-absent shape, while a present-but-malformed gitdir fails later,
 * inside the primitives tier, with object-level errors rather than git's
 * up-front `not a git repository` fatal — a documented refusal-shape
 * divergence confined to the caller's own named directory.
 */
const resolveExplicitOutcome = async (
  probe: LayoutProbe,
  gitDirOpt: string,
  cwd: string,
  pathPolicy: PathPolicy,
): Promise<WalkOutcome> => {
  const entry = resolveAgainst(cwd, gitDirOpt, pathPolicy);
  const stat = await probe.stat(entry);
  const gitDir =
    stat?.isFile === true
      ? await resolvePointer(probe, entry, pathPolicy.dirname(entry), pathPolicy, stat.size)
      : entry;
  const commonDir = await resolveCommonDir(probe, gitDir, pathPolicy);
  return {
    route: 'EXPLICIT',
    gitDir,
    ...(commonDir !== gitDir ? { commonDir } : {}),
  };
};

/**
 * Resolve the full physical layout for `cwd`: `opts.gitDir`, when given,
 * skips discovery entirely (Stage 1's explicit route); otherwise walk up
 * looking for a `.git` entry or a cwd-is-gitdir match, bounded by
 * `opts.ceilingDirs` (ignored on the explicit route — no walk happens).
 * Either way, apply Stages 2–4. `undefined` only when discovery itself found
 * nothing — callers default to a fresh (non-bare) repository at `cwd` for
 * `init`/`clone` to bootstrap into, or surface `NOT_A_REPOSITORY` at first
 * command. The explicit route never returns `undefined`: an unresolvable
 * gitDir still produces a layout, leniently (see `resolveExplicitOutcome`).
 */
export const resolveLayout = async (
  probe: LayoutProbe,
  cwd: string,
  pathPolicy: PathPolicy,
  opts: ExplicitLayoutOptions = {},
  caps: LayoutCapabilities = {},
): Promise<RepositoryLayoutInput | undefined> => {
  const outcome =
    opts.gitDir !== undefined
      ? await resolveExplicitOutcome(probe, opts.gitDir, cwd, pathPolicy)
      : await findLayout(probe, cwd, pathPolicy, opts.ceilingDirs);
  if (outcome === undefined) return undefined;
  return finishLayout(
    probe,
    outcome,
    pathPolicy,
    cwd,
    {
      ...(opts.bare !== undefined ? { bare: opts.bare } : {}),
      ...(opts.workDir !== undefined ? { workDir: opts.workDir } : {}),
      trustOptions: {
        ...(opts.trust !== undefined ? { trust: opts.trust } : {}),
        ...(opts.trustedDirectories !== undefined
          ? { trustedDirectories: opts.trustedDirectories }
          : {}),
        ...(opts.bareRepositories !== undefined ? { bareRepositories: opts.bareRepositories } : {}),
      },
    },
    caps,
  );
};
