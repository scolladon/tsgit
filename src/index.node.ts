/**
 * Node-runtime entry point. Selected by `package.json` `"exports"` for the
 * `node` condition. Builds the runtime fallback (Node-backed adapters +
 * cwd-walked layout) and forwards every `openRepository(opts)` call to the
 * core factory with the fallback pre-bound.
 */
import { readFile, readlink, realpath, stat } from 'node:fs/promises';
import * as nodePath from 'node:path';

import { NodeCommandRunner } from './adapters/node/node-command-runner.js';
import { NodeCompressor } from './adapters/node/node-compressor.js';
import { NodeEnvReader } from './adapters/node/node-env-reader.js';
import { NodeFileSystem } from './adapters/node/node-file-system.js';
import { NodeHashService } from './adapters/node/node-hash-service.js';
import { NodeHookRunner } from './adapters/node/node-hook-runner.js';
import { NodeHttpTransport } from './adapters/node/node-http-transport.js';
import { NodeSshTransport } from './adapters/node/node-ssh-transport.js';
import { ownedByCallerPredicate } from './adapters/node/owner-predicate.js';
import { nativePolicy } from './adapters/node/path-policy.js';
import { configFor } from './domain/objects/hash-config.js';
import { createLruCache } from './domain/storage/lru-cache.js';
import type { LayoutProbe } from './ports/layout-probe.js';
import { canonicalizeTrustedDirectories } from './repository/canonicalize-trusted-directories.js';
import { layoutRootsOf } from './repository/layout-roots.js';
import {
  type ExplicitLayoutOptions,
  resolveLayout,
  syntheticFallbackLayout,
} from './repository/resolve-layout.js';
import { validateOptions } from './repository/validate-options.js';
import {
  type OpenRepositoryOptions,
  openRepository as openRepositoryCore,
  type Repository,
  type RepositoryLayoutInput,
} from './repository.js';

const DEFAULT_DELTA_CACHE_BYTES = 16 * 1024 * 1024;
const DEFAULT_DELTA_CACHE_ENTRIES = 65_536;

/**
 * Node-runtime extension to `OpenRepositoryOptions`. Adds `allowInsecureHttp`
 * (forwarded to the Node HTTP transport — separate from the facade-tier
 * `config.allowInsecure` which controls the SSRF guard). Adds delta-cache
 * tuning for callers with non-standard memory budgets.
 */
export interface OpenNodeRepositoryOptions extends OpenRepositoryOptions {
  readonly allowInsecureHttp?: boolean;
  readonly deltaCacheMaxBytes?: number;
  readonly deltaCacheMaxEntries?: number;
}

export const openRepository = async (opts: OpenNodeRepositoryOptions = {}): Promise<Repository> => {
  // Stryker disable next-line CallExpression: equivalent — `openRepositoryCore` (below, forwarding the SAME unmodified `opts` fields, `cwd` aside) runs `validateOptions` again at `repository.ts`; removing this eager call cannot change any thrown error, only where it is thrown from — confirmed empirically (an invalid `gitDir` still throws the identical `INVALID_OPTION` shape via the core's re-check).
  validateOptions(opts);
  const cwd = opts.cwd ?? process.cwd();
  // Resolve to the real path (follows symlinks). On macOS, /var/folders/...
  // symlinks to /private/var/folders/..., and the NodeFileSystem's containment
  // check compares against the realpath of paths it operates on. Without
  // resolving here, every operation under a symlinked cwd would be rejected
  // with PERMISSION_DENIED. `canonicalize` falls back to the un-resolved path
  // when realpath fails (init/clone callers legitimately point at a
  // not-yet-existing directory), and reports that outcome via `canonical`.
  const { path: resolvedCwd, canonical: cwdCanonical } = await canonicalize(nodePath.resolve(cwd));
  // Discover layout BEFORE constructing the bounded NodeFileSystem. Layout
  // discovery walks up the parent chain looking for `.git` (a directory OR a
  // gitfile pointer — linked worktree, submodule, `--separate-git-dir`); the
  // bounded FS would reject paths outside its rootDir, preventing the walk
  // from reaching a repo whose root is an ancestor of the user's cwd.
  const { layout, canonical: layoutCanonical } = await resolveNodeLayout(
    resolvedCwd,
    opts,
    cwdCanonical,
  );
  // The layout's roots are trustworthy as pre-resolved ONLY when every
  // realpath performed above — cwd's own AND the layout's own — actually
  // succeeded; a fallback that silently kept an un-resolved path must never
  // be handed down as though it were already canonical.
  const canonical = cwdCanonical && layoutCanonical;
  const roots = layoutRootsOf(layout);
  // The raw adapter is confined to exactly the (containment-minimised) layout
  // roots — wide enough to reach a linked worktree's workDir AND its common
  // dir in one instance, and no wider. A common-ancestor root would admit
  // everything between the roots (and, for a cross-top-level layout, the whole
  // filesystem), and this adapter's realpath containment is the ONLY
  // symlink-aware gate — the facade's multi-root validator above it is purely
  // lexical, so a symlink planted inside a root would read and write through
  // it into the ancestor. Telling the adapter these roots are already resolved
  // (when `canonical`) lets it skip re-realpathing them on its own first call —
  // the containment check itself is unchanged either way, and the flag can only
  // ever skip recomputing the SAME prefixes, never substitute different ones.
  // `undefined` for the 3rd (`fsOps`) argument takes the constructor's own
  // `realFsOps` default; this module never imports it directly.
  const fs = new NodeFileSystem(roots, nativePolicy, undefined, canonical);
  const algorithm = opts.algorithm ?? 'sha1';
  const hash = new NodeHashService(algorithm);
  const compressor = new NodeCompressor();
  const transport = new NodeHttpTransport({
    allowInsecureHttp: opts.allowInsecureHttp ?? false,
  });
  const fallback = {
    fs,
    hash,
    compressor,
    transport,
    hooks: new NodeHookRunner(),
    command: new NodeCommandRunner(),
    env: new NodeEnvReader(),
    ssh: new NodeSshTransport(),
    runtime: 'node' as const,
    layout,
    hashConfig: configFor(algorithm),
    deltaCache: createLruCache<Uint8Array>(
      opts.deltaCacheMaxBytes ?? DEFAULT_DELTA_CACHE_BYTES,
      opts.deltaCacheMaxEntries ?? DEFAULT_DELTA_CACHE_ENTRIES,
    ),
    // A linked worktree lives outside `workDir`; root a fresh adapter at the
    // repo's own workDir PLUS every path the caller asked for (the facade
    // passes the worktree paths followed by the layout roots), so it reaches
    // exactly those subtrees and nothing between them. `workDir` leads so it
    // stays the base for resolving a relative path, as in the main adapter.
    // `worktreePaths` are caller-supplied and never realpathed here, so this
    // instance always resolves its own roots — no pre-resolved hand-off.
    makeWorktreeFs: (worktreePaths: ReadonlyArray<string>): NodeFileSystem =>
      new NodeFileSystem(
        // Stryker disable next-line ArrayDeclaration: equivalent — `worktreePaths` ALREADY carries the layout roots (workDir included), prepended by the facade's own `worktreeFs` wrapper (`repository.ts`, "the worktree paths followed by the layout roots") before this function ever runs; dropping/replacing this array's own `workDir` contribution cannot narrow or widen the resulting containment set — confirmed empirically (a bare-repo probe still resolves correctly with either branch mutated).
        [...(layout.workDir !== undefined ? [layout.workDir] : []), ...worktreePaths],
        nativePolicy,
      ),
  };
  // Strip the node-only opts AND `cwd` (we override with the realpath-resolved
  // form) before forwarding so the core sees only its own option surface.
  const {
    cwd: _cwd,
    allowInsecureHttp: _a,
    deltaCacheMaxBytes: _b,
    deltaCacheMaxEntries: _c,
    ...coreOpts
  } = opts;
  return openRepositoryCore({ ...coreOpts, cwd: resolvedCwd }, fallback);
};

/**
 * Raw `node:fs/promises`-backed `LayoutProbe`. Must stay raw (never routed
 * through a bounded `NodeFileSystem`): the discovery walk climbs above `cwd`
 * looking for `.git`, and a bounded adapter would reject every step outside
 * its own rootDir — this has to run BEFORE that adapter is constructed.
 */
const nodeLayoutProbe: LayoutProbe = {
  stat: async (p) => {
    const s = await stat(p).catch(() => undefined);
    return s === undefined
      ? undefined
      : { isDirectory: s.isDirectory(), isFile: s.isFile(), size: s.size };
  },
  readUtf8: (p) => readFile(p, 'utf8').catch(() => undefined),
  // EINVAL (not a symlink) and ENOENT both collapse to undefined per the
  // port contract — the caller only cares whether usable link text exists.
  readLink: (p) => readlink(p, 'utf8').catch(() => undefined),
  isOwnedByCaller: ownedByCallerPredicate({
    // Effective uid, matching the port contract and git's own `geteuid()`.
    callerUid: () => process.geteuid?.() ?? process.getuid?.(),
    ownerUid: async (p) => (await stat(p).catch(() => undefined))?.uid,
  }),
};

/**
 * Realpath `p`, paired with whether that realpath actually succeeded. A
 * not-yet-existing path (the `openRepository`/`init`/`clone` contract) falls
 * back to `p` itself with `canonical: false` — callers must never treat that
 * fallback as an already-resolved root; only a `true` outcome makes `path`
 * safe to hand the adapter as pre-resolved.
 */
const canonicalize = async (p: string): Promise<{ path: string; canonical: boolean }> => {
  try {
    return { path: await realpath(p), canonical: true };
  } catch {
    return { path: p, canonical: false };
  }
};

/**
 * Realpaths every entry of `ceilingDirs`, best-effort — a ceiling that does
 * not (yet) exist falls back to its resolved-but-unresolved form via
 * `canonicalize`'s own fallback, exactly like a not-yet-existing `gitDir`.
 * `undefined` in, `undefined` out, so a caller that omitted the option never
 * pays for the mapping.
 */
const canonicalizeCeilings = async (
  ceilingDirs: ReadonlyArray<string> | undefined,
): Promise<ReadonlyArray<string> | undefined> => {
  if (ceilingDirs === undefined) return undefined;
  const resolved = await Promise.all(ceilingDirs.map((dir) => canonicalize(dir)));
  return resolved.map((entry) => entry.path);
};

/**
 * Realpaths every entry of `trustedDirectories`, best-effort — the same
 * `canonicalize` fallback `canonicalizeCeilings` uses, so an entry with a
 * missing intermediate component correctly fails to match rather than
 * silently matching a lexical prefix. The literal `'*'` is skipped
 * entirely: it must never be realpathed into `<cwd>/*`, which would turn
 * "trust everything" into "trust nothing".
 */

/**
 * Resolve the physical layout for `cwd`: `opts.gitDir`, when given, skips
 * discovery entirely (Stage 1's explicit route); otherwise walk up looking
 * for a `.git` entry or a cwd-is-gitdir match, bounded by `opts.ceilingDirs`
 * (realpathed here so the walk's loop-head comparison stays physical, the
 * same reason `cwd` itself is realpathed above). Either way, apply the
 * config-driven work-tree resolution, then realpath the resolved
 * `gitDir`/`commonDir`/`workDir` — the node adapter confines by realpath, so
 * an unresolved admin or work-tree path would spuriously reject on a
 * symlinked repo root (e.g. macOS's `/var` -> `/private/var`) or a
 * symlinked `core.worktree` target (git resolves `core.worktree`
 * physically; a lexical value here would silently diverge).
 *
 * Physically resolves a relative `core.worktree` join the way git's `chdir`
 * does: symlinks followed, and the target must be a DIRECTORY — git cannot
 * change directory into a regular file, so a file target is the same setup
 * refusal as a missing one (measured: `fatal: cannot chdir to …`).
 */
const nodeLayoutCapabilities = {
  realWorkTreePath: async (p: string): Promise<string | undefined> => {
    try {
      const real = await realpath(p);
      return (await stat(real)).isDirectory() ? real : undefined;
    } catch {
      return undefined;
    }
  },
};

/**
 * Falls back to a synthetic bootstrap layout at `{cwd}/.git` when discovery
 * finds nothing up to the filesystem root AND no explicit `gitDir` was
 * supplied — the `openRepository`/`init`/`clone` contract against a
 * not-yet-existing repository. The fallback honours `opts.bare` /
 * `opts.workDir` (argument tier) but reads NOTHING from disk: discovery
 * already judged there is no repository here, and git never consults the
 * config of a `.git` it rejected. That branch never realpaths its
 * synthesised paths, so it always reports `canonical: false`.
 *
 * The returned `canonical` flag is the AND of every realpath THIS function
 * performed. A `workDir` that came out of discovery is an ancestor of (or
 * equal to) the already-realpathed `cwd`, and an ancestor of a realpath is
 * itself real — so those shapes skip the extra realpath entirely; only the
 * genuinely lexical sources (`core.worktree`, an explicit `opts.workDir`)
 * pay one.
 */
/**
 * Assembles the `ExplicitLayoutOptions` object `resolveLayout` receives,
 * folding in each optional field only when the caller actually set it —
 * `exactOptionalPropertyTypes` forbids the explicit-undefined form. Extracted
 * from `resolveNodeLayout` to keep that function's own branching count low.
 */
const buildLayoutOptions = (
  opts: ExplicitLayoutOptions,
  explicit: Pick<ExplicitLayoutOptions, 'workDir' | 'bare'>,
  ceilingDirs: ReadonlyArray<string> | undefined,
  trustedDirectories: ReadonlyArray<string> | undefined,
): ExplicitLayoutOptions => ({
  ...(opts.gitDir !== undefined ? { gitDir: opts.gitDir } : {}),
  // Stryker disable next-line ConditionalExpression: equivalent — this result feeds `resolveLayout` directly, whose sole reader is `opts.commonDir === undefined` (resolve-layout.ts); a spread `{ commonDir: undefined }` is indistinguishable from an omitted key there.
  ...(opts.commonDir !== undefined ? { commonDir: opts.commonDir } : {}),
  ...explicit,
  ...(ceilingDirs !== undefined ? { ceilingDirs } : {}),
  ...(opts.trust !== undefined ? { trust: opts.trust } : {}),
  ...(trustedDirectories !== undefined ? { trustedDirectories } : {}),
  ...(opts.bareRepositories !== undefined ? { bareRepositories: opts.bareRepositories } : {}),
});

const resolveNodeLayout = async (
  cwd: string,
  opts: ExplicitLayoutOptions,
  cwdCanonical: boolean,
): Promise<{ layout: RepositoryLayoutInput; canonical: boolean }> => {
  const ceilingDirs = await canonicalizeCeilings(opts.ceilingDirs);
  const trustedDirectories = await canonicalizeTrustedDirectories(
    opts.trustedDirectories,
    async (path) => (await canonicalize(path)).path,
  );
  const explicit = {
    ...(opts.workDir !== undefined ? { workDir: opts.workDir } : {}),
    ...(opts.bare !== undefined ? { bare: opts.bare } : {}),
  };
  const resolved = await resolveLayout(
    nodeLayoutProbe,
    cwd,
    nativePolicy,
    buildLayoutOptions(opts, explicit, ceilingDirs, trustedDirectories),
    nodeLayoutCapabilities,
  );
  if (resolved === undefined) {
    const gitDir = nodePath.join(cwd, '.git');
    return {
      layout: syntheticFallbackLayout(gitDir, cwd, cwd, explicit, nativePolicy),
      canonical: false,
    };
  }
  const gitDir = await canonicalize(resolved.gitDir);
  const commonDirCanonical =
    resolved.commonDir === undefined ? undefined : await canonicalize(resolved.commonDir);
  // Realpathing can collapse a lexically-distinct common dir onto the gitDir
  // (`/tmp` vs `/private/tmp`, case-insensitive filesystems): re-apply the
  // presence-iff-different invariant AFTER canonicalisation, or two spellings
  // of the same directory would leave the field present-and-equal.
  const commonDir =
    commonDirCanonical !== undefined &&
    nativePolicy.normalizeForCompare(commonDirCanonical.path) !==
      nativePolicy.normalizeForCompare(gitDir.path)
      ? commonDirCanonical
      : undefined;
  const workDir =
    resolved.workDir === undefined
      ? undefined
      : cwdCanonical && isDerivedFromCanonicalCwd(resolved.workDir, cwd)
        ? { path: resolved.workDir, canonical: true }
        : await canonicalize(resolved.workDir);
  const canonical =
    gitDir.canonical && (commonDir?.canonical ?? true) && (workDir?.canonical ?? true);
  const { commonDir: _lexicalCommonDir, ...resolvedSansCommonDir } = resolved;
  return {
    layout: {
      ...resolvedSansCommonDir,
      gitDir: gitDir.path,
      ...(commonDir !== undefined ? { commonDir: commonDir.path } : {}),
      ...(workDir !== undefined ? { workDir: workDir.path } : {}),
    },
    canonical,
  };
};

/**
 * True when `workDir` fell out of discovery against `cwd` — equal to it, or
 * a strict ancestor of it. Combined with the caller's proof that `cwd`'s own
 * realpath SUCCEEDED, this is a zero-syscall proof of canonical form: an
 * ancestor of a realpath is itself real, so re-realpathing such a `workDir`
 * can never change it. Without that proof (a lexical cwd fallback) the
 * ancestor may still traverse a symlink and must be realpathed normally.
 */
const isDerivedFromCanonicalCwd = (workDir: string, cwd: string): boolean =>
  workDir === cwd || cwd.startsWith(`${workDir}${nativePolicy.sep}`);

export type { AdapterSet } from './adapter-detect.js';
export { detectRuntime, isBrowser, isNode } from './adapter-detect.js';
export { TsgitError, type TsgitErrorData } from './domain/error.js';
export { consoleProgress, noopProgress, type ProgressReporter } from './progress.js';
export * from './public-types.js';
export type { OpenRepositoryOptions, Repository } from './repository.js';
