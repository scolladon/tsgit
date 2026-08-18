import type { ConfigToken, IniSection } from '../../domain/config/config-ini.js';
import {
  GIT_C_INT_MAX,
  GIT_C_INT_MIN,
  parseGitBoolean,
  parseGitInt,
  parseIniSectionsFromTokens,
  tokenizeConfig,
} from '../../domain/config/config-ini.js';
import { TsgitError } from '../../domain/error.js';
import type { Context } from '../../ports/context.js';
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
  /** `pack.writeReverseIndex` — write a sibling `.rev` beside each pack index. git defaults to true. */
  readonly pack?: { readonly writeReverseIndex?: boolean };
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
 * One read of `readConfig`, cached per `Context`: the scope-merged parse
 * (`system → global → local → worktree`, later scopes winning — see
 * `mergeConfigsByScope`), the LOCAL `${gitDir}/config` token stream, and the
 * absolute path those tokens were read from.
 *
 * `tokens`/`source` describe the LOCAL file ONLY, deliberately — the seven
 * `findFirstInvalid*`/`findLastInvalid*` finders below walk `tokens` to
 * locate a malformed entry and report `source` as its file, and the eager
 * config gate (`assertEagerConfigValid`/`assertDiscoveryBooleansValid`) must
 * keep refusing on a malformed LOCAL config exactly as it always has —
 * widening validation to scan every scope's tokens would be a behaviour
 * change these finders never asked for. `parsed`, by contrast, IS the full
 * multi-scope merge: every `readConfig` consumer sees system/global/worktree
 * values the finders never validate. A missing file at any scope is normal
 * (empty), not an error.
 */
interface ConfigCacheEntry {
  readonly parsed: ParsedConfig;
  readonly tokens: ReadonlyArray<ConfigToken>;
  readonly source: string;
}

// Cache reference is mutable so test code can swap in a fresh WeakMap and
// guarantee isolation between cases that re-use the same Context identity
// (the WeakMap itself can't be iterated, so a true reset requires replacement).
let cache: WeakMap<Context, Promise<ConfigCacheEntry>> = new WeakMap();

/**
 * Read and cache the scope-merged config (`system → global → local →
 * worktree`, matching git's own resolution order). A scope whose file is
 * missing, or whose file lives at a path this adapter cannot reach (e.g. the
 * browser adapter has no system config), contributes nothing rather than
 * erroring — mirroring `readConfig`'s long-standing "missing local file is
 * empty config" contract, now extended to every scope.
 *
 * The cache is keyed on `Context` identity; a new context (e.g., after a write
 * that re-creates the repo) gets a fresh read. Concurrent calls share the same
 * in-flight promise (per-context single-flight).
 */
export const readConfig = (ctx: Context): Promise<ParsedConfig> =>
  readConfigEntry(ctx).then((entry) => entry.parsed);

/**
 * The cache accessor: returns the per-`Context` `ConfigCacheEntry` promise,
 * single-flight (concurrent calls share the same in-flight read). Both
 * `readConfig` (`.parsed`) and the valueless finders (`.tokens`) consume it, so
 * the file is read and tokenized at most once per context until invalidated.
 */
const readConfigEntry = (ctx: Context): Promise<ConfigCacheEntry> => {
  const existing = cache.get(ctx);
  if (existing !== undefined) return existing;
  const pending = loadConfigEntry(ctx);
  cache.set(ctx, pending);
  return pending;
};

/** @internal — test-only cache reset between cases. Replaces the entire WeakMap. */
export const __resetConfigCacheForTests = (): void => {
  cache = new WeakMap();
};

/**
 * Drop the cached `readConfig` entry for a single `Context`, AND the
 * per-scope sections cache `readConfig` now builds its merged parse from
 * (`config-scoped-read.ts`'s own cache — shared with the porcelain `config`
 * command's readers) — one call invalidates both, so they can never drift
 * out of sync. The production invalidator: a config write (`updateCoreConfig`)
 * calls this so a subsequent `readConfig` on the same context re-reads
 * instead of serving the stale parse.
 */
export const invalidateConfigCache = (ctx: Context): void => {
  cache.delete(ctx);
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
 */
const loadConfigEntry = async (ctx: Context): Promise<ConfigCacheEntry> => {
  const path = `${commonGitDir(ctx)}/config`;
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
  pack?: { writeReverseIndex?: boolean };
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

const mergePack = (acc: { pack?: { writeReverseIndex?: boolean } }, sec: IniSection): void => {
  for (const { key, value } of sec.entries) {
    if (key.toLowerCase() === 'writereverseindex') {
      const parsed = parseGitBoolean(value);
      if (parsed.ok) acc.pack = { ...acc.pack, writeReverseIndex: parsed.value };
    }
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
  pack?: { writeReverseIndex?: boolean };
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
    pack?: { writeReverseIndex?: boolean };
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
