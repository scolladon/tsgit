import type { ConfigKey, ConfigScope } from '../../domain/commands/config-key.js';
import { parseConfigKey } from '../../domain/commands/config-key.js';
import { configMultipleValues } from '../../domain/commands/error.js';
import { TsgitError } from '../../domain/error.js';
import type { Context } from '../../ports/context.js';
import { type IniSection, parseIniSections } from './config-read.js';
import { collectScopedValues, collectValues } from './internal/config-key.js';
import { mergeConfigsByScope, resolveScopePath, SCOPE_ORDER } from './internal/config-scope.js';

// Per-scope sections cache, single-flight by Context identity. Lives apart from
// `readConfig`'s ParsedConfig cache (in `config-read.ts`) because the porcelain
// readers walk the raw `IniSection[]` directly; both caches share invalidation
// through `invalidateConfigCache(ctx)` which delegates to this module's
// `invalidateScopedConfigCache(ctx)`.
let sectionsCache: WeakMap<
  Context,
  Map<ConfigScope, Promise<ReadonlyArray<IniSection>>>
> = new WeakMap();

/** @internal — test-only cache reset for the per-scope readers. */
export const __resetSectionsCacheForTests = (): void => {
  sectionsCache = new WeakMap();
};

/**
 * Drop the per-scope sections cache for a single `Context`. Called by
 * `invalidateConfigCache` in `config-read.ts` so writers can invalidate both
 * caches atomically.
 */
export const invalidateScopedConfigCache = (ctx: Context): void => {
  sectionsCache.delete(ctx);
};

const getSectionsCacheBucket = (
  ctx: Context,
): Map<ConfigScope, Promise<ReadonlyArray<IniSection>>> => {
  const existing = sectionsCache.get(ctx);
  if (existing !== undefined) return existing;
  const fresh = new Map<ConfigScope, Promise<ReadonlyArray<IniSection>>>();
  sectionsCache.set(ctx, fresh);
  return fresh;
};

const readSingleScopeUncached = async (
  ctx: Context,
  scope: ConfigScope,
): Promise<ReadonlyArray<IniSection>> => {
  const path = await resolveScopePath(ctx, scope);
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

const readSingleScope = (ctx: Context, scope: ConfigScope): Promise<ReadonlyArray<IniSection>> => {
  const bucket = getSectionsCacheBucket(ctx);
  const cached = bucket.get(scope);
  if (cached !== undefined) return cached;
  const pending = readSingleScopeUncached(ctx, scope);
  bucket.set(scope, pending);
  return pending;
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
 * Per-Context, per-scope cached: a second call with the same `(ctx, scope)`
 * shares the in-flight promise of the first. `invalidateConfigCache(ctx)` (from
 * `config-read.ts`) drops the cached entries here too.
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
