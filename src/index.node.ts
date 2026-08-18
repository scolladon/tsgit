/**
 * Node-runtime entry point. Selected by `package.json` `"exports"` for the
 * `node` condition. Builds the runtime fallback (Node-backed adapters +
 * cwd-walked layout) and forwards every `openRepository(opts)` call to the
 * core factory with the fallback pre-bound.
 */
import { readFile, realpath, stat } from 'node:fs/promises';
import * as nodePath from 'node:path';

import { NodeCommandRunner } from './adapters/node/node-command-runner.js';
import { NodeCompressor } from './adapters/node/node-compressor.js';
import { NodeEnvReader } from './adapters/node/node-env-reader.js';
import { NodeFileSystem } from './adapters/node/node-file-system.js';
import { NodeHashService } from './adapters/node/node-hash-service.js';
import { NodeHookRunner } from './adapters/node/node-hook-runner.js';
import { NodeHttpTransport } from './adapters/node/node-http-transport.js';
import { NodeSshTransport } from './adapters/node/node-ssh-transport.js';
import { nativePolicy } from './adapters/node/path-policy.js';
import { SHA1_CONFIG } from './domain/objects/hash-config.js';
import { createLruCache } from './domain/storage/lru-cache.js';
import type { LayoutProbe } from './ports/layout-probe.js';
import { layoutRootsOf } from './repository/layout-roots.js';
import { type ExplicitLayoutOptions, resolveLayout } from './repository/resolve-layout.js';
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
  const { layout, canonical: layoutCanonical } = await resolveNodeLayout(resolvedCwd, opts);
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
  const hash = new NodeHashService();
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
    hashConfig: SHA1_CONFIG,
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
 * Falls back to `{cwd}/.git` when discovery finds nothing up to the
 * filesystem root AND no explicit `gitDir` was supplied — the
 * `openRepository`/`init`/`clone` contract against a not-yet-existing
 * repository. That branch never realpaths its synthesised `gitDir`, so it
 * always reports `canonical: false`.
 *
 * The returned `canonical` flag is the AND of every realpath THIS function
 * performed.
 */
const resolveNodeLayout = async (
  cwd: string,
  opts: ExplicitLayoutOptions,
): Promise<{ layout: RepositoryLayoutInput; canonical: boolean }> => {
  const ceilingDirs = await canonicalizeCeilings(opts.ceilingDirs);
  const resolved = await resolveLayout(nodeLayoutProbe, cwd, nativePolicy, {
    ...(opts.gitDir !== undefined ? { gitDir: opts.gitDir } : {}),
    ...(opts.workDir !== undefined ? { workDir: opts.workDir } : {}),
    ...(opts.bare !== undefined ? { bare: opts.bare } : {}),
    ...(ceilingDirs !== undefined ? { ceilingDirs } : {}),
  });
  if (resolved === undefined) {
    return {
      layout: { workDir: cwd, gitDir: nodePath.join(cwd, '.git'), bare: false },
      canonical: false,
    };
  }
  const gitDir = await canonicalize(resolved.gitDir);
  const commonDir =
    resolved.commonDir === undefined ? undefined : await canonicalize(resolved.commonDir);
  const workDir = resolved.workDir === undefined ? undefined : await canonicalize(resolved.workDir);
  const canonical =
    gitDir.canonical && (commonDir?.canonical ?? true) && (workDir?.canonical ?? true);
  return {
    layout: {
      ...resolved,
      gitDir: gitDir.path,
      ...(commonDir !== undefined ? { commonDir: commonDir.path } : {}),
      ...(workDir !== undefined ? { workDir: workDir.path } : {}),
    },
    canonical,
  };
};

export type { AdapterSet } from './adapter-detect.js';
export { detectRuntime, isBrowser, isNode } from './adapter-detect.js';
export { consoleProgress, noopProgress, type ProgressReporter } from './progress.js';
export * from './public-types.js';
export type { OpenRepositoryOptions, Repository } from './repository.js';
