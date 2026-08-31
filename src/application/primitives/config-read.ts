import { configBadNumericValue } from '../../domain/commands/error.js';
import type { ConfigToken, IniSection } from '../../domain/config/config-ini.js';
import {
  GIT_C_INT_MAX,
  GIT_C_INT_MIN,
  GIT_UINT64_MAX,
  parseGitBoolean,
  parseGitInt,
  parseIniSectionsFromTokens,
  tokenizeConfig,
} from '../../domain/config/config-ini.js';
import { TsgitError } from '../../domain/error.js';
import type { FilePath } from '../../domain/objects/object-id.js';
import type { Context } from '../../ports/context.js';
import { invalidateScopedConfigCache } from './config-scoped-read.js';
import { layoutFailsTrustGate } from './internal/layout-verdict.js';
import { commonGitDir } from './path-layout.js';

// Re-exported verbatim: these symbols physically live in
// `src/domain/config/config-ini.ts` now (the pure tokenizer/parser layer,
// split out to break an import cycle — see that file's header comment), but
// every external consumer still imports them from here, so every symbol an
// existing caller depends on stays reachable from this module.
// `HeaderPrefixScan`/`SectionHeaderParse` are NOT in this list — no caller
// inside or outside this package imports them by name (`scanHeaderPrefix`'s
// callers consume the returned shape structurally), so they stay internal to
// `config-ini.ts`.
export type { ConfigToken, IniSection } from '../../domain/config/config-ini.js';
export {
  parseIniSections,
  scanHeaderPrefix,
  skipGitSpace,
  tokenizeConfigLines,
} from '../../domain/config/config-ini.js';
export { parseGitBoolean, parseGitInt, tokenizeConfig };

/** `push.default` mode; `tracking` is a deprecated alias canonicalized to `upstream` at parse time. */
export type PushDefaultMode = 'nothing' | 'current' | 'upstream' | 'simple' | 'matching';

/**
 * Subset of `.git/config` that v1 commands consume. Only fields actually used by
 * commands are typed — the parser ignores everything else (lenient, like git itself).
 */
export interface ParsedConfig {
  readonly core?: {
    readonly bare?: boolean;
    readonly excludesFile?: string;
    readonly attributesFile?: string;
    readonly logAllRefUpdates?: boolean | 'always';
    readonly hooksPath?: string;
    /** `core.notesRef` — default notes ref when neither explicit arg nor `GIT_NOTES_REF` is set. */
    readonly notesRef?: string;
    readonly sparseCheckout?: boolean;
    readonly sparseCheckoutCone?: boolean;
    readonly looseCompression?: number;
    /** `core.maxTreeDepth` — max tree-recursion depth; git defaults to 2048 when unset. */
    readonly maxTreeDepth?: number;
    /** `core.sshCommand` — shell string resolved by `resolveSshCommand` ahead of `GIT_SSH`. */
    readonly sshCommand?: string;
  };
  readonly user?: { readonly name?: string; readonly email?: string; readonly signingKey?: string };
  readonly remote?: ReadonlyMap<
    string,
    {
      readonly url?: string;
      /** `remote.<name>.pushurl` — push-only URL; `push` reads `pushUrl ?? url`. */
      readonly pushUrl?: string;
      readonly fetch?: ReadonlyArray<string>;
      /** `remote.<name>.promisor` — true when this is a partial-clone promisor remote. */
      readonly promisor?: boolean;
      /** `remote.<name>.partialclonefilter` — the canonical filter spec applied at clone. */
      readonly partialCloneFilter?: string;
    }
  >;
  /** `remote.pushDefault` — subsectionless `[remote]` only; per-remote `[remote "x"] pushDefault` is not read. */
  readonly remotePushDefault?: string;
  readonly branch?: ReadonlyMap<
    string,
    {
      readonly remote?: string;
      readonly merge?: string;
      /** `branch.<name>.pushRemote` — overrides the push-remote for this branch. */
      readonly pushRemote?: string;
    }
  >;
  /** `[submodule "<name>"]` — the registered (initialised) submodules. */
  readonly submodule?: ReadonlyMap<
    string,
    { readonly url?: string; readonly active?: boolean; readonly update?: string }
  >;
  /** `[merge "<driver>"]` — configured custom merge drivers. */
  readonly merge?: ReadonlyMap<
    string,
    { readonly name?: string; readonly driver?: string; readonly recursive?: string }
  >;
  /** `[diff "<name>"]` configured diff/textconv drivers. */
  readonly diff?: ReadonlyMap<
    string,
    { readonly textconv?: string; readonly cachetextconv?: boolean }
  >;
  /** `[filter "<name>"]` configured clean/smudge filter drivers. */
  readonly filter?: ReadonlyMap<
    string,
    {
      readonly clean?: string;
      readonly smudge?: string;
      readonly process?: string;
      readonly required?: boolean;
    }
  >;
  /** `[extensions]` — `partialClone` names the promisor remote of a partial clone. */
  readonly extensions?: { readonly partialClone?: string };
  /** `commit.gpgSign` — sign commits by default when true. */
  readonly commit?: { readonly gpgSign?: boolean };
  /** `tag.gpgSign` — sign annotated tags by default when true. */
  readonly tag?: { readonly gpgSign?: boolean };
  /**
   * `[pack]` — pack-writing behaviour. `writeReverseIndex` writes a sibling
   * `.rev` beside each pack index (git default `true`). `window` bounds how
   * many recent objects the delta selector considers as bases (git default
   * `10`). `depth` bounds the longest delta chain the writer builds (git
   * default `50`). `windowMemory` bounds the window's total resident size in
   * bytes; unset or `0` means unlimited (git default).
   */
  readonly pack?: {
    readonly writeReverseIndex?: boolean;
    readonly window?: number;
    readonly depth?: number;
    readonly windowMemory?: number;
  };
  /**
   * `[gc]` — maintenance's `gc` task settings. `auto` (git default `6700`) is
   * consulted only under `auto: true`; `pruneExpire` (git default
   * `2.weeks.ago`) is the raw config string, resolved by `expiryCutoff`;
   * `cruftPacks` (git default `true`) routes surviving unreachable objects
   * to a cruft pack rather than loose files.
   */
  readonly gc?: {
    readonly auto?: number;
    readonly pruneExpire?: string;
    readonly cruftPacks?: boolean;
  };
  readonly push?: {
    /** `push.gpgSign` — sign push certificates: `true`/`false`, or `if-asked` (server-requested). */
    readonly gpgSign?: 'true' | 'false' | 'if-asked';
    /** `push.default` — canonicalized push remote-selection mode (`tracking` maps to `upstream`). */
    readonly default?: PushDefaultMode;
  };
  /** `[gpg]` — signing backend selection and the external program(s) invoked to sign/verify. */
  readonly gpg?: {
    readonly format?: 'openpgp' | 'ssh' | 'x509';
    readonly program?: string;
    /** `gpg.ssh.program` — the `ssh-keygen`-compatible binary used for `gpg.format = ssh`. */
    readonly ssh?: { readonly program?: string };
  };
}

/**
 * One read of `readConfig`, cached per session: the LOCAL `${commonGitDir}/config`
 * parse (`parsed`), its token stream (`tokens`), and the absolute path those
 * tokens were read from (`source`) — every field describes the SAME single
 * file. NOT a multi-scope merge: see `loadConfigEntry`'s own docstring for
 * why local-only is deliberate.
 *
 * The seven `findFirstInvalid*`/`findLastInvalid*` finders further down walk
 * `tokens` to locate a malformed entry and report `source` as its file — the
 * eager config gate (`assertEagerConfigValid`/`assertDiscoveryBooleansValid`)
 * refuses on a malformed LOCAL config only, exactly as it always has. A
 * missing file is normal (empty), not an error.
 */
interface ConfigCacheEntry {
  readonly parsed: ParsedConfig;
  readonly tokens: ReadonlyArray<ConfigToken>;
  readonly source: string;
}

interface CachedConfigEntry {
  readonly promise: Promise<ConfigCacheEntry>;
  readonly mtimeKey: string;
}

/** Sentinel `mtimeKey` for "the config file does not exist" — distinct from
 *  any real `mtimeMs:size` pair, so a file that is CREATED between two calls
 *  is never mistaken for the absent state it replaces. */
// Stryker disable next-line StringLiteral: equivalent — a real mtimeKey is always `${mtimeMs}:${size}` (digits and a colon); '' can never collide with that shape any less than 'absent' does, so the literal sentinel text carries no observable behavior.
const CONFIG_ABSENT_MTIME_KEY = 'absent';

/**
 * `${mtimeMs}:${size}` for `path`, or {@link CONFIG_ABSENT_MTIME_KEY} when it
 * does not exist — mirrors `ref-store.ts`'s `loadPackedRefs` and
 * `load-reftable-stack.ts`'s own mtime-keyed invalidation. Keying the cache
 * on session alone (below) shares it across every Context derived from the
 * same repository-open, INCLUDING a plain `{ ...ctx, x }` spread that never
 * goes through `deriveContext` — so a raw `ctx.fs.writeUtf8` past the config
 * writers' `invalidateConfigCache` call (the pattern most tests use to seed
 * config) must still be observed on the next read. A stat-based check is
 * what makes that safe without giving up the cross-derivation sharing this
 * cache exists for.
 */
async function configMtimeKey(ctx: Context, path: string): Promise<string> {
  try {
    const stat = await ctx.fs.stat(path);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch (err) {
    if (err instanceof TsgitError && err.data.code === 'FILE_NOT_FOUND') {
      return CONFIG_ABSENT_MTIME_KEY;
    }
    throw err;
  }
}

/**
 * At most one IN-FLIGHT `configMtimeKey` stat per session: every
 * `readConfigEntry` call that starts before the previous one's stat has
 * settled joins that SAME pending answer, so the up to eight concurrent
 * finders `assertEagerConfigValid`/`assertDiscoveryBooleansValid` fan out
 * via one `Promise.all` share one stat between them rather than paying one
 * each — the measured 8-way-concurrent-stat cost this coalescing closes.
 *
 * Cleared the INSTANT the stat settles, never held past it: a later,
 * genuinely separate `readConfigEntry` call (a different command, or the
 * same session's next gate stage, both of which run after the previous
 * stat's promise has already resolved) still pays its own fresh stat. That
 * is what keeps the "external `ctx.fs.writeUtf8` past `invalidateConfigCache`
 * is observed on the next read" contract intact — this coalesces duplicate
 * concurrent work, it does not skip staleness detection.
 */
let inflightMtimeKey: WeakMap<Context['session'], Promise<string>> = new WeakMap();

function coalescedMtimeKey(ctx: Context, path: string): Promise<string> {
  const existing = inflightMtimeKey.get(ctx.session);
  if (existing !== undefined) return existing;
  const pending = configMtimeKey(ctx, path);
  inflightMtimeKey.set(ctx.session, pending);
  // `.finally()` returns its OWN promise, which rejects independently of
  // `pending` when `pending` rejects — the caller below observes and
  // handles `pending`'s own rejection via the returned value, but this
  // derived one is otherwise never awaited or caught, so it would surface
  // as a SECOND, unhandled rejection for the exact same fault. The no-op
  // `.catch()` marks only this derived promise as handled; it changes
  // nothing about what the caller sees.
  pending
    .finally(() => {
      if (inflightMtimeKey.get(ctx.session) === pending) inflightMtimeKey.delete(ctx.session);
    })
    .catch(() => {});
  return pending;
}

// Keyed on `ctx.session` — not `ctx` itself — so every Context derived from
// the same repository-open shares one parse instead of missing on every
// spread-derivation. Cache reference is mutable so test code can swap in a
// fresh WeakMap and guarantee isolation between cases that re-use the same
// session (the WeakMap itself can't be iterated, so a true reset requires
// replacement).
let cache: WeakMap<Context['session'], CachedConfigEntry> = new WeakMap();

/**
 * The operational gate-verdict memo `internal/repo-state.ts` populates via
 * `memoizeGateVerdict`, below — owned HERE rather than there so
 * `invalidateConfigCache` can drop it without `repo-state.ts` importing this
 * module's own invalidator: `repo-state.ts` already imports the finders
 * above, and the reverse import would cycle. The verdict shape (`FilePath`)
 * is the only thing this module knows about it; `compute` — supplied by the
 * caller — is what actually builds one.
 *
 * Keyed on `ctx.session` — not `ctx` itself — for the same reason as `cache`
 * above, and for a correctness reason specific to this memo: the verdict is
 * DERIVED FROM the parse `cache`'s content (`computeGateVerdict` calls
 * `assertEagerConfigValid`, which reads the cached tokens), so the two must
 * share exactly one invalidation domain. Keying this memo on `ctx` while
 * `cache` keys on `ctx.session` would let a config write observed through a
 * DERIVED Context (same session, different object) refresh the shared parse
 * cache while leaving the ORIGINAL Context's verdict entry stale — a
 * mid-session config edit that should flip the gate to refuse would instead
 * keep passing through the original Context, since `invalidateConfigCache`
 * only ever drops the caller's own key.
 */
let gateVerdictCache: WeakMap<Context['session'], Promise<FilePath>> = new WeakMap();

/**
 * Get-or-populate the per-session gate-verdict memo: a second call sharing
 * the same, unchanged session joins the promise the first call started
 * rather than re-running `compute`. `invalidateConfigCache` (below) drops
 * this memo alongside its own, so a config write observed through that
 * invalidator — from ANY Context sharing the session, not just the one that
 * first populated the memo — is observed here too.
 *
 * A REJECTED verdict is never left cached: `compute` can fail on a transient
 * condition (EACCES/EIO/EMFILE reading the config file) that has nothing to
 * do with the repository's actual state, and caching that failure would
 * permanently poison the session until `invalidateConfigCache` happens to
 * run — every later command would refuse for a fault that already cleared.
 * The eviction only removes the entry when it is STILL the one this call
 * populated: a later, successful `compute` may already have replaced it
 * (e.g., a concurrent call after `invalidateConfigCache`), and this handler
 * must not evict that fresh entry out from under it.
 */
export const memoizeGateVerdict = (
  ctx: Context,
  compute: (ctx: Context) => Promise<FilePath>,
): Promise<FilePath> => {
  const existing = gateVerdictCache.get(ctx.session);
  if (existing !== undefined) return existing;
  const pending = compute(ctx);
  gateVerdictCache.set(ctx.session, pending);
  pending.catch(() => {
    if (gateVerdictCache.get(ctx.session) === pending) gateVerdictCache.delete(ctx.session);
  });
  return pending;
};

/**
 * Read and cache the LOCAL config (see `loadConfigEntry`'s own docstring for
 * why merging system/global/worktree scopes here was tried and reverted —
 * this reads `${commonGitDir}/config` alone).
 *
 * The cache is keyed on `ctx.session`, with mtime+size staleness detection
 * on top (see `configMtimeKey`/`coalescedMtimeKey`) — a fresh session gets a
 * fresh read; a write observed through any Context sharing the session
 * invalidates it for every other. Concurrent calls share the same in-flight
 * promise (single-flight per session).
 */
export const readConfig = (ctx: Context): Promise<ParsedConfig> =>
  readConfigEntry(ctx).then((entry) => entry.parsed);

/**
 * The cache accessor: returns the per-session `ConfigCacheEntry` promise,
 * single-flight (concurrent calls share the same in-flight read). Both
 * `readConfig` (`.parsed`) and the valueless finders (`.tokens`) consume it,
 * so the file is read and tokenized at most once per session until the
 * config file's own mtime+size change or `invalidateConfigCache` runs.
 *
 * The mtime check and the cache lookup/populate are a single `await`-free
 * span: two concurrent calls that both miss the CONTENT cache each ask
 * `coalescedMtimeKey` for a key, but share its single in-flight stat rather
 * than each paying their own — whichever resumes first then populates the
 * content cache atomically before the other can observe it, so only one
 * ever starts `loadConfigEntry` — the single-flight guarantee holds despite
 * the stat.
 */
const readConfigEntry = async (ctx: Context): Promise<ConfigCacheEntry> => {
  // The trust gate refuses before any I/O — not even a stat — so an
  // untrusted layout is recomputed fresh every call (cheap: no fs access)
  // rather than consulting or populating the cache below.
  if (layoutFailsTrustGate(ctx.layout)) return loadConfigEntry(ctx);
  const path = `${commonGitDir(ctx)}/config`;
  const mtimeKey = await coalescedMtimeKey(ctx, path);
  const cached = cache.get(ctx.session);
  if (cached !== undefined && cached.mtimeKey === mtimeKey) {
    return cached.promise;
  }
  const promise = loadConfigEntry(ctx);
  cache.set(ctx.session, { promise, mtimeKey });
  return promise;
};

/**
 * @internal — test-only cache reset between cases. Replaces every WeakMap
 * this module owns (the parse cache, the gate-verdict memo, and the
 * in-flight stat-coalescing memo), mirroring what `invalidateConfigCache`
 * drops in production plus the transient memo that never survives past its
 * own settling anyway.
 */
export const __resetConfigCacheForTests = (): void => {
  cache = new WeakMap();
  gateVerdictCache = new WeakMap();
  inflightMtimeKey = new WeakMap();
};

/**
 * Drop the cached `readConfig` entry for the session, AND the gate-verdict
 * memo `internal/repo-state.ts` populates via `memoizeGateVerdict` (owned
 * here — see that export's docstring for why) — both session-keyed, so a
 * call through ANY Context sharing `ctx.session` drops the entry every
 * OTHER Context in that session would otherwise keep serving stale.
 *
 * DELEGATES to `invalidateScopedConfigCache` (`config-scoped-read.ts`) so a
 * caller who invalidates only this cache — an embedder unaware of the
 * scoped-sections cache, or test code that seeds config with a raw
 * `ctx.fs.writeUtf8` and calls only this invalidator — still observes a
 * fresh scoped read next time, rather than a same-tick-frozen stat
 * indefinitely masking the rewrite there too. Every config writer ALSO calls
 * `invalidateScopedConfigCache` directly (see `update-config.ts` and
 * `update-config-sections.ts`); that explicit call still matters — it is
 * what lets a caller invalidate the scoped cache WITHOUT touching this one
 * (not needed today, but the pairing is not required to only run one way).
 */
export const invalidateConfigCache = (ctx: Context): void => {
  cache.delete(ctx.session);
  gateVerdictCache.delete(ctx.session);
  invalidateScopedConfigCache(ctx);
};

/**
 * Build the cache entry from the LOCAL config file alone — both the tokens the
 * eager-gate finders walk and the `parsed` projection every typed reader
 * consumes.
 *
 * Local-only is deliberate, not an oversight. Resolving all four scopes the
 * way git does was implemented and reverted: the filesystem port confines a
 * repository to `[workDir, gitDir, commonDir]`, so `~/.gitconfig` and
 * `/etc/gitconfig` sit outside containment and every non-local scope comes
 * back empty regardless. Merging them would be machinery that cannot observe
 * anything. A value set only in global scope is therefore honoured by git and
 * ignored here — a divergence the published docs state outright. Closing it
 * means widening the containment root set, which is a security decision, not
 * a config one. The scope-aware porcelain reader (`readConfigSections`) is
 * unaffected and still serves the `config` command.
 *
 * A layout the ownership-trust gate refuses (`layoutFailsTrustGate` —
 * `untrusted` or `implicitBare`) short-circuits BEFORE the read: the file is
 * never opened, so every consumer of this cache entry — `readConfig`'s
 * `parsed` projection AND the eager-gate token finders below — observes the
 * same empty scope `assertTrusted` is about to refuse on, rather than racing
 * a malformed value in the attacker's file ahead of that refusal.
 */
const loadConfigEntry = async (ctx: Context): Promise<ConfigCacheEntry> => {
  const path = `${commonGitDir(ctx)}/config`;
  if (layoutFailsTrustGate(ctx.layout)) return { parsed: {}, tokens: [], source: path };
  const raw = await readRawConfig(ctx, path);
  if (raw === undefined) return { parsed: {}, tokens: [], source: path };
  const tokens = tokenizeConfig(raw, path);
  return { parsed: assembleParsed(parseIniSectionsFromTokens(tokens)), tokens, source: path };
};

const readRawConfig = async (ctx: Context, path: string): Promise<string | undefined> => {
  try {
    return await ctx.fs.readUtf8(path);
  } catch (err) {
    if (err instanceof TsgitError && err.data.code === 'FILE_NOT_FOUND') return undefined;
    throw err;
  }
};

export interface ValuelessEntry {
  readonly key: string;
  readonly source: string;
  readonly line: number;
}

const matchesSection = (
  tokenSection: string,
  tokenSubsection: string | undefined,
  section: string,
  subsection: string | undefined,
): boolean =>
  tokenSection.toLowerCase() === section.toLowerCase() && tokenSubsection === subsection;

/**
 * Valueless-entry detection: scan the repo-local config and return the FIRST
 * valueless (`value === null`) entry, by config-file line, whose key
 * (case-insensitive) is one of `keys` and which sits under `[<section> "<subsection>"]`
 * (subsection `undefined` ⇒ the section with no subsection). Returns the fully-qualified
 * key, the absolute config path, and the 1-based line, or `undefined` when no such
 * entry exists. Walks the cached token stream, so an eager caller (the `[user]`
 * identity pre-flight) pays only an in-memory scan, not a second read.
 */
export const findFirstValuelessEntry = async (
  ctx: Context,
  section: string,
  subsection: string | undefined,
  keys: ReadonlyArray<string>,
): Promise<ValuelessEntry | undefined> => {
  const { tokens, source: path } = await readConfigEntry(ctx);
  const keySet = new Set(keys.map((k) => k.toLowerCase()));
  let inSection = false;
  for (const token of tokens) {
    if (token.kind === 'header') {
      inSection = matchesSection(token.section, token.subsection, section, subsection);
      continue;
    }
    if (!inSection || token.kind !== 'entry' || token.value !== null) continue;
    const loweredKey = token.key.toLowerCase();
    if (!keySet.has(loweredKey)) continue;
    const loweredSection = section.toLowerCase();
    const qualifiedKey =
      subsection === undefined
        ? `${loweredSection}.${loweredKey}`
        : `${loweredSection}.${subsection}.${loweredKey}`;
    return { key: qualifiedKey, source: path, line: token.startLine + 1 };
  }
  return undefined;
};

/**
 * Subsection-wildcard sibling of `findFirstValuelessEntry`: scan EVERY subsection
 * of `section` (case-insensitive section match, any `subsection`) and return the
 * FIRST valueless (`value === null`) entry, by config-file line, whose key
 * (case-insensitive) is one of `keys`. The qualified key keeps the matched
 * header's subsection verbatim (`${section}.${subsection}.${key}`, section + key
 * lower-cased), or `${section}.${key}` for the subsectionless form. Consumes the
 * cached token stream — one walk, no extra read. Used by the content-merge
 * chokepoint to reproduce git's whole-`[merge *]`-table valueless death.
 *
 * `requireSubsection` skips subsectionless entries (`[merge] key` with no
 * `[merge "<name>"]` header): git's merge-driver keys are only meaningful under a
 * subsection, so a subsectionless valueless `merge.<key>` is inert to git — not a
 * death — and must not be reported.
 */
export const findFirstValuelessInSection = async (
  ctx: Context,
  section: string,
  keys: ReadonlyArray<string>,
  { requireSubsection = false }: { readonly requireSubsection?: boolean } = {},
): Promise<ValuelessEntry | undefined> => {
  const { tokens, source: path } = await readConfigEntry(ctx);
  const keySet = new Set(keys.map((k) => k.toLowerCase()));
  const loweredSection = section.toLowerCase();
  let subsection: string | undefined;
  let inSection = false;
  for (const token of tokens) {
    if (token.kind === 'header') {
      inSection = token.section.toLowerCase() === loweredSection;
      subsection = token.subsection;
      continue;
    }
    if (!inSection || token.kind !== 'entry' || token.value !== null) continue;
    if (requireSubsection && subsection === undefined) continue;
    const loweredKey = token.key.toLowerCase();
    if (!keySet.has(loweredKey)) continue;
    const qualifiedKey =
      subsection === undefined
        ? `${loweredSection}.${loweredKey}`
        : `${loweredSection}.${subsection}.${loweredKey}`;
    return { key: qualifiedKey, source: path, line: token.startLine + 1 };
  }
  return undefined;
};

/** Minimum valid zlib compression level (synonym for the implementation default). */
export const ZLIB_MIN_LEVEL = -1;
/** Maximum valid zlib compression level. */
export const ZLIB_MAX_LEVEL = 9;

/** The discriminated failure from a compression-key validation scan. */
type CompressionFailure =
  | {
      readonly kind: 'numeric';
      readonly value: string;
      readonly reason: 'invalid unit' | 'out of range';
    }
  | { readonly kind: 'zlib'; readonly level: number };

/** One invalid compression entry returned by `findFirstInvalidCompression`. */
export interface InvalidCompressionEntry {
  readonly key: string;
  readonly source: string;
  readonly line: number;
  readonly failure: CompressionFailure;
}

const COMPRESSION_KEYS: ReadonlySet<string> = new Set(['loosecompression', 'compression']);

/**
 * Cold-path detection: walk the cached `[core]` (subsectionless) tokens in
 * file order and return the FIRST entry whose key is `loosecompression` or
 * `compression` that fails full compression validation (valueless, invalid
 * integer, or integer outside zlib's `-1..9`). Returns `undefined` when all
 * compression keys are absent or valid. Runs ONLY on a command's refusal path.
 */
export const findFirstInvalidCompression = async (
  ctx: Context,
): Promise<InvalidCompressionEntry | undefined> => {
  const { tokens, source: path } = await readConfigEntry(ctx);
  let inSection = false;
  for (const token of tokens) {
    if (token.kind === 'header') {
      inSection = matchesSection(token.section, token.subsection, 'core', undefined);
      continue;
    }
    if (!inSection || token.kind !== 'entry') continue;
    const loweredKey = token.key.toLowerCase();
    if (!COMPRESSION_KEYS.has(loweredKey)) continue;
    const qualifiedKey = `core.${loweredKey}`;
    const line = token.startLine + 1;
    if (token.value === null) {
      return {
        key: qualifiedKey,
        source: path,
        line,
        failure: { kind: 'numeric', value: '', reason: 'invalid unit' },
      };
    }
    const parsed = parseGitInt(token.value);
    if (!parsed.ok) {
      return {
        key: qualifiedKey,
        source: path,
        line,
        failure: { kind: 'numeric', value: token.value, reason: parsed.reason },
      };
    }
    if (parsed.value < ZLIB_MIN_LEVEL || parsed.value > ZLIB_MAX_LEVEL) {
      return {
        key: qualifiedKey,
        source: path,
        line,
        failure: { kind: 'zlib', level: parsed.value },
      };
    }
  }
  return undefined;
};

const GC_AUTO_KEY = 'auto';

/** One invalid `gc.auto` entry returned by `findFirstInvalidGcAuto`. */
export interface InvalidGcAutoEntry {
  readonly key: string;
  readonly source: string;
  readonly value: string;
  readonly reason: 'invalid unit' | 'out of range';
}

/**
 * Cold-path detection: walk the cached `[gc]` (subsectionless) tokens in
 * file order and return the FIRST `auto` entry whose value fails git's
 * integer grammar or the C `int` range. Returns `undefined` when the key is
 * absent or its first entry is valid. Runs ONLY on a command's refusal
 * path — `readConfig` stays lenient and merges an invalid `gc.auto` as
 * absent (see `mergeGc`).
 */
export const findFirstInvalidGcAuto = async (
  ctx: Context,
): Promise<InvalidGcAutoEntry | undefined> => {
  const { tokens, source: path } = await readConfigEntry(ctx);
  let inSection = false;
  for (const token of tokens) {
    if (token.kind === 'header') {
      inSection = matchesSection(token.section, token.subsection, 'gc', undefined);
      continue;
    }
    if (!inSection || token.kind !== 'entry') continue;
    if (token.key.toLowerCase() !== GC_AUTO_KEY) continue;
    const parsed = parseGitInt(token.value);
    if (parsed.ok && parsed.value >= GIT_C_INT_MIN && parsed.value <= GIT_C_INT_MAX) continue;
    const reason = parsed.ok ? 'out of range' : parsed.reason;
    return { key: `gc.${GC_AUTO_KEY}`, source: path, value: token.value ?? '', reason };
  }
  return undefined;
};

/**
 * Refuse with `CONFIG_BAD_NUMERIC_VALUE` when `gc.auto` holds a value git's
 * integer grammar refuses — the integer sibling of `assertValidBooleanConfig`,
 * same eager-gate posture `pack.writeReverseIndex` established: a refused
 * value must never be silently read back as absent-and-defaulted.
 */
export const assertValidGcAutoConfig = async (ctx: Context): Promise<void> => {
  const found = await findFirstInvalidGcAuto(ctx);
  if (found !== undefined) {
    throw configBadNumericValue(found.key, found.source, found.value, found.reason);
  }
};

/** One invalid `pack.window` / `pack.depth` / `pack.windowMemory` entry returned by `findFirstInvalidPackInt`. */
export interface InvalidPackIntEntry {
  readonly key: string;
  readonly source: string;
  readonly value: string;
  readonly reason: 'invalid unit' | 'out of range';
}

/**
 * Cold-path detection: walk the cached `[pack]` (subsectionless) tokens in
 * file order and return the FIRST `window` / `depth` / `windowMemory` entry
 * whose value fails git's integer grammar or its own key's range. `window`
 * and `depth` share the C `int` range `gc.auto` uses; `windowMemory` is
 * bounded only to non-negative — git's own unsigned-long range, not the C
 * `int` the other two keys share. Returns `undefined` when every recognised
 * entry is valid or none is present. Runs ONLY on a command's refusal path —
 * `readConfig` stays lenient and merges an invalid entry as absent (see
 * `mergePack`).
 */
export const findFirstInvalidPackInt = async (
  ctx: Context,
): Promise<InvalidPackIntEntry | undefined> => {
  const { tokens, source: path } = await readConfigEntry(ctx);
  let inSection = false;
  for (const token of tokens) {
    if (token.kind === 'header') {
      inSection = matchesSection(token.section, token.subsection, 'pack', undefined);
      continue;
    }
    if (!inSection || token.kind !== 'entry') continue;
    const lowered = token.key.toLowerCase();
    const check = packIntChecker(lowered);
    if (check === undefined) continue;
    const checked = check(token.value);
    if (checked.ok) continue;
    return {
      key: `pack.${lowered}`,
      source: path,
      value: token.value ?? '',
      reason: checked.reason,
    };
  }
  return undefined;
};

/**
 * Refuse with `CONFIG_BAD_NUMERIC_VALUE` when `pack.window`, `pack.depth` or
 * `pack.windowMemory` holds a value git's integer grammar (or that key's own
 * range) refuses — the pack-config sibling of `assertValidGcAutoConfig`.
 */
export const assertValidPackIntConfig = async (ctx: Context): Promise<void> => {
  const found = await findFirstInvalidPackInt(ctx);
  if (found !== undefined) {
    throw configBadNumericValue(found.key, found.source, found.value, found.reason);
  }
};

const MAX_TREE_DEPTH_KEY = 'maxtreedepth';

/** One invalid `core.maxTreeDepth` entry returned by `findLastInvalidMaxTreeDepth`. */
export interface InvalidMaxTreeDepthEntry {
  readonly key: string;
  readonly source: string;
  readonly value: string;
  readonly reason: 'invalid unit' | 'out of range';
}

/**
 * Cold-path detection for `core.maxTreeDepth`: walk the cached `[core]`
 * (subsectionless) tokens in file order and validate only the LAST
 * `maxtreedepth` entry — not the first, unlike `findFirstInvalidCompression`
 * above. This is forced by git, not a stylistic choice: git resolves
 * `core.maxTreeDepth` through its cached config-set lookup (last write wins),
 * not through the streaming `git_default_config` callback the other `[core]`
 * keys ride, so an earlier malformed line that a later valid line overrides
 * is never observed. `core.compression`, by contrast, dies on any malformed
 * line regardless of what follows it. Returns `undefined` when the key is
 * absent or its last entry is valid. Runs ONLY on a command's refusal path.
 */
export const findLastInvalidMaxTreeDepth = async (
  ctx: Context,
): Promise<InvalidMaxTreeDepthEntry | undefined> => {
  const { tokens, source: path } = await readConfigEntry(ctx);
  let inSection = false;
  let last: { readonly value: string | null } | undefined;
  for (const token of tokens) {
    if (token.kind === 'header') {
      inSection = matchesSection(token.section, token.subsection, 'core', undefined);
      continue;
    }
    if (!inSection || token.kind !== 'entry') continue;
    if (token.key.toLowerCase() !== MAX_TREE_DEPTH_KEY) continue;
    last = { value: token.value };
  }
  if (last === undefined) return undefined;
  const key = `core.${MAX_TREE_DEPTH_KEY}`;
  if (last.value === null) {
    return { key, source: path, value: '', reason: 'invalid unit' };
  }
  const parsed = parseGitInt(last.value);
  if (!parsed.ok) {
    return { key, source: path, value: last.value, reason: parsed.reason };
  }
  // The C-`int` narrowing sits here, on top of `parseGitInt`: `parseGitInt`'s own
  // bounds are int64, so a magnitude like 4294967296 comes back `ok` from it —
  // this comparison is what turns that into `out of range` for this key.
  if (parsed.value < GIT_C_INT_MIN || parsed.value > GIT_C_INT_MAX) {
    return { key, source: path, value: last.value, reason: 'out of range' };
  }
  return undefined;
};

type MutableGpg = {
  format?: 'openpgp' | 'ssh' | 'x509';
  program?: string;
  ssh?: { program?: string };
};

interface MutableParsedConfig {
  core?: MutableCore;
  user?: { name?: string; email?: string; signingKey?: string };
  remote?: Map<
    string,
    {
      url?: string;
      pushUrl?: string;
      fetch?: string[];
      promisor?: boolean;
      partialCloneFilter?: string;
    }
  >;
  remotePushDefault?: string;
  branch?: Map<string, { remote?: string; merge?: string; pushRemote?: string }>;
  submodule?: Map<string, { url?: string; active?: boolean; update?: string }>;
  merge?: Map<string, { name?: string; driver?: string; recursive?: string }>;
  diff?: Map<string, { textconv?: string; cachetextconv?: boolean }>;
  filter?: Map<string, { clean?: string; smudge?: string; process?: string; required?: boolean }>;
  extensions?: { partialClone?: string };
  commit?: { gpgSign?: boolean };
  tag?: { gpgSign?: boolean };
  pack?: MutablePack;
  gc?: { auto?: number; pruneExpire?: string; cruftPacks?: boolean };
  push?: { gpgSign?: 'true' | 'false' | 'if-asked'; default?: PushDefaultMode };
  gpg?: MutableGpg;
}

const dispatchSubsection = (acc: MutableParsedConfig, sec: IniSection, name: string): void => {
  // Case-insensitive section match, as git does; the subsection `name` stays
  // case-sensitive, also as git does.
  const section = sec.section.toLowerCase();
  if (section === 'remote') mergeRemote(acc, name, sec);
  else if (section === 'branch') mergeBranch(acc, name, sec);
  else if (section === 'submodule') mergeSubmodule(acc, name, sec);
  else if (section === 'merge') mergeMergeDriver(acc, name, sec);
  else if (section === 'diff') mergeDiffDriver(acc, name, sec);
  else if (section === 'filter') mergeFilterDriver(acc, name, sec);
  else if (section === 'gpg') mergeGpgSsh(acc, name, sec);
};

const dispatchSection = (acc: MutableParsedConfig, sec: IniSection): void => {
  // git matches section names case-insensitively (subsection names are
  // case-sensitive), so `[CORE]` is `[core]`. Normalise here rather than at the
  // tokenizer: the config writer reconstructs headers from the token's section
  // and must preserve the author's casing on write, exactly as git does.
  const section = sec.section.toLowerCase();
  if (sec.subsection !== undefined) {
    dispatchSubsection(acc, sec, sec.subsection);
  } else if (section === 'remote') {
    mergeRemoteTopLevel(acc, sec);
  } else if (section === 'core') {
    mergeCore(acc, sec);
  } else if (section === 'user') {
    mergeUser(acc, sec);
  } else if (section === 'extensions') {
    mergeExtensions(acc, sec);
  } else if (section === 'commit') {
    mergeCommit(acc, sec);
  } else if (section === 'tag') {
    mergeTag(acc, sec);
  } else if (section === 'pack') {
    mergePack(acc, sec);
  } else if (section === 'gc') {
    mergeGc(acc, sec);
  } else if (section === 'push') {
    mergePush(acc, sec);
  } else if (section === 'gpg') {
    mergeGpg(acc, sec);
  }
};

const assembleParsed = (sections: ReadonlyArray<IniSection>): ParsedConfig => {
  const acc: MutableParsedConfig = {};
  for (const sec of sections) {
    dispatchSection(acc, sec);
  }
  return finalize(acc);
};

type MutableCore = {
  bare?: boolean;
  excludesFile?: string;
  attributesFile?: string;
  logAllRefUpdates?: boolean | 'always';
  hooksPath?: string;
  notesRef?: string;
  sparseCheckout?: boolean;
  sparseCheckoutCone?: boolean;
  looseCompression?: number;
  maxTreeDepth?: number;
  sshCommand?: string;
  /** Transient: true when looseCompression was set via loosecompression key (not compression).
   *  Dropped by finalizeCore. Guards order-independent precedence: loosecompression > compression. */
  looseCompressionFromLoose?: boolean;
};

/**
 * Apply core.loosecompression / core.compression with order-independent precedence.
 * loosecompression always wins; compression sets only when loosecompression was never seen.
 * valued-but-invalid int merges as absent (lenient; eager gate handles the valueless case).
 */
const applyLooseCompressionEntry = (
  core: MutableCore,
  lowered: string,
  value: string,
): MutableCore | undefined => {
  const r = parseGitInt(value);
  if (!r.ok) return undefined;
  if (lowered === 'loosecompression') {
    // loosecompression always wins — overrides any prior compression-derived value
    return { ...core, looseCompression: r.value, looseCompressionFromLoose: true };
  }
  // compression: set only if loosecompression has not already claimed the field
  if (core.looseCompressionFromLoose === true) return undefined;
  return { ...core, looseCompression: r.value };
};

/**
 * Apply `core.maxTreeDepth`: parse with `parseGitInt`, narrow to the C `int`
 * range, and merge the field as absent (`undefined`) on any failure. Stays
 * lenient by design — `readConfig` is total, so the refusal for an invalid
 * value lives in `resolveMaxTreeDepth`, a separate read of the same cached
 * tokens.
 */
const applyMaxTreeDepthEntry = (core: MutableCore, value: string): MutableCore | undefined => {
  const parsed = parseGitInt(value);
  if (!parsed.ok) return undefined;
  if (parsed.value < GIT_C_INT_MIN || parsed.value > GIT_C_INT_MAX) return undefined;
  return { ...core, maxTreeDepth: parsed.value };
};

// One map is BOTH the key set and the field dispatch: a new boolean key
// cannot join the set without naming its target field, so a silent
// mis-assignment is structurally impossible.
const CORE_BOOLEAN_FIELDS: Readonly<
  Record<string, 'bare' | 'sparseCheckout' | 'sparseCheckoutCone'>
> = {
  bare: 'bare',
  sparsecheckout: 'sparseCheckout',
  sparsecheckoutcone: 'sparseCheckoutCone',
};

const CORE_BOOLEAN_KEYS = new Set(['logallrefupdates', ...Object.keys(CORE_BOOLEAN_FIELDS)]);

/** Handles the four `[core]` keys whose value is boolean-typed (or the `always` tri-state). */
const applyCoreBooleanEntry = (
  core: MutableCore,
  lowered: string,
  value: string | null,
): MutableCore | undefined => {
  if (lowered === 'logallrefupdates') {
    const parsed = parseLogAllRefUpdates(value);
    return parsed === undefined ? undefined : { ...core, logAllRefUpdates: parsed };
  }
  const field = CORE_BOOLEAN_FIELDS[lowered];
  // Stryker disable next-line ConditionalExpression: equivalent — callers gate on CORE_BOOLEAN_KEYS, which is derived from CORE_BOOLEAN_FIELDS plus the tri-state handled above, so no key without a field mapping can reach this line; the branch exists only to narrow the Record lookup's type.
  if (field === undefined) return undefined;
  const parsed = parseGitBoolean(value);
  if (!parsed.ok) return undefined;
  return { ...core, [field]: parsed.value };
};

/**
 * Apply one [core] entry to a mutable core accumulator. Returns the updated
 * accumulator, or `undefined` when the key is not recognised (so the caller
 * can avoid promoting `acc.core` from `undefined` to `{}` on irrelevant keys).
 */
const applyCoreEntry = (
  core: MutableCore,
  lowered: string,
  value: string | null,
): MutableCore | undefined => {
  if (CORE_BOOLEAN_KEYS.has(lowered)) return applyCoreBooleanEntry(core, lowered, value);
  // String-typed and int-typed fields skip null (valueless key treated as absent).
  if (value === null) return undefined;
  if (lowered === 'excludesfile') return { ...core, excludesFile: value };
  if (lowered === 'attributesfile') return { ...core, attributesFile: value };
  if (lowered === 'hookspath') return { ...core, hooksPath: value };
  if (lowered === 'notesref') return { ...core, notesRef: value };
  if (lowered === 'sshcommand') return { ...core, sshCommand: value };
  if (lowered === 'loosecompression' || lowered === 'compression') {
    return applyLooseCompressionEntry(core, lowered, value);
  }
  if (lowered === MAX_TREE_DEPTH_KEY) return applyMaxTreeDepthEntry(core, value);
  return undefined;
};

const mergeCore = (acc: { core?: MutableCore }, sec: IniSection): void => {
  for (const { key, value } of sec.entries) {
    // Git config keys are case-insensitive; the parser preserves casing,
    // so we lowercase here for comparison.
    // `{ ...undefined }` is `{}`, so the spread alone handles the first write.
    const updated = applyCoreEntry(acc.core ?? {}, key.toLowerCase(), value);
    if (updated !== undefined) acc.core = updated;
  }
};

// The literal `always` is a third state beyond git's boolean values; a null
// value (valueless key) is boolean-true. Anything else falls through to the
// standard boolean parse; a refusal there leaves the field absent (`undefined`).
const parseLogAllRefUpdates = (value: string | null): boolean | 'always' | undefined => {
  if (value !== null && value.toLowerCase() === 'always') return 'always';
  const parsed = parseGitBoolean(value);
  return parsed.ok ? parsed.value : undefined;
};

const mergeUser = (
  acc: { user?: { name?: string; email?: string; signingKey?: string } },
  sec: IniSection,
): void => {
  for (const { key, value } of sec.entries) {
    // String-typed fields skip null (valueless key treated as absent).
    if (value === null) continue;
    if (key === 'name') {
      // `{ ...undefined }` is `{}`, so the spread alone handles the first write.
      acc.user = { ...acc.user, name: value };
    } else if (key === 'email') {
      acc.user = { ...acc.user, email: value };
    } else if (key.toLowerCase() === 'signingkey') {
      acc.user = { ...acc.user, signingKey: value };
    }
  }
};

interface MutableRemote {
  url?: string;
  pushUrl?: string;
  fetch?: string[];
  promisor?: boolean;
  partialCloneFilter?: string;
}

const applyRemoteEntry = (acc: MutableRemote, key: string, value: string | null): void => {
  // Git config keys are case-insensitive — compare on the lower-cased key.
  const lowered = key.toLowerCase();
  if (lowered === 'url') {
    // String-typed fields skip null (valueless key treated as absent).
    if (value !== null) acc.url = value;
  } else if (lowered === 'pushurl') {
    if (value !== null) acc.pushUrl = value;
  } else if (lowered === 'fetch') {
    if (value !== null) {
      // Stryker disable next-line ArrayDeclaration: equivalent — mergeRemote (the sole caller) pre-seeds mutable.fetch to an array before applyRemoteEntry runs, so this ??= never assigns and its right-hand literal never evaluates.
      acc.fetch ??= [];
      acc.fetch.push(value);
    }
  } else if (lowered === 'promisor') {
    const parsed = parseGitBoolean(value);
    if (parsed.ok) acc.promisor = parsed.value;
  } else if (lowered === 'partialclonefilter') {
    if (value !== null) acc.partialCloneFilter = value;
  }
};

const compactRemote = (mutable: MutableRemote): MutableRemote => {
  const merged: MutableRemote = {};
  if (mutable.url !== undefined) merged.url = mutable.url;
  if (mutable.pushUrl !== undefined) merged.pushUrl = mutable.pushUrl;
  if (mutable.fetch !== undefined && mutable.fetch.length > 0) merged.fetch = mutable.fetch;
  if (mutable.promisor !== undefined) merged.promisor = mutable.promisor;
  if (mutable.partialCloneFilter !== undefined) {
    merged.partialCloneFilter = mutable.partialCloneFilter;
  }
  return merged;
};

const mergeRemote = (
  acc: { remote?: Map<string, MutableRemote> },
  name: string,
  sec: IniSection,
): void => {
  acc.remote ??= new Map();
  const current = acc.remote.get(name) ?? {};
  const mutable: MutableRemote = { ...current, fetch: current.fetch ? [...current.fetch] : [] };
  for (const { key, value } of sec.entries) applyRemoteEntry(mutable, key, value);
  acc.remote.set(name, compactRemote(mutable));
};

// `[remote]` (no subsection) — distinct from `[remote "<name>"]`. Only `pushDefault` lives here;
// per-remote `pushDefault` is not read (pinned: `[remote "x"] pushDefault` is ignored by git).
const mergeRemoteTopLevel = (acc: { remotePushDefault?: string }, sec: IniSection): void => {
  for (const { key, value } of sec.entries) {
    if (value !== null && key.toLowerCase() === 'pushdefault') acc.remotePushDefault = value;
  }
};

const mergeBranch = (
  acc: { branch?: Map<string, { remote?: string; merge?: string; pushRemote?: string }> },
  name: string,
  sec: IniSection,
): void => {
  acc.branch ??= new Map();
  const current = acc.branch.get(name) ?? {};
  const next: { remote?: string; merge?: string; pushRemote?: string } = { ...current };
  for (const { key, value } of sec.entries) {
    // String-typed fields skip null (valueless key treated as absent).
    if (value === null) continue;
    if (key === 'remote') next.remote = value;
    else if (key === 'merge') next.merge = value;
    // Git config keys are case-insensitive; compare pushRemote on the lower-cased key.
    else if (key.toLowerCase() === 'pushremote') next.pushRemote = value;
  }
  acc.branch.set(name, next);
};

type MutableSubmodule = { url?: string; active?: boolean; update?: string };

const applySubmoduleEntry = (next: MutableSubmodule, key: string, value: string | null): void => {
  const lowered = key.toLowerCase();
  if (lowered === 'active') {
    const parsed = parseGitBoolean(value);
    if (parsed.ok) next.active = parsed.value;
    return;
  }
  // String-typed fields skip null (valueless key treated as absent).
  if (value === null) return;
  if (lowered === 'url') next.url = value;
  else if (lowered === 'update') next.update = value;
};

const mergeSubmodule = (
  acc: { submodule?: Map<string, MutableSubmodule> },
  name: string,
  sec: IniSection,
): void => {
  acc.submodule ??= new Map();
  const next: MutableSubmodule = { ...(acc.submodule.get(name) ?? {}) };
  for (const { key, value } of sec.entries) applySubmoduleEntry(next, key, value);
  acc.submodule.set(name, next);
};

const mergeMergeDriver = (
  acc: { merge?: Map<string, { name?: string; driver?: string; recursive?: string }> },
  name: string,
  sec: IniSection,
): void => {
  acc.merge ??= new Map();
  const next: { name?: string; driver?: string; recursive?: string } = {
    ...(acc.merge.get(name) ?? {}),
  };
  for (const { key, value } of sec.entries) {
    // String-typed fields skip null (valueless key treated as absent).
    if (value === null) continue;
    const lowered = key.toLowerCase();
    if (lowered === 'name') next.name = value;
    else if (lowered === 'driver') next.driver = value;
    else if (lowered === 'recursive') next.recursive = value;
  }
  acc.merge.set(name, next);
};

const mergeDiffDriver = (
  acc: { diff?: Map<string, { textconv?: string; cachetextconv?: boolean }> },
  name: string,
  sec: IniSection,
): void => {
  acc.diff ??= new Map();
  const next: { textconv?: string; cachetextconv?: boolean } = {
    ...(acc.diff.get(name) ?? {}),
  };
  for (const { key, value } of sec.entries) {
    const lowered = key.toLowerCase();
    if (lowered === 'textconv') {
      // String-typed field: skip null (valueless key treated as absent).
      if (value === null) continue;
      next.textconv = value;
    } else if (lowered === 'cachetextconv') {
      const parsed = parseGitBoolean(value);
      if (parsed.ok) next.cachetextconv = parsed.value;
    }
  }
  acc.diff.set(name, next);
};

type FilterEntry = { clean?: string; smudge?: string; process?: string; required?: boolean };

const applyFilterEntry = (next: FilterEntry, key: string, value: string | null): void => {
  const lowered = key.toLowerCase();
  if (lowered === 'required') {
    const parsed = parseGitBoolean(value);
    if (parsed.ok) next.required = parsed.value;
    return;
  }
  // String-typed fields skip null (valueless key treated as absent).
  if (value === null) return;
  if (lowered === 'clean') next.clean = value;
  else if (lowered === 'smudge') next.smudge = value;
  else if (lowered === 'process') next.process = value;
};

const mergeFilterDriver = (
  acc: { filter?: Map<string, FilterEntry> },
  name: string,
  sec: IniSection,
): void => {
  acc.filter ??= new Map();
  const next: FilterEntry = { ...(acc.filter.get(name) ?? {}) };
  for (const { key, value } of sec.entries) {
    applyFilterEntry(next, key, value);
  }
  acc.filter.set(name, next);
};

const mergeExtensions = (
  acc: { extensions?: { partialClone?: string } },
  sec: IniSection,
): void => {
  for (const { key, value } of sec.entries) {
    // `partialClone` names the promisor remote of a partial clone.
    // String-typed field: skip null (valueless key treated as absent).
    if (key.toLowerCase() === 'partialclone' && value !== null) {
      acc.extensions = { ...acc.extensions, partialClone: value };
    }
  }
};

const mergeCommit = (acc: { commit?: { gpgSign?: boolean } }, sec: IniSection): void => {
  for (const { key, value } of sec.entries) {
    if (key.toLowerCase() === 'gpgsign') {
      const parsed = parseGitBoolean(value);
      if (parsed.ok) acc.commit = { ...acc.commit, gpgSign: parsed.value };
    }
  }
};

const mergeTag = (acc: { tag?: { gpgSign?: boolean } }, sec: IniSection): void => {
  for (const { key, value } of sec.entries) {
    if (key.toLowerCase() === 'gpgsign') {
      const parsed = parseGitBoolean(value);
      if (parsed.ok) acc.tag = { ...acc.tag, gpgSign: parsed.value };
    }
  }
};

type MutablePack = {
  writeReverseIndex?: boolean;
  window?: number;
  depth?: number;
  windowMemory?: number;
};

const PACK_WINDOW_KEY = 'window';
const PACK_DEPTH_KEY = 'depth';
const PACK_WINDOW_MEMORY_KEY = 'windowmemory';

type PackIntCheck = (value: string | null) => ReturnType<typeof parseGitInt>;

const checkPackCIntBound: PackIntCheck = (value) => {
  const parsed = parseGitInt(value);
  if (!parsed.ok) return parsed;
  if (parsed.value < GIT_C_INT_MIN || parsed.value > GIT_C_INT_MAX) {
    return { ok: false, reason: 'out of range' };
  }
  return parsed;
};

// git's own unsigned-long grammar: a negative value is a syntax refusal
// ('invalid unit'), not a magnitude refusal — unlike `window`/`depth`'s C
// `int`, this key has no signed representation to be "out of range" of.
// `parseGitInt` is given the unsigned-long ceiling (GIT_UINT64_MAX) instead
// of its own int64 default, so a magnitude between int64-max and uint64-max
// — refused for window/depth — reads as valid here.
const checkPackWindowMemoryBound: PackIntCheck = (value) => {
  const parsed = parseGitInt(value, GIT_UINT64_MAX);
  if (!parsed.ok) return parsed;
  if (parsed.value < 0) return { ok: false, reason: 'invalid unit' };
  return parsed;
};

/**
 * Which bound rule (if any) governs a `[pack]` key. `undefined` means the key
 * is not one of the three int-typed pack keys. Kept as two small checkers,
 * not one merged condition, so `window`/`depth`'s C-int bound and
 * `windowMemory`'s unsigned-long bound are each independently testable.
 */
const packIntChecker = (lowered: string): PackIntCheck | undefined => {
  if (lowered === PACK_WINDOW_KEY || lowered === PACK_DEPTH_KEY) return checkPackCIntBound;
  if (lowered === PACK_WINDOW_MEMORY_KEY) return checkPackWindowMemoryBound;
  return undefined;
};

const applyPackWriteReverseIndexEntry = (
  pack: MutablePack,
  value: string | null,
): MutablePack | undefined => {
  const parsed = parseGitBoolean(value);
  return parsed.ok ? { ...pack, writeReverseIndex: parsed.value } : undefined;
};

const applyPackIntEntry = (
  pack: MutablePack,
  field: 'window' | 'depth' | 'windowMemory',
  value: string | null,
  check: PackIntCheck,
): MutablePack | undefined => {
  const checked = check(value);
  return checked.ok ? { ...pack, [field]: checked.value } : undefined;
};

/**
 * Apply one `[pack]` entry. Returns the updated accumulator, or `undefined`
 * when the key is not recognised or its value fails validation — the same
 * shape `applyGcEntry` uses. `readConfig` stays total/lenient here: an
 * invalid `window`/`depth`/`windowMemory` merges as absent, and the eager
 * refusal lives in `assertValidPackIntConfig`.
 */
const applyPackEntry = (
  pack: MutablePack,
  lowered: string,
  value: string | null,
): MutablePack | undefined => {
  if (lowered === 'writereverseindex') return applyPackWriteReverseIndexEntry(pack, value);
  const check = packIntChecker(lowered);
  if (check === undefined) return undefined;
  const field =
    lowered === PACK_WINDOW_KEY ? 'window' : lowered === PACK_DEPTH_KEY ? 'depth' : 'windowMemory';
  return applyPackIntEntry(pack, field, value, check);
};

const mergePack = (acc: { pack?: MutablePack }, sec: IniSection): void => {
  for (const { key, value } of sec.entries) {
    const next = applyPackEntry(acc.pack ?? {}, key.toLowerCase(), value);
    if (next !== undefined) acc.pack = next;
  }
};

type MutableGc = { auto?: number; pruneExpire?: string; cruftPacks?: boolean };

const applyGcAutoEntry = (gc: MutableGc, value: string | null): MutableGc | undefined => {
  const parsed = parseGitInt(value);
  if (!parsed.ok || parsed.value < GIT_C_INT_MIN || parsed.value > GIT_C_INT_MAX) return undefined;
  return { ...gc, auto: parsed.value };
};

/**
 * Apply one `[gc]` entry. Returns the updated accumulator, or `undefined`
 * when the key is not recognised or its value fails validation — the same
 * shape `applyCoreEntry` uses, so a malformed sibling never blocks a
 * well-formed key from being merged. `readConfig` stays total/lenient here —
 * the eager refusal for `gc.auto` lives in `assertValidGcAutoConfig`,
 * `gc.cruftPacks`'s in `assertValidBooleanConfig`, and `gc.pruneExpire`'s
 * grammar in `expiryCutoff`, mirroring `pack.writeReverseIndex`'s split
 * between a lenient merge and a separate refusal gate.
 */
const applyGcEntry = (
  gc: MutableGc,
  lowered: string,
  value: string | null,
): MutableGc | undefined => {
  if (lowered === 'auto') return applyGcAutoEntry(gc, value);
  if (lowered === 'pruneexpire') {
    // String-typed field: skip null (valueless key treated as absent).
    // Grammar validated downstream by expiryCutoff — readConfig stays lenient.
    return value === null ? undefined : { ...gc, pruneExpire: value };
  }
  if (lowered === 'cruftpacks') {
    const parsed = parseGitBoolean(value);
    return parsed.ok ? { ...gc, cruftPacks: parsed.value } : undefined;
  }
  return undefined;
};

const mergeGc = (acc: { gc?: MutableGc }, sec: IniSection): void => {
  for (const { key, value } of sec.entries) {
    const next = applyGcEntry(acc.gc ?? {}, key.toLowerCase(), value);
    if (next !== undefined) acc.gc = next;
  }
};

// `if-asked` is a third state beyond git's boolean values, checked ahead of the
// standard boolean parse. A refusal there leaves the field absent (`undefined`).
const parsePushGpgSign = (value: string | null): 'true' | 'false' | 'if-asked' | undefined => {
  if (value !== null && value.toLowerCase() === 'if-asked') return 'if-asked';
  const parsed = parseGitBoolean(value);
  return parsed.ok ? (parsed.value ? 'true' : 'false') : undefined;
};

// Lenient here: an unrecognized value (including wrong case) parses to `undefined` rather than
// throwing — the hard refusal on an invalid `push.default` is a push-time concern, not the parser's.
const parsePushDefault = (value: string | null): PushDefaultMode | undefined => {
  if (value === 'tracking') return 'upstream'; // deprecated alias
  if (
    value === 'nothing' ||
    value === 'current' ||
    value === 'upstream' ||
    value === 'simple' ||
    value === 'matching'
  ) {
    return value;
  }
  return undefined;
};

/** One invalid `push.default` entry returned by `findInvalidPushDefault`. */
export interface InvalidPushDefaultEntry {
  readonly key: string;
  readonly source: string;
  readonly line: number;
  readonly value: string;
}

/**
 * Cold-path detection: walk the cached `[push]` (subsectionless) tokens in
 * file order and return the FIRST `default` entry whose value is present
 * (non-null) and fails `parsePushDefault` — an unrecognized mode, wrong case
 * included. A valueless `default` is not an invalid-value error; it mirrors
 * `mergePush`, which treats it as absent. Returns `undefined` when every
 * `push.default` entry is either absent, valueless, or a recognized mode.
 * Runs ONLY on a command's refusal path (`push`), never during config assembly.
 */
export const findInvalidPushDefault = async (
  ctx: Context,
): Promise<InvalidPushDefaultEntry | undefined> => {
  const { tokens, source: path } = await readConfigEntry(ctx);
  let inSection = false;
  for (const token of tokens) {
    if (token.kind === 'header') {
      inSection = matchesSection(token.section, token.subsection, 'push', undefined);
      continue;
    }
    if (!inSection || token.kind !== 'entry' || token.key.toLowerCase() !== 'default') continue;
    if (token.value === null || parsePushDefault(token.value) !== undefined) continue;
    return { key: 'push.default', source: path, line: token.startLine + 1, value: token.value };
  }
  return undefined;
};

const mergePush = (
  acc: { push?: { gpgSign?: 'true' | 'false' | 'if-asked'; default?: PushDefaultMode } },
  sec: IniSection,
): void => {
  for (const { key, value } of sec.entries) {
    if (key.toLowerCase() === 'gpgsign') {
      const gpgSign = parsePushGpgSign(value);
      if (gpgSign !== undefined) acc.push = { ...acc.push, gpgSign };
    } else if (key.toLowerCase() === 'default') {
      const mode = parsePushDefault(value);
      if (mode !== undefined) acc.push = { ...acc.push, default: mode };
    }
  }
};

const isGpgFormat = (value: string): value is 'openpgp' | 'ssh' | 'x509' =>
  value === 'openpgp' || value === 'ssh' || value === 'x509';

const mergeGpg = (acc: { gpg?: MutableGpg }, sec: IniSection): void => {
  for (const { key, value } of sec.entries) {
    if (value === null) continue;
    const lowered = key.toLowerCase();
    if (lowered === 'format' && isGpgFormat(value)) {
      acc.gpg = { ...acc.gpg, format: value };
    } else if (lowered === 'program') {
      acc.gpg = { ...acc.gpg, program: value };
    }
  }
};

// `[gpg "ssh"]` is the only recognised `gpg.*` subsection; any other
// subsection name (not a real git config surface today) is a silent no-op.
const mergeGpgSsh = (acc: { gpg?: MutableGpg }, name: string, sec: IniSection): void => {
  if (name !== 'ssh') return;
  for (const { key, value } of sec.entries) {
    if (key.toLowerCase() === 'program' && value !== null) {
      acc.gpg = { ...acc.gpg, ssh: { ...acc.gpg?.ssh, program: value } };
    }
  }
};

/**
 * Finalize the `[core]` section: emit only the keys that were set, or
 * `undefined` when the section was never populated. `mergeCore` is the sole
 * writer of `acc.core` and always writes a defined value, so a defined `core`
 * always yields a non-empty object.
 */
const finalizeCore = (core: MutableCore | undefined): ParsedConfig['core'] => {
  if (core === undefined) return undefined;
  // looseCompressionFromLoose is transient (precedence flag) — not projected to ParsedConfig
  return {
    ...(core.bare !== undefined ? { bare: core.bare } : {}),
    ...(core.excludesFile !== undefined ? { excludesFile: core.excludesFile } : {}),
    ...(core.attributesFile !== undefined ? { attributesFile: core.attributesFile } : {}),
    ...(core.logAllRefUpdates !== undefined ? { logAllRefUpdates: core.logAllRefUpdates } : {}),
    ...(core.hooksPath !== undefined ? { hooksPath: core.hooksPath } : {}),
    ...(core.notesRef !== undefined ? { notesRef: core.notesRef } : {}),
    ...(core.sparseCheckout !== undefined ? { sparseCheckout: core.sparseCheckout } : {}),
    ...(core.sparseCheckoutCone !== undefined
      ? { sparseCheckoutCone: core.sparseCheckoutCone }
      : {}),
    ...(core.looseCompression !== undefined ? { looseCompression: core.looseCompression } : {}),
    ...(core.maxTreeDepth !== undefined ? { maxTreeDepth: core.maxTreeDepth } : {}),
    ...(core.sshCommand !== undefined ? { sshCommand: core.sshCommand } : {}),
  };
};

type FinalizeOut = {
  diff?: ReadonlyMap<string, { textconv?: string; cachetextconv?: boolean }>;
  filter?: ReadonlyMap<string, FilterEntry>;
  commit?: { gpgSign?: boolean };
  tag?: { gpgSign?: boolean };
  pack?: MutablePack;
  gc?: { auto?: number; pruneExpire?: string; cruftPacks?: boolean };
  push?: { gpgSign?: 'true' | 'false' | 'if-asked'; default?: PushDefaultMode };
  gpg?: MutableGpg;
};

// Extracted to keep `finalize` under the cognitive-complexity ceiling.
const finalizeDriverMaps = (acc: MutableParsedConfig, out: FinalizeOut): void => {
  // Stryker disable next-line EqualityOperator,ConditionalExpression: equivalent — `acc.diff` is only ever assigned after a `Map.set`, so when defined its size is always >= 1; `> 0`, `>= 0` and a constant `true` never differ.
  if (acc.diff !== undefined && acc.diff.size > 0) out.diff = acc.diff;
  // Stryker disable next-line EqualityOperator,ConditionalExpression: equivalent — `acc.filter` is only ever assigned after a `Map.set`, so when defined its size is always >= 1; `> 0`, `>= 0` and a constant `true` never differ.
  if (acc.filter !== undefined && acc.filter.size > 0) out.filter = acc.filter;
};

/**
 * Finalize `[user]`: emit only when an identity (both name+email) or a
 * signingKey was set. A signingKey-only user does NOT count as an identity —
 * author/committer resolution still requires both name and email.
 */
const finalizeUser = (
  user: { name?: string; email?: string; signingKey?: string } | undefined,
): ParsedConfig['user'] => {
  if (user === undefined) return undefined;
  const hasIdentity = user.name !== undefined && user.email !== undefined;
  if (!hasIdentity && user.signingKey === undefined) return undefined;
  return {
    ...(user.name !== undefined ? { name: user.name } : {}),
    ...(user.email !== undefined ? { email: user.email } : {}),
    ...(user.signingKey !== undefined ? { signingKey: user.signingKey } : {}),
  };
};

// `mergeCommit`/`mergeTag`/`mergePack`/`mergePush`/`mergeGpg`/`mergeGpgSsh`
// only assign their bucket after observing a recognised key, so a defined
// value is always non-empty (same invariant as `extensions`). Extracted to
// keep `finalize` under the cognitive-complexity ceiling.
const finalizeScalarBuckets = (acc: MutableParsedConfig, out: FinalizeOut): void => {
  if (acc.commit !== undefined) out.commit = acc.commit;
  if (acc.tag !== undefined) out.tag = acc.tag;
  if (acc.pack !== undefined) out.pack = acc.pack;
  if (acc.gc !== undefined) out.gc = acc.gc;
  if (acc.push !== undefined) out.push = acc.push;
  if (acc.gpg !== undefined) out.gpg = acc.gpg;
};

const finalize = (acc: MutableParsedConfig): ParsedConfig => {
  const out: {
    core?: {
      bare?: boolean;
      excludesFile?: string;
      attributesFile?: string;
      logAllRefUpdates?: boolean | 'always';
      hooksPath?: string;
      sparseCheckout?: boolean;
      sparseCheckoutCone?: boolean;
      looseCompression?: number;
      maxTreeDepth?: number;
    };
    user?: { name?: string; email?: string; signingKey?: string };
    remote?: ReadonlyMap<
      string,
      {
        url?: string;
        pushUrl?: string;
        fetch?: ReadonlyArray<string>;
        promisor?: boolean;
        partialCloneFilter?: string;
      }
    >;
    remotePushDefault?: string;
    branch?: ReadonlyMap<string, { remote?: string; merge?: string; pushRemote?: string }>;
    submodule?: ReadonlyMap<string, { url?: string; active?: boolean; update?: string }>;
    merge?: ReadonlyMap<string, { name?: string; driver?: string; recursive?: string }>;
    diff?: ReadonlyMap<string, { textconv?: string; cachetextconv?: boolean }>;
    filter?: ReadonlyMap<
      string,
      { clean?: string; smudge?: string; process?: string; required?: boolean }
    >;
    extensions?: { partialClone?: string };
    commit?: { gpgSign?: boolean };
    tag?: { gpgSign?: boolean };
    pack?: MutablePack;
    gc?: { auto?: number; pruneExpire?: string; cruftPacks?: boolean };
    push?: { gpgSign?: 'true' | 'false' | 'if-asked'; default?: PushDefaultMode };
    gpg?: MutableGpg;
  } = {};
  const core = finalizeCore(acc.core);
  if (core !== undefined) out.core = core;
  const user = finalizeUser(acc.user);
  if (user !== undefined) out.user = user;
  // Stryker disable next-line EqualityOperator,ConditionalExpression: equivalent — `acc.remote` is only ever assigned after a `Map.set`, so when defined its size is always >= 1; `> 0`, `>= 0` and a constant `true` never differ.
  if (acc.remote !== undefined && acc.remote.size > 0) out.remote = acc.remote;
  if (acc.remotePushDefault !== undefined) out.remotePushDefault = acc.remotePushDefault;
  // `mergeExtensions` only assigns `acc.extensions` after observing a
  // `partialclone` key, so a defined value is always non-empty.
  if (acc.extensions !== undefined) out.extensions = acc.extensions;
  // Stryker disable next-line EqualityOperator,ConditionalExpression: equivalent — `acc.branch` is only ever assigned after a `Map.set`, so when defined its size is always >= 1; `> 0`, `>= 0` and a constant `true` never differ.
  if (acc.branch !== undefined && acc.branch.size > 0) out.branch = acc.branch;
  // Stryker disable next-line EqualityOperator,ConditionalExpression: equivalent — `acc.submodule` is only ever assigned after a `Map.set`, so when defined its size is always >= 1; `> 0`, `>= 0` and a constant `true` never differ.
  if (acc.submodule !== undefined && acc.submodule.size > 0) out.submodule = acc.submodule;
  // Stryker disable next-line EqualityOperator,ConditionalExpression: equivalent — `acc.merge` is only ever assigned after a `Map.set`, so when defined its size is always >= 1; `> 0`, `>= 0` and a constant `true` never differ.
  if (acc.merge !== undefined && acc.merge.size > 0) out.merge = acc.merge;
  finalizeDriverMaps(acc, out);
  finalizeScalarBuckets(acc, out);
  return out;
};

/** One invalid boolean entry returned by `findFirstInvalidBoolean` / `…InSection`. */
export interface InvalidBooleanEntry {
  readonly key: string;
  readonly source: string;
  readonly line: number;
  readonly value: string;
}

/**
 * The one token walk behind every invalid-boolean finder: file-order scan of the
 * cached tokens, returning the FIRST entry among `keys` whose value the target's
 * `accepts` predicate rejects. A valueless entry (git's internal NULL) is always
 * valid, so it is never reported. The qualified key is built exactly as
 * `findFirstValuelessEntry` builds it (section and key lower-cased, subsection
 * verbatim), unless the target pins a `fixedKey` (the tri-state singletons).
 */
interface BooleanWalkTarget {
  readonly section: string;
  /** Exact subsection to match; ignored when `anySubsection` is set. */
  readonly subsection?: string | undefined;
  /** Scan every subsection of `section` (the per-instance families). */
  readonly anySubsection?: boolean;
  /** Wildcard scans only: skip entries under a subsectionless header. */
  readonly requireSubsection?: boolean;
  readonly keys: ReadonlyArray<string>;
  readonly accepts: (value: string) => boolean;
  readonly fixedKey?: string;
}

const headerEntersTarget = (
  section: string,
  subsection: string | undefined,
  target: BooleanWalkTarget,
): boolean =>
  target.anySubsection === true
    ? section.toLowerCase() === target.section.toLowerCase()
    : matchesSection(section, subsection, target.section, target.subsection);

const entryValueRejected = (
  value: string | null,
  key: string,
  subsection: string | undefined,
  target: BooleanWalkTarget,
  keySet: ReadonlySet<string>,
): value is string => {
  if (value === null) return false;
  if (target.requireSubsection === true && subsection === undefined) return false;
  if (!keySet.has(key.toLowerCase())) return false;
  return !target.accepts(value);
};

const qualifiedBooleanKey = (
  key: string,
  subsection: string | undefined,
  target: BooleanWalkTarget,
): string => {
  if (target.fixedKey !== undefined) return target.fixedKey;
  const loweredSection = target.section.toLowerCase();
  const loweredKey = key.toLowerCase();
  return subsection === undefined
    ? `${loweredSection}.${loweredKey}`
    : `${loweredSection}.${subsection}.${loweredKey}`;
};

const findFirstRejectedBoolean = async (
  ctx: Context,
  target: BooleanWalkTarget,
): Promise<InvalidBooleanEntry | undefined> => {
  const { tokens, source: path } = await readConfigEntry(ctx);
  const keySet = new Set(target.keys.map((k) => k.toLowerCase()));
  let subsection: string | undefined;
  let inSection = false;
  for (const token of tokens) {
    if (token.kind === 'header') {
      subsection = token.subsection;
      inSection = headerEntersTarget(token.section, token.subsection, target);
      continue;
    }
    if (!inSection || token.kind !== 'entry') continue;
    const value = token.value;
    if (!entryValueRejected(value, token.key, subsection, target, keySet)) continue;
    return {
      key: qualifiedBooleanKey(token.key, subsection, target),
      source: path,
      line: token.startLine + 1,
      value,
    };
  }
  return undefined;
};

const acceptsGitBoolean = (value: string): boolean => parseGitBoolean(value).ok;

/**
 * Cold-path detection: the FIRST entry among `keys` under `[<section> "<subsection>"]`
 * whose value fails `parseGitBoolean`. Mirrors `findFirstInvalidCompression`'s shape.
 */
export const findFirstInvalidBoolean = async (
  ctx: Context,
  section: string,
  subsection: string | undefined,
  keys: ReadonlyArray<string>,
): Promise<InvalidBooleanEntry | undefined> =>
  findFirstRejectedBoolean(ctx, { section, subsection, keys, accepts: acceptsGitBoolean });

/**
 * Wildcard sibling of `findFirstInvalidBoolean`: scans every subsection of `section`
 * (mirrors `findFirstValuelessInSection`) rather than one exact subsection, for
 * per-instance families (`diff.<d>.*`, `filter.<d>.*`, `remote.<n>.*`, `submodule.<n>.*`).
 * `requireSubsection` skips subsectionless entries — git ignores `[diff] cachetextconv`,
 * `[filter] required` and `[submodule] active`, but refuses `[remote] promisor`, so each
 * family passes what its own git behaviour pins.
 */
export const findFirstInvalidBooleanInSection = async (
  ctx: Context,
  section: string,
  keys: ReadonlyArray<string>,
  { requireSubsection = false }: { readonly requireSubsection?: boolean } = {},
): Promise<InvalidBooleanEntry | undefined> =>
  findFirstRejectedBoolean(ctx, {
    section,
    anySubsection: true,
    requireSubsection,
    keys,
    accepts: acceptsGitBoolean,
  });

/**
 * `core.logAllRefUpdates`-specific finder: the key accepts a third literal,
 * `always`, beyond git's boolean grammar (mirrors `parseLogAllRefUpdates`'s own
 * tri-state check), so the plain boolean predicate would misreport it.
 */
export const findFirstInvalidLogAllRefUpdates = async (
  ctx: Context,
): Promise<InvalidBooleanEntry | undefined> =>
  findFirstRejectedBoolean(ctx, {
    section: 'core',
    keys: ['logallrefupdates'],
    accepts: (value) => parseLogAllRefUpdates(value) !== undefined,
    fixedKey: 'core.logallrefupdates',
  });

/**
 * `push.gpgSign`-specific finder: the key accepts a third literal, `if-asked`,
 * beyond git's boolean grammar (mirrors `parsePushGpgSign`'s own tri-state
 * check), so the plain boolean predicate would misreport it.
 */
export const findFirstInvalidPushGpgSign = async (
  ctx: Context,
): Promise<InvalidBooleanEntry | undefined> =>
  findFirstRejectedBoolean(ctx, {
    section: 'push',
    keys: ['gpgsign'],
    accepts: (value) => parsePushGpgSign(value) !== undefined,
    fixedKey: 'push.gpgsign',
  });
