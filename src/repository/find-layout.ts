import type { PathPolicy } from '../adapters/node/path-policy.js';
import type { FilePath } from '../domain/objects/object-id.js';
import { notARepository } from '../domain/repository/error.js';
import { isRefsLinkText, isValidHeadContent } from '../domain/repository/head-ref.js';
import { gitfileInvalidFormat, gitfileNoPath } from '../domain/worktree/error.js';
import { parseCommondir, parseGitfilePointer } from '../domain/worktree/gitfile.js';
import type { LayoutProbe } from '../ports/layout-probe.js';
import { longestStrictAncestor } from './ceiling-stop.js';
import { type Speculated, settleSpeculation, speculate } from './speculate.js';

/**
 * The walk's raw structural finding: where the gitDir (and, if different, the
 * common dir) live, and which route found it — `'DISCOVERED'` (a `.git`
 * entry) or `'BARE_DIR'` (cwd itself qualifies). Config-driven work-tree
 * resolution turns this into a full layout — the walk itself never decides a
 * work tree or bareness. A discriminated union (rather than an `origin?`
 * flattened onto both routes) so a `DISCOVERED` outcome's `origin` — the
 * directory holding the `.git` entry — is not-undefined by construction; the
 * discriminant itself is why `route` carries literal types here rather than a
 * named `WalkRoute` alias, which could not narrow the two arms apart.
 *
 * `commonDirSupplied` carries the FACT that a caller named a common dir,
 * separately from the value itself — a degenerate override (one resolving
 * equal to `gitDir`) is normalised OFF the outcome, so `commonDir !==
 * undefined` alone can no longer answer "did the caller supply one". Read
 * only by `resolveWorkTree` (`resolve-layout.ts`'s `isLinkedWorktreeAdmin`)
 * and never emitted onto `RepositoryLayoutInput` — `finishLayout` emits
 * `outcome.commonDir` alone.
 */
export type WalkOutcome =
  | {
      readonly route: 'DISCOVERED';
      readonly gitDir: string;
      readonly commonDir?: string;
      readonly commonDirSupplied?: true;
      readonly origin: string;
    }
  | {
      readonly route: 'BARE_DIR';
      readonly gitDir: string;
      readonly commonDir?: string;
      readonly commonDirSupplied?: true;
    }
  | {
      readonly route: 'EXPLICIT';
      readonly gitDir: string;
      readonly commonDir?: string;
      readonly commonDirSupplied?: true;
    };

/** A resolved gitDir location — the shared output of the `.git`-directory and cwd-is-gitdir checks. */
interface GitDirLocation {
  readonly gitDir: string;
  readonly commonDir?: string;
}

/** The settled shape `LayoutProbe['stat']` resolves to. */
type ProbeStat = Awaited<ReturnType<LayoutProbe['stat']>>;

/**
 * The three probes only worth starting when there is no caller-supplied
 * common dir to make them moot: `<gitDir>/commondir`, `<gitDir>/objects` and
 * `<gitDir>/refs` — always started, and always read, together.
 */
interface SharedDirProbes {
  readonly commondir: Promise<Speculated<ProbeStat>>;
  readonly objects: Promise<Speculated<ProbeStat>>;
  readonly refs: Promise<Speculated<ProbeStat>>;
}

/**
 * Where the candidate's common dir comes from: the caller's own override
 * (the speculative `SharedDirProbes` were never even started), or the
 * speculative `commondir`/`objects`/`refs` reads fired alongside `HEAD`'s. A
 * discriminated union rather than an optional `SharedDirProbes` field so
 * every reader narrows by `kind` instead of asserting non-null against an
 * invariant `startCandidateProbes` enforces three functions away.
 */
type CommonDirSource =
  | { readonly kind: 'override'; readonly commonDir: string }
  | { readonly kind: 'speculative'; readonly probes: SharedDirProbes };

/** Every probe `layoutForDiscoveredGitDir` fires before evaluating anything. */
interface CandidateProbes {
  readonly linkText: Promise<Speculated<string | undefined>>;
  readonly head: Promise<Speculated<ProbeStat>>;
  readonly commonDirSource: CommonDirSource;
}

/**
 * Walk up from `cwd` looking for a `.git` entry, and — at every level — ask
 * whether the level itself is a git directory. A `.git` **directory** is a
 * candidate: if it does not validate (missing or malformed `HEAD`, missing
 * `objects`/`refs`) the walk falls through to the cwd-is-gitdir check at the
 * same level, then continues upward — though an unusable `commondir` past a
 * valid `HEAD` is a hard stop even here, exactly as git dies on it. A
 * `.git` **file** (a linked-worktree/submodule/
 * `--separate-git-dir` gitfile pointer) is a commitment: once found, it is
 * resolved and either returns a layout or throws — the walk never falls back
 * to an ancestor repository past an unusable gitfile. The cwd-is-gitdir check
 * probes `HEAD` first, so a level with neither a `.git` entry nor a `HEAD`
 * costs one extra `stat` (plus, on adapters exposing `readLink`, one
 * `readlink` — the price of judging a symlinked `HEAD` by its link text the
 * way git does) over the pre-existing walk.
 *
 * Returns `undefined` when no usable git directory is found before reaching
 * the filesystem root — callers can choose to default to a fresh repo at
 * `cwd` (init/clone paths) or surface NOT_A_REPOSITORY (most other commands).
 *
 * `pathPolicy` is required so the walk's `resolve` / `dirname` / `join`
 * semantics match the input form. Callers in production code source the
 * host-matching policy from the adapter they constructed; tests that pair
 * a POSIX-only adapter (e.g. the in-memory FS) with POSIX-shaped paths
 * inject `posixPolicy` to keep the walk POSIX-rooted on any host. The
 * default was lifted out of this module to avoid the repository layer
 * reaching across the hexagonal boundary into an adapter.
 *
 * `ceilingDirs`, when given, bounds the climb: `longestStrictAncestor` is
 * computed ONCE before the loop starts (never per level), and the loop head
 * refuses to examine — or look past — that directory. Omitted entirely, the
 * walk behaves exactly as before.
 *
 * `commonDirOverride`, when given, replaces the file-derived common dir at
 * EVERY level's candidate check — before validation, not after. An override
 * lacking `objects/` or `refs/` makes the walk REFUSE at the first
 * valid-`HEAD` candidate with `NOT_A_REPOSITORY` rather than climb (see the
 * rationale at the throw site in `layoutFor`): the same override
 * invalidates every level equally, so climbing could only end at the
 * found-nothing bootstrap adopting a repository with the override silently
 * dropped. The override is resolved against `cwd` by the
 * caller before reaching here; every route this walk can take honours it,
 * including the cwd-is-gitdir branch (git reports it there too via
 * `rev-parse --git-common-dir`) — only the *bareness* rule is inert on that
 * route, which the work-tree resolution stage handles, not the walk.
 */
export const findLayout = async (
  probe: LayoutProbe,
  cwd: string,
  pathPolicy: PathPolicy,
  ceilingDirs?: ReadonlyArray<string>,
  commonDirOverride?: string,
): Promise<WalkOutcome | undefined> => {
  let current = pathPolicy.resolve(cwd);
  const atCeiling = ceilingTest(ceilingDirs, current, pathPolicy);
  const marker = suppliedMarker(commonDirOverride);
  while (true) {
    if (atCeiling(current)) return undefined;
    const candidate = pathPolicy.join(current, '.git');
    // stat, not lstat — a .git symlink to a real gitdir behaves as a directory.
    const stat = await probe.stat(candidate);
    if (stat?.isDirectory === true) {
      const located = await layoutForDiscoveredGitDir(
        probe,
        candidate,
        pathPolicy,
        commonDirOverride,
      );
      if (located !== undefined) {
        return { ...located, route: 'DISCOVERED', origin: current, ...marker };
      }
    } else if (stat?.isFile === true) {
      const located = await layoutFromGitfile(
        probe,
        current,
        candidate,
        pathPolicy,
        stat.size,
        commonDirOverride,
      );
      return { ...located, route: 'DISCOVERED', origin: current, ...marker };
    }
    // Reached when `current` holds no `.git` entry, or an invalid `.git`
    // directory (the candidate branch above fell through rather than
    // returning) — never after a `.git` file, which always returns or throws.
    // The same validator asks whether `current` ITSELF is a git directory.
    // No `...marker` here: BARE_DIR is measured override-inert (bareness
    // follows `core.bare` alone) and its sole reader early-returns on the
    // route, so setting the field would be dead data on that arm.
    const bareLocated = await layoutFor(probe, current, pathPolicy, commonDirOverride);
    if (bareLocated !== undefined) return { ...bareLocated, route: 'BARE_DIR' };
    const parent = pathPolicy.dirname(current);
    if (parent === current) return undefined; // reached filesystem root
    current = parent;
  }
};

/**
 * The walk's loop-head ceiling predicate, computed ONCE before the loop.
 * Comparison goes through `normalizeForCompare` — the same normalisation the
 * ceiling selection itself uses — because a raw equality would walk straight
 * past a case-mismatched stop on a case-insensitive filesystem, failing open
 * on the one bound the caller set.
 */
const ceilingTest = (
  ceilingDirs: ReadonlyArray<string> | undefined,
  resolvedCwd: string,
  pathPolicy: PathPolicy,
): ((current: string) => boolean) => {
  const ceilStop = longestStrictAncestor(ceilingDirs, resolvedCwd, pathPolicy);
  if (ceilStop === undefined) return () => false;
  const ceilKey = pathPolicy.normalizeForCompare(ceilStop);
  return (current) => pathPolicy.normalizeForCompare(current) === ceilKey;
};

/** The caller-supplied marker, spread onto whichever outcome the walk returns. */
const suppliedMarker = (commonDirOverride: string | undefined): { commonDirSupplied?: true } =>
  commonDirOverride === undefined ? {} : { commonDirSupplied: true };

/**
 * Resolves a worktree's `.git` gitfile to its git-directory location.
 * Extracted so the browser shim can reuse the exact same pointer-resolution
 * logic instead of re-implementing it. `gitfileSize` is the byte size the
 * caller's own `stat` of the gitfile reported — every caller has just stat'ed
 * the entry to learn it IS a file, so threading the size avoids a redundant
 * probe. `workDir` is used only to name the directory in a thrown
 * `NOT_A_REPOSITORY` — the caller decides how it participates in the
 * eventual layout. `commonDirOverride`, when given, is forwarded straight
 * through to the shared candidate check — see `layoutFor`.
 */
export const layoutFromGitfile = async (
  probe: LayoutProbe,
  workDir: string,
  gitfilePath: string,
  pathPolicy: PathPolicy,
  gitfileSize: number,
  commonDirOverride?: string,
): Promise<GitDirLocation> => {
  const gitDir = await resolvePointer(probe, gitfilePath, workDir, pathPolicy, gitfileSize);
  const located = await layoutFor(probe, gitDir, pathPolicy, commonDirOverride);
  if (located === undefined) throw notARepository(workDir as FilePath);
  return located;
};

/**
 * A `.git` gitfile, `commondir` file, or `HEAD` file larger than this is
 * rejected before parsing. Real pointer files are a path plus a short prefix
 * and a real `HEAD` is a refname or an object id (well under one kilobyte);
 * an oversized one in the walk path is hostile or corrupt, and capping here
 * keeps discovery from feeding megabytes into the parser.
 */
export const GITFILE_MAX_BYTES = 65536;

/**
 * Parses and resolves a gitfile's `gitdir:` pointer. The gitfile path was
 * already `stat`ed as a file by the caller (which is where `gitfileSize`
 * comes from), so `readUtf8` returning `undefined` here means
 * unreadable-or-vanished, not "absent". The probe contract collapses every
 * failure to `undefined`, so an EACCES is not distinguishable from a
 * race-removed file; both map to the gitfile-format refusal because the
 * invariant that matters is the hard stop — discovery must never walk up
 * past a `.git` file it could not use.
 *
 * Exported so `resolve-layout.ts`'s explicit-gitDir route can route a
 * gitDir argument that names a regular file through the same gitfile
 * grammar rather than re-implementing it.
 */
export const resolvePointer = async (
  probe: LayoutProbe,
  gitfilePath: string,
  baseDir: string,
  pathPolicy: PathPolicy,
  gitfileSize: number,
): Promise<string> => {
  if (gitfileSize > GITFILE_MAX_BYTES) throw gitfileInvalidFormat(gitfilePath);
  const raw = await probe.readUtf8(gitfilePath);
  if (raw === undefined) throw gitfileInvalidFormat(gitfilePath);
  const parsed = parseGitfilePointer(raw);
  if (parsed.kind === 'invalid-format') throw gitfileInvalidFormat(gitfilePath);
  if (parsed.kind === 'no-path') throw gitfileNoPath(gitfilePath);
  return pathPolicy.isAbsolute(parsed.path)
    ? pathPolicy.resolve(parsed.path)
    : pathPolicy.resolve(pathPolicy.join(baseDir, parsed.path));
};

/**
 * Git's `is_git_directory`, shared by every walk and gitfile route: `HEAD`
 * is validated first (a directory that is simply not a git directory returns
 * `undefined` and the walk climbs), then the common dir is resolved — an
 * unusable one past a valid `HEAD` is a HARD refusal on every route, exactly
 * as git dies there — then the shared dirs are checked.
 *
 * `commonDirOverride`, when given, REPLACES the file-derived common dir
 * outright rather than out-ranking it: the `<gitDir>/commondir` file is
 * never read at all — not parsed, not size-checked, not refused — because
 * the argument is standing in for the file, not a higher-priority value
 * layered on top of it. A malformed `commondir` file therefore cannot
 * refuse an open the caller has already re-pointed elsewhere. Whatever the
 * source, the resulting value is validated identically: an override lacking
 * `objects/` or `refs/` invalidates the candidate exactly as a bad
 * `commondir` file would.
 */
const layoutFor = async (
  probe: LayoutProbe,
  gitDir: string,
  pathPolicy: PathPolicy,
  commonDirOverride?: string,
): Promise<GitDirLocation | undefined> => {
  // HEAD first, on every walk/gitfile route — git's `is_git_directory` validates the head
  // before touching the common dir, so a garbage-`HEAD` directory (a planted
  // tree, or three innocuous entries) is climbed past without its `commondir`
  // ever being parsed. It doubles as the cheap gate: a level with no `HEAD`
  // file is rejected on that single `stat`, before any read.
  if (!(await hasValidHead(probe, gitDir, pathPolicy))) return undefined;
  // An unusable `commondir` past a valid `HEAD` is a HARD refusal, not a
  // skip: measured, git dies (`fatal: failed to read <dir>/commondir` /
  // `Invalid path`) and does NOT climb to an enclosing repository — on the
  // walk routes exactly as on the gitfile/explicit ones. Not `??`: the
  // override is never the empty string, so the explicit-undefined test and
  // `??` agree everywhere they can be exercised, but only the explicit form
  // says outright that a supplied value (however unlikely) is never treated
  // as "absent".
  const commonDir =
    commonDirOverride === undefined
      ? await resolveCommonDir(probe, gitDir, pathPolicy)
      : commonDirOverride;
  if (!(await sharedDirsValid(probe, commonDir, pathPolicy))) {
    // An unusable OVERRIDE past a valid `HEAD` refuses rather than climbs:
    // measured, git refuses (exit 128) and never reaches an enclosing
    // repository — the same override invalidates every level equally, so
    // climbing could only end at the shims' found-nothing fallback, which
    // would adopt this very gitDir un-overridden: a privilege-relevant
    // argument silently dropped. A failing FILE-derived common dir keeps
    // today's skip-and-climb.
    if (commonDirOverride !== undefined) throw notARepository(gitDir as FilePath);
    return undefined;
  }
  return finishLocation(gitDir, commonDir, pathPolicy);
};

/** Two paths naming the same directory, modulo the policy's own case/separator rules. */
const sameDir = (pathPolicy: PathPolicy, a: string, b: string): boolean =>
  pathPolicy.normalizeForCompare(a) === pathPolicy.normalizeForCompare(b);

/**
 * Assembles the located candidate's result. `commonDir` is omitted (not set
 * to `undefined` — `exactOptionalPropertyTypes` forbids the explicit-undefined
 * form) when it equals `gitDir`, keeping a normal repo's layout byte-identical
 * to today's; this also performs the degenerate-override normalisation for
 * free, since an override resolving equal to `gitDir` is omitted exactly like
 * a same-valued file-derived one.
 */
const finishLocation = (
  gitDir: string,
  commonDir: string,
  pathPolicy: PathPolicy,
): GitDirLocation => ({
  gitDir,
  ...(sameDir(pathPolicy, commonDir, gitDir) ? {} : { commonDir }),
});

/**
 * The batched counterpart to `layoutFor`, used ONLY for the walk's `.git`
 * DIRECTORY candidate (DC-3): every climbed level that has no `.git` entry,
 * and the cwd-is-gitdir check, stay on the fully serial `layoutFor` — this
 * function targets critical-path DEPTH on a cold filesystem, where the
 * candidate check's five reads would otherwise cost five network round trips
 * instead of one. It fires every probe the candidate could possibly need
 * BEFORE awaiting any of them, then evaluates them in exactly `layoutFor`'s
 * own order and reaches exactly its own answer — see `headValidFromProbes`,
 * `candidateCommonDir` and `candidateSharedDirsValid`, which share their
 * decision logic with the serial helpers below. A speculative read that the
 * decision never needs (say, `stat(HEAD)` when the link text alone already
 * qualifies the directory) is still issued, but its settlement — success OR
 * rejection — is never read, so a hostile or erroring probe there can never
 * surface through this call (`speculate`'s whole reason to exist).
 */
const layoutForDiscoveredGitDir = async (
  probe: LayoutProbe,
  gitDir: string,
  pathPolicy: PathPolicy,
  commonDirOverride?: string,
): Promise<GitDirLocation | undefined> => {
  const headPath = pathPolicy.join(gitDir, 'HEAD');
  const probes = startCandidateProbes(probe, gitDir, pathPolicy, headPath, commonDirOverride);
  if (!(await headValidFromProbes(probe, headPath, probes))) return undefined;
  const commonDir = await candidateCommonDir(probe, gitDir, pathPolicy, probes.commonDirSource);
  const valid = await candidateSharedDirsValid(
    probe,
    gitDir,
    commonDir,
    pathPolicy,
    probes.commonDirSource,
  );
  if (!valid) {
    if (probes.commonDirSource.kind === 'override') throw notARepository(gitDir as FilePath);
    return undefined;
  }
  return finishLocation(gitDir, commonDir, pathPolicy);
};

/**
 * Starts every candidate probe without awaiting any of them: the HEAD link
 * text, the followed HEAD stat, and — only when there is no caller-supplied
 * common dir to make them moot — the `commondir`/`objects`/`refs` stats
 * rooted at THIS `gitDir` (not yet the resolved common dir, which is not
 * known until the `commondir` read settles).
 */
const startCandidateProbes = (
  probe: LayoutProbe,
  gitDir: string,
  pathPolicy: PathPolicy,
  headPath: string,
  commonDirOverride: string | undefined,
): CandidateProbes => ({
  linkText: speculate(probe.readLink?.(headPath) ?? Promise.resolve(undefined)),
  head: speculate(probe.stat(headPath)),
  commonDirSource:
    commonDirOverride === undefined
      ? { kind: 'speculative', probes: startSharedDirProbes(probe, gitDir, pathPolicy) }
      : { kind: 'override', commonDir: commonDirOverride },
});

const startSharedDirProbes = (
  probe: LayoutProbe,
  gitDir: string,
  pathPolicy: PathPolicy,
): SharedDirProbes => ({
  commondir: speculate(probe.stat(pathPolicy.join(gitDir, 'commondir'))),
  objects: speculate(probe.stat(pathPolicy.join(gitDir, 'objects'))),
  refs: speculate(probe.stat(pathPolicy.join(gitDir, 'refs'))),
});

/**
 * `hasValidHead`'s decision logic, over the speculative results instead of
 * fresh reads: link text first (`decideByLinkText`); the content read still
 * runs only after the followed stat confirms a regular file (FIFO safety —
 * `readUtf8` is never spec'd, since a `HEAD` read is a commitment the
 * decision must make in order, not a probe worth firing blind).
 */
const headValidFromProbes = async (
  probe: LayoutProbe,
  headPath: string,
  probes: CandidateProbes,
): Promise<boolean> => {
  const byLinkText = decideByLinkText(await settleSpeculation(probes.linkText));
  if (byLinkText !== undefined) return byLinkText;
  const head = await settleSpeculation(probes.head);
  if (head?.isFile !== true) return false;
  const content = await probe.readUtf8(headPath);
  return content !== undefined && isValidHeadContent(content);
};

/**
 * The common dir for a batched candidate: the override wins outright (the
 * speculative `commondir` stat was never even started); otherwise the
 * already-settled speculative stat feeds `resolveCommonDirFrom` — no fresh
 * `stat` call.
 */
const candidateCommonDir = async (
  probe: LayoutProbe,
  gitDir: string,
  pathPolicy: PathPolicy,
  source: CommonDirSource,
): Promise<string> => {
  if (source.kind === 'override') return source.commonDir;
  const commondirStat = await settleSpeculation(source.probes.commondir);
  return resolveCommonDirFrom(probe, gitDir, pathPolicy, commondirStat);
};

/**
 * `sharedDirsValid`'s decision, reusing the speculative `objects`/`refs`
 * stats ONLY when the resolved common dir turns out to equal `gitDir` — the
 * shape the speculation actually targeted. A linked worktree's differing
 * common dir falls back to fresh reads under that dir, paying two stats the
 * speculation could not have avoided (it started before the common dir was
 * known).
 */
const candidateSharedDirsValid = async (
  probe: LayoutProbe,
  gitDir: string,
  commonDir: string,
  pathPolicy: PathPolicy,
  source: CommonDirSource,
): Promise<boolean> => {
  if (source.kind === 'override' || !sameDir(pathPolicy, commonDir, gitDir)) {
    return sharedDirsValid(probe, commonDir, pathPolicy);
  }
  if (!isSharedDirectory(await settleSpeculation(source.probes.objects))) return false;
  return isSharedDirectory(await settleSpeculation(source.probes.refs));
};

/**
 * Resolves `gitDir`'s `commondir` file. An absent file means `commonDir`
 * equals `gitDir` — this is what makes a submodule gitdir and a
 * `--separate-git-dir` gitdir valid without a commondir file of their own.
 */
export const resolveCommonDir = async (
  probe: LayoutProbe,
  gitDir: string,
  pathPolicy: PathPolicy,
): Promise<string> => {
  const commondirPath = pathPolicy.join(gitDir, 'commondir');
  const stat = await probe.stat(commondirPath);
  return resolveCommonDirFrom(probe, gitDir, pathPolicy, stat);
};

/**
 * `resolveCommonDir`'s decision over an ALREADY-FETCHED `commondir` stat —
 * shared by the serial route above (which just fetched it) and the batched
 * `.git`-directory candidate (`candidateCommonDir`), which fetched it
 * speculatively before `HEAD` was even validated.
 */
const resolveCommonDirFrom = async (
  probe: LayoutProbe,
  gitDir: string,
  pathPolicy: PathPolicy,
  stat: ProbeStat,
): Promise<string> => {
  const commondirPath = pathPolicy.join(gitDir, 'commondir');
  if (stat === undefined) return gitDir;
  // A non-regular `commondir` (a directory, or a FIFO/device on the node
  // probe) is treated as absent, never read: `readUtf8` on a FIFO would
  // block forever waiting for a writer, handing any planted special file a
  // denial of the whole discovery.
  if (stat.isFile !== true) return gitDir;
  if (stat.size > GITFILE_MAX_BYTES) throw gitfileInvalidFormat(commondirPath);
  const raw = await probe.readUtf8(commondirPath);
  if (raw === undefined) return gitDir;
  // Three measured shapes: a ZERO-BYTE file is git's hard fatal (`failed to
  // read <path>/commondir`); a newline-only file strips to empty and is
  // accepted as "this gitDir is its own common dir"; anything else is a path
  // verbatim (whitespace included — `"   \n"` names a directory called
  // `"   "`, which then simply fails the shared-dir validation).
  if (raw.length === 0) throw gitfileInvalidFormat(commondirPath);
  const value = parseCommondir(raw);
  if (value.kind === 'empty') return gitDir;
  if (pathPolicy.isAbsolute(value.path)) return pathPolicy.resolve(value.path);
  // git resolves a RELATIVE pointer component by component (its physical
  // realpath walk) and dies (`fatal: Invalid path`) on the first missing
  // INTERMEDIATE — only the FINAL component may be absent (the target then
  // simply fails the shared-dir validation and the candidate is a miss).
  // Stepwise resolution here mirrors that: a lexical pre-collapse would let
  // `missing/../../shared` skip straight past the missing component git
  // trips on. Relative pointers only: an absolute target may lie outside a
  // sandboxed adapter's containment root, where the probe's absence/denial
  // collapse would turn an unverifiable parent into a false refusal. A few
  // extra `stat`s, paid only by the rare directory carrying a relative
  // `commondir` at all.
  const segments = value.path.split('/').filter((segment) => segment.length > 0);
  let current = gitDir;
  for (const segment of segments.slice(0, -1)) {
    current = pathPolicy.resolve(pathPolicy.join(current, segment));
    const step = await probe.stat(current);
    if (step?.isDirectory !== true) throw gitfileInvalidFormat(commondirPath);
  }
  // Once every intermediate exists, the lexical resolve of the ORIGINAL
  // pointer equals the stepwise result (this tier has no symlinks to make
  // them diverge), and using it avoids a dead fallback for the impossible
  // empty-segments case (an all-slash relative pointer cannot exist — it
  // would be absolute).
  return pathPolicy.resolve(pathPolicy.join(gitDir, value.path));
};

/**
 * The `HEAD` half of git's `is_git_directory`: a symlink is judged by its
 * LINK TEXT first (adapters exposing `readLink`); otherwise `HEAD` must be a
 * regular file (via a following `stat`) and its content must
 * parse as either a hex object id or a `ref:` symbolic ref — the grammar
 * `isValidHeadContent` checks. This is what stops a planted directory
 * holding innocuous `HEAD`, `objects/`, `refs/` entries from shadowing an
 * enclosing repository: real git climbs past it, and so must this. The one
 * residual gap from real git: a `HEAD` symlink whose *link text* begins
 * `refs/` but whose target does not exist is accepted by git and rejected
 * here, because this probe only exposes a following `stat` plus `readUtf8`,
 * never the raw link text on adapters without `readLink`. A directory named
 * `HEAD` is not a head and fails the check.
 */
const hasValidHead = async (
  probe: LayoutProbe,
  gitDir: string,
  pathPolicy: PathPolicy,
): Promise<boolean> => {
  const headPath = pathPolicy.join(gitDir, 'HEAD');
  // Link text FIRST, like git's `validate_headref` (an lstat): a `HEAD`
  // symlink is judged by where it POINTS — `refs/…` qualifies even when the
  // target does not exist, anything else disqualifies even when it does.
  // Adapters without the capability (or a non-symlink `HEAD`, where
  // `readLink` collapses to undefined) fall through to the content check.
  const byLinkText = decideByLinkText(await probe.readLink?.(headPath));
  if (byLinkText !== undefined) return byLinkText;
  const head = await probe.stat(headPath);
  if (head?.isFile !== true) return false;
  // No size gate: git validates only the first 255 bytes of HEAD and never
  // consults its size, so an oversized-but-valid HEAD is still a git
  // directory (measured) — rejecting on size would climb PAST a repository
  // git resolves, the outward-escape class. Both grammar tests are anchored
  // prefix matches, so the parse cost is bounded regardless of file size,
  // and a regular file always terminates the read.
  const content = await probe.readUtf8(headPath);
  return content !== undefined && isValidHeadContent(content);
};

/**
 * `undefined` when the link text itself cannot decide (the capability is
 * absent, or `HEAD` is not a symlink) — the caller then escalates to the
 * followed stat. Shared by `hasValidHead` (serial) and `headValidFromProbes`
 * (batched) so both routes read the same grammar off the same link text.
 */
const decideByLinkText = (linkText: string | undefined): boolean | undefined =>
  linkText === undefined ? undefined : isRefsLinkText(linkText);

/** The shared-dir half of git's `is_git_directory`: `objects/` and `refs/` at the common dir. */
const sharedDirsValid = async (
  probe: LayoutProbe,
  commonDir: string,
  pathPolicy: PathPolicy,
): Promise<boolean> => {
  const objects = await probe.stat(pathPolicy.join(commonDir, 'objects'));
  if (!isSharedDirectory(objects)) return false;
  const refs = await probe.stat(pathPolicy.join(commonDir, 'refs'));
  return isSharedDirectory(refs);
};

/** Shared by the serial and batched shared-dir checks: a directory qualifies as `objects/`/`refs/`. */
const isSharedDirectory = (stat: ProbeStat): boolean => stat?.isDirectory === true;
