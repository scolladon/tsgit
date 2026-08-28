import type { ConfigKey, ConfigScope } from '../../domain/commands/config-key.js';
import { parseConfigKey } from '../../domain/commands/config-key.js';
import { configMultipleValues, configScopeNotAvailable } from '../../domain/commands/error.js';
import { type IniSection, parseIniSections } from '../../domain/config/config-ini.js';
import { TsgitError } from '../../domain/error.js';
import type { Context } from '../../ports/context.js';
import { collectScopedValues, collectValues } from './internal/config-key.js';
import { mergeConfigsByScope, resolveScopePath, SCOPE_ORDER } from './internal/config-scope.js';
import { layoutFailsAcceptance } from './internal/layout-verdict.js';

interface CachedScopeEntry {
  readonly promise: Promise<ReadonlyArray<IniSection>>;
  readonly mtimeKey: string;
}

/** Sentinel `mtimeKey` for "the scope's file does not exist" — mirrors
 *  `config-read.ts`'s `CONFIG_ABSENT_MTIME_KEY`. */
const SCOPE_ABSENT_MTIME_KEY = 'absent';

/**
 * `${mtimeMs}:${size}` for `path`, or {@link SCOPE_ABSENT_MTIME_KEY} when it
 * does not exist — mirrors `config-read.ts`'s `configMtimeKey`. Keying the
 * cache on session+gitDir alone (below) shares it across every Context
 * derived from the same repository-open, INCLUDING a plain `{ ...ctx, x }`
 * spread that never goes through `deriveContext` — so a raw
 * `ctx.fs.writeUtf8` past the config writers' `invalidateScopedConfigCache`
 * call (the pattern most tests use to seed config) must still be observed
 * on the next read. A stat-based check is what makes that safe without
 * giving up the cross-derivation sharing this cache exists for.
 */
async function scopeFileMtimeKey(ctx: Context, path: string): Promise<string> {
  try {
    const stat = await ctx.fs.stat(path);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch (err) {
    if (err instanceof TsgitError) {
      const code = err.data.code;
      // A missing scope file is normal. A permission-denied one is too —
      // `readScopeFile` below treats both the same way (empty scope, not an
      // error); the stat must agree, or a `/etc/gitconfig`/`~/.gitconfig`
      // this adapter cannot see would throw here before ever reaching that
      // tolerant read.
      if (code === 'FILE_NOT_FOUND' || code === 'PERMISSION_DENIED') {
        return SCOPE_ABSENT_MTIME_KEY;
      }
    }
    throw err;
  }
}

/**
 * Per-scope sections cache, single-flight by `(ctx.session, ctx.layout.gitDir)`,
 * with mtime+size staleness detection on top (see `scopeFileMtimeKey`) —
 * the same latent-bug class `config-read.ts`'s `cache` closes: a pure
 * identity/session key alone would let a raw fs write past this module's
 * own invalidator keep serving a stale cached scope forever. Lives apart
 * from `readConfig`'s ParsedConfig cache (in `config-read.ts`) because the
 * porcelain readers walk the raw `IniSection[]` directly.
 *
 * `invalidateConfigCache(ctx)` (`config-read.ts`) DELEGATES to
 * `invalidateScopedConfigCache` below, so calling it alone invalidates both
 * caches. Every config writer ALSO calls `invalidateScopedConfigCache`
 * directly (see `update-config.ts` and `update-config-sections.ts`); that
 * explicit path still matters — it drops the entry NOW rather than waiting
 * for the next read to pay a stat, and it is the only signal for a
 * same-tick rewrite a millisecond-granularity mtime cannot distinguish from
 * no change at all.
 *
 * Keyed on the GITDIR, not the session alone: the `'worktree'` scope resolves
 * to `${ctx.layout.gitDir}/config.worktree` (`resolveScopePath`), which
 * genuinely differs between a repository's linked worktrees even though they
 * share one session — a pure session key would leak one worktree's
 * `config.worktree` entries into another's read. The other three scopes
 * (`system`/`global`/`local`) are commonDir-anchored and so identical across
 * every worktree of one session; bucketing by gitDir still shares them
 * correctly across every SAME-gitDir derivation (fsck's audit view, clone's
 * and bundle-verify's hash adoption). This is also why `invalidateScopedConfigCache`
 * (below) drops EVERY gitDir bucket for the session, not just the caller's
 * own: a system/global write observed through one worktree's Context must
 * not leave a SIBLING worktree's bucket serving the pre-write value, and
 * this cache has no way to tell a system/global write from a local/worktree
 * one to narrow the drop selectively.
 */
let sectionsCache: WeakMap<
  Context['session'],
  Map<string, Map<ConfigScope, CachedScopeEntry>>
> = new WeakMap();

/** @internal — test-only cache reset for the per-scope readers. */
export const __resetSectionsCacheForTests = (): void => {
  sectionsCache = new WeakMap();
};

/**
 * Drop the per-scope sections cache for an entire SESSION — every gitDir
 * bucket, not just the calling Context's own (see the cache's own docstring
 * above for why). `invalidateConfigCache` (`config-read.ts`) delegates to
 * this; every config writer also calls it directly (see `update-config.ts`
 * and `update-config-sections.ts`) for the same-tick signal a stat cannot
 * provide.
 */
export const invalidateScopedConfigCache = (ctx: Context): void => {
  sectionsCache.delete(ctx.session);
};

const getSectionsCacheBucket = (ctx: Context): Map<ConfigScope, CachedScopeEntry> => {
  let byGitDir = sectionsCache.get(ctx.session);
  if (byGitDir === undefined) {
    byGitDir = new Map();
    sectionsCache.set(ctx.session, byGitDir);
  }
  const existing = byGitDir.get(ctx.layout.gitDir);
  if (existing !== undefined) return existing;
  const fresh = new Map<ConfigScope, CachedScopeEntry>();
  byGitDir.set(ctx.layout.gitDir, fresh);
  return fresh;
};

const readScopeFile = async (ctx: Context, path: string): Promise<ReadonlyArray<IniSection>> => {
  try {
    const text = await ctx.fs.readUtf8(path);
    return parseIniSections(text, path);
  } catch (err) {
    if (err instanceof TsgitError) {
      const code = err.data.code;
      // A missing scope file is normal — git treats it as empty config. A
      // permission-denied also yields empty: in production it means the caller
      // can't see that scope's contents (treat as absent); in the memory
      // adapter it means the scope path falls outside the adapter's rootDir.
      if (code === 'FILE_NOT_FOUND' || code === 'PERMISSION_DENIED') return [];
    }
    throw err;
  }
};

/**
 * `resolveScopePath` is re-run on every call whose scope path cannot be
 * served from the mtime-checked cache below — deliberately NOT
 * single-flighted the way a resolved path's contents are. For `'worktree'`,
 * resolving the path is itself content-dependent (`isWorktreeScopeActive`
 * reads the local config to decide whether the scope exists at all), so
 * caching an "unavailable" verdict under a stable key would go stale the
 * moment a later write turns `extensions.worktreeConfig` on. The other
 * three scopes resolve their path with no I/O, so this costs nothing extra
 * for them.
 */
const readSingleScope = async (
  ctx: Context,
  scope: ConfigScope,
): Promise<ReadonlyArray<IniSection>> => {
  if (layoutFailsAcceptance(ctx.layout) && (scope === 'local' || scope === 'worktree')) {
    throw configScopeNotAvailable(scope, 'repository-not-accepted');
  }
  const path = await resolveScopePath(ctx, scope);
  const bucket = getSectionsCacheBucket(ctx);
  const mtimeKey = await scopeFileMtimeKey(ctx, path);
  const cached = bucket.get(scope);
  if (cached !== undefined && cached.mtimeKey === mtimeKey) {
    return await cached.promise;
  }
  const promise = readScopeFile(ctx, path);
  bucket.set(scope, { promise, mtimeKey });
  return await promise;
};

const safeReadScopeOrSkip = async (
  ctx: Context,
  scope: ConfigScope,
): Promise<{ scope: ConfigScope; sections: ReadonlyArray<IniSection> } | undefined> => {
  try {
    const sections = await readSingleScope(ctx, scope);
    return { scope, sections };
  } catch (err) {
    if (err instanceof TsgitError) {
      const code = err.data.code;
      if (code === 'CONFIG_SCOPE_NOT_AVAILABLE') return undefined;
      if (code === 'CONFIG_SYSTEM_PATH_UNRESOLVED') return undefined;
    }
    throw err;
  }
};

/**
 * Read the raw IniSection array for a single config scope, or a scope-tagged
 * flat array merged in precedence order (`system → global → local → worktree`)
 * when `scope` is omitted.
 *
 * Per-session-and-gitDir, per-scope cached, with mtime+size staleness
 * detection: a second call with the same `(session, gitDir, scope)` whose
 * scope file is unchanged on disk shares the in-flight promise of the
 * first. `invalidateConfigCache(ctx)` (from `config-read.ts`) DELEGATES to
 * `invalidateScopedConfigCache`, so it drops these entries too — callers
 * that write the config file should still call `invalidateScopedConfigCache(ctx)`
 * directly as well, for a same-tick rewrite the mtime check cannot
 * distinguish from no change at all.
 *
 * In the merged-read path (`scope` omitted), scopes that are unavailable on
 * the current adapter (`CONFIG_SCOPE_NOT_AVAILABLE`, `CONFIG_SYSTEM_PATH_UNRESOLVED`)
 * are silently skipped — the caller gets whatever scopes the adapter can
 * actually surface. Single-scope calls raise instead, so the caller can react
 * to a missing scope explicitly.
 */
export const readConfigSections = async ({
  ctx,
  scope,
}: {
  readonly ctx: Context;
  readonly scope?: ConfigScope;
}): Promise<ReadonlyArray<{ readonly scope: ConfigScope; readonly section: IniSection }>> => {
  if (scope !== undefined) {
    const sections = await readSingleScope(ctx, scope);
    return sections.map((section) => ({ scope, section }));
  }
  const perScope: Array<{ scope: ConfigScope; sections: ReadonlyArray<IniSection> }> = [];
  for (const s of SCOPE_ORDER) {
    const entry = await safeReadScopeOrSkip(ctx, s);
    if (entry !== undefined) perScope.push(entry);
  }
  return mergeConfigsByScope(perScope);
};

const brandKey = (raw: string): ConfigKey => raw as unknown as ConfigKey;

const collectScopedMatches = async (
  ctx: Context,
  parsedKey: ReturnType<typeof parseConfigKey>,
  scope: ConfigScope | undefined,
): Promise<ReadonlyArray<{ readonly value: string | null; readonly scope: ConfigScope }>> => {
  if (scope !== undefined) {
    const sections = await readSingleScope(ctx, scope);
    return collectValues(sections, parsedKey).map((m) => ({ value: m.value, scope }));
  }
  const merged = await readConfigSections({ ctx });
  return collectScopedValues(
    merged.map(({ scope: s, section }) => ({ scope: s, section })),
    parsedKey,
  );
};

/**
 * Look up a single value for a fully-qualified key (`section.name` or
 * `section.subsection.name`). Behaviour:
 *
 * - When `scope` is provided, reads only that scope. If the key has more than
 *   one match in that scope, throws `CONFIG_MULTIPLE_VALUES` (carries `scope`).
 * - When `scope` is omitted, merges across the four scopes. Same multi-value
 *   throw if more than one entry matches anywhere across the merged view
 *   (without the `scope` discriminator).
 * - Absent key: returns `{ key, value: undefined }`; never throws.
 * - Valueless key (no `=` in the file): returns `{ key, value: null, scope }`.
 *   `null` (present, no `=`) is distinct from `undefined` (absent) and from
 *   `''` (empty string after `key =`).
 *
 * Branding: the returned `key` is the caller's input cast to `ConfigKey`;
 * `parseConfigKey` validates the string before this cast, so the brand is
 * load-bearing only at the type level.
 */
export const getConfigValue = async ({
  ctx,
  key,
  scope,
}: {
  readonly ctx: Context;
  readonly key: string;
  readonly scope?: ConfigScope;
}): Promise<
  | { readonly key: ConfigKey; readonly value: string | null; readonly scope: ConfigScope }
  | { readonly key: ConfigKey; readonly value: undefined }
> => {
  const parsed = parseConfigKey(key);
  const matches = await collectScopedMatches(ctx, parsed, scope);
  if (matches.length === 0) return { key: brandKey(key), value: undefined };
  if (matches.length > 1) {
    throw configMultipleValues(key, matches.length, 'read', scope);
  }
  const [first] = matches;
  return {
    key: brandKey(key),
    value: (first as { value: string | null }).value,
    scope: (first as { scope: ConfigScope }).scope,
  };
};

/**
 * Look up every value for a key. Returns matches in scope-precedence order
 * (and physical-file order within each scope). Empty array when the key is
 * absent. Never throws on multi-value.
 *
 * Each `value` carries `string | null`: `null` means the entry was present
 * with no `=` (git's internal NULL); `undefined` is never in the array.
 */
export const getAllConfigValues = async ({
  ctx,
  key,
  scope,
}: {
  readonly ctx: Context;
  readonly key: string;
  readonly scope?: ConfigScope;
}): Promise<{
  readonly key: ConfigKey;
  readonly values: ReadonlyArray<{ readonly value: string | null; readonly scope: ConfigScope }>;
}> => {
  const parsed = parseConfigKey(key);
  const values = await collectScopedMatches(ctx, parsed, scope);
  return { key: brandKey(key), values };
};
