import type { PathPolicy } from '../adapters/node/path-policy.js';
import { configBadBooleanValue, configMissingValue } from '../domain/commands/error.js';
import type { ConfigToken } from '../domain/config/config-ini.js';
import { parseGitBoolean, tokenizeConfig } from '../domain/config/config-ini.js';
import {
  CORE_SECTION,
  EXTENSIONS_SECTION,
  honoursExtensions,
  lastTopLevelEntry,
  REF_STORAGE_VALUES,
  REFSTORAGE_KEY,
  type RefStorage,
  resolveEnum,
  resolveFormatVersion,
  type ScannedEntry,
  sectionedEntries,
} from '../domain/config/repository-format-scan.js';
import { repositoryExtensionUnsupported } from '../domain/repository/error.js';
import type { RepositoryFormatRefusal } from '../ports/context.js';
import type { LayoutProbe } from '../ports/layout-probe.js';

/**
 * The repository-format keys read from a gitDir's config at open time —
 * git's setup-time read, before a work tree is decided and before a Context
 * exists. `worktreeConfig` is whether `extensions.worktreeConfig` parsed as
 * true in `<commonDir>/config` (the gate for also consulting
 * `<gitDir>/config.worktree`). `objectFormat` is `extensions.objectFormat`'s
 * resolved value, defaulting to `'sha1'` when the key is absent — read from
 * `<commonDir>/config` ONLY, never scoped to `config.worktree` (unlike
 * `bare`/`worktree`). `refStorage` is `extensions.refStorage`'s resolved
 * value, defaulting to `'files'` when the key is absent — same scope, same
 * grammar shape and the same version-gating as `objectFormat` (git honours
 * `extensions.*` only from `core.repositoryformatversion` 1 up). `refusal`
 * is the repository-format acceptance verdict
 * — absent when accepted; see `RepositoryFormatRefusal`.
 */
export interface RepositoryFormat {
  readonly bare: boolean | undefined;
  readonly worktree: string | undefined;
  readonly worktreeConfig: boolean;
  readonly objectFormat: ObjectFormat;
  readonly refStorage: RefStorage;
  readonly refusal: RepositoryFormatRefusal | undefined;
}

const BARE_KEY = 'bare';
const WORKTREE_KEY = 'worktree';
const WORKTREE_CONFIG_KEY = 'worktreeconfig';
const OBJECT_FORMAT_KEY = 'objectformat';
const CONFIG_FILE = 'config';
const WORKTREE_CONFIG_FILE = 'config.worktree';

// git 2.55.0's legal `extensions.objectFormat` literals — case-sensitive,
// never touched by the key's own lower-casing. `extensions.refStorage`
// shares this exact grammar shape (`resolveEnum` below is general for it).
const OBJECT_FORMAT_VALUES = ['sha1', 'sha256'] as const;
type ObjectFormat = (typeof OBJECT_FORMAT_VALUES)[number];

// git's format gate: the effective (last-wins) core.repositoryformatversion
// must not exceed this. A named ceiling, never membership in a set — `-1` is
// accepted by `> MAX_REPOSITORY_FORMAT_VERSION` but refused by `{0, 1}`.
const MAX_REPOSITORY_FORMAT_VERSION = 1;

/**
 * One `[extensions]` entry: the reported name (`subsection === undefined ?
 * key : `${subsection}.${key}``, key ALWAYS lower-cased, subsection ALWAYS
 * verbatim), the bare lower-cased key alone (registry lookups use this and
 * only when `subsection` is `undefined`), the raw subsection, the raw
 * value, and the entry's 1-based line.
 */
export interface ExtensionEntry {
  readonly name: string;
  readonly key: string;
  readonly subsection: string | undefined;
  readonly value: string | null;
  readonly line: number;
}

/**
 * Every `[extensions]` entry in `tokens`, subsectioned ones included, in
 * file order, duplicates preserved. `lastTopLevelEntry` cannot serve here:
 * it skips subsections and keeps only the last match for one key. Exported
 * for the property-test sibling — `__resetSectionsCacheForTests` in
 * `config-scoped-read.ts` is the live precedent for a test-only `src` export.
 */
export const enumerateExtensionEntries = (
  tokens: ReadonlyArray<ConfigToken>,
): ReadonlyArray<ExtensionEntry> =>
  [...sectionedEntries(tokens)]
    .filter((entry) => entry.section === EXTENSIONS_SECTION)
    // Subsectioned entries are KEPT here, unlike the two `[core]` readers: git
    // reports `[extensions "X"] bogus` as the offending name `X.bogus`.
    .map(({ key, subsection, value, line }) => ({
      name: subsection === undefined ? key : `${subsection}.${key}`,
      key,
      subsection,
      value,
      line,
    }));

const lowerCasedSet = (names: ReadonlyArray<string>): ReadonlySet<string> =>
  new Set(names.map((name) => name.toLowerCase()));

// git 2.55.0 knows exactly these nine. This describes GIT, not tsgit's
// capabilities — it neither shrinks when tsgit lacks a name nor grows when
// tsgit gains one; only a new git release moves it.
const GIT_KNOWN_EXTENSIONS = lowerCasedSet([
  'noop',
  'noop-v1',
  'worktreeConfig',
  'preciousObjects',
  'partialClone',
  'relativeWorktrees',
  'objectFormat',
  'compatObjectFormat',
  'refStorage',
]);

// The five names git refuses at version 0.
const GIT_V1_ONLY_EXTENSIONS = lowerCasedSet([
  'noop-v1',
  'objectFormat',
  'compatObjectFormat',
  'refStorage',
  'relativeWorktrees',
]);

/**
 * Extension names git accepts that tsgit accepts at the gate but cannot yet
 * act on. Each is refused precisely at open rather than misread. DELETE an
 * entry — one array element, nothing else — the moment its support lands;
 * the entry IS the promise that nothing reads the repository wrong.
 */
const UNBACKED_EXTENSIONS: ReadonlyArray<string> = ['compatobjectformat'];

// A subsectioned spelling of a known name is not known — membership is
// keyed on the bare key only when `subsection` is `undefined`.
const isUnknownExtension = (entry: ExtensionEntry): boolean =>
  entry.subsection !== undefined || !GIT_KNOWN_EXTENSIONS.has(entry.key);

const isV1OnlyExtension = (entry: ExtensionEntry): boolean =>
  entry.subsection === undefined && GIT_V1_ONLY_EXTENSIONS.has(entry.key);

const namesWhere = (
  entries: ReadonlyArray<ExtensionEntry>,
  predicate: (entry: ExtensionEntry) => boolean,
): ReadonlyArray<string> => entries.filter(predicate).map((entry) => entry.name);

/**
 * The extensions arm — version-selected, independent of the version-ceiling
 * arm: `version === 0` refuses v1-only names, `version >= 1` refuses
 * unknown names (in practice `=== 1` here, since a caller only reaches this
 * once the version arm has already returned `undefined` for `version <=
 * MAX_REPOSITORY_FORMAT_VERSION`). A negative version refuses neither.
 */
const extensionsRefusal = (
  version: number,
  entries: ReadonlyArray<ExtensionEntry>,
): RepositoryFormatRefusal | undefined => {
  if (version === 0) {
    const names = namesWhere(entries, isV1OnlyExtension);
    return names.length > 0 ? { kind: 'extensions', version, extensions: names } : undefined;
  }
  if (version >= 1) {
    const names = namesWhere(entries, isUnknownExtension);
    return names.length > 0 ? { kind: 'extensions', version, extensions: names } : undefined;
  }
  return undefined;
};

/** The carried verdict — the version ceiling wins outright over the extension arms. */
const formatRefusal = (
  version: number | undefined,
  entries: ReadonlyArray<ExtensionEntry>,
): RepositoryFormatRefusal | undefined => {
  if (version === undefined) return undefined;
  return versionRefusal(version) ?? extensionsRefusal(version, entries);
};

/**
 * The refuse-set arm: a top-level, accepted `extensions.*` entry tsgit
 * cannot yet act on is refused precisely at open. Only reached once the
 * carried verdict has accepted the repository. Immediately before throwing
 * the refuse-set error, a malformed `extensions.worktreeConfig` in the same
 * file wins instead — that discovery-tier gate does not otherwise run until
 * first command, so this restores its precedence for this arm alone.
 */
const assertExtensionBacked = (
  version: number | undefined,
  entries: ReadonlyArray<ExtensionEntry>,
  worktreeConfigEntry: ScannedEntry | undefined,
  source: string,
): void => {
  if (version !== 1) return;
  const unbacked = entries.find(
    (entry) => entry.subsection === undefined && UNBACKED_EXTENSIONS.includes(entry.key),
  );
  if (unbacked === undefined) return;
  if (worktreeConfigEntry !== undefined && worktreeConfigEntry.value !== null) {
    const parsed = parseGitBoolean(worktreeConfigEntry.value);
    if (!parsed.ok) {
      throw configBadBooleanValue('extensions.worktreeconfig', source, worktreeConfigEntry.value);
    }
  }
  if (unbacked.value === null) {
    throw configMissingValue(`extensions.${unbacked.key}`, source, unbacked.line);
  }
  throw repositoryExtensionUnsupported(unbacked.name, unbacked.value);
};

/**
 * One config file's relevant entries, or `undefined` when absent (treated as
 * empty — not a refusal). `tokens` is the full stream, kept for the
 * streaming version-grammar scan (`resolveFormatVersion`) — only the LOCAL
 * scan's tokens are ever consulted for that; a scoped scan's tokens are
 * never passed there — the format keys, unlike `core.bare`/`core.worktree`,
 * are not scoped to `config.worktree`.
 */
interface ScannedFormat {
  readonly bare: ScannedEntry | undefined;
  readonly worktree: ScannedEntry | undefined;
  readonly worktreeConfig: ScannedEntry | undefined;
  readonly objectFormat: ScannedEntry | undefined;
  readonly refStorage: ScannedEntry | undefined;
  readonly tokens: ReadonlyArray<ConfigToken>;
}

const scanConfigFile = async (
  probe: LayoutProbe,
  path: string,
): Promise<ScannedFormat | undefined> => {
  const stat = await probe.stat(path);
  // Absent stays lenient (the init/clone bootstrap state). A NON-REGULAR
  // entry is treated as absent, never read: `readUtf8` on a planted FIFO
  // would block forever waiting for a writer — and a FIFO stats at size 0,
  // so no size test could catch it. There is deliberately NO size cap here:
  // git reads a repository config unbounded (a ~70 KiB config with a
  // thousand `[branch]` sections opens fine, measured), so the pointer-file
  // cap does not transfer — a regular file always terminates the read.
  if (stat === undefined || stat.isFile !== true) return undefined;
  const text = await probe.readUtf8(path);
  if (text === undefined) return undefined;
  const tokens = tokenizeConfig(text, path);
  return {
    bare: lastTopLevelEntry(tokens, CORE_SECTION, BARE_KEY),
    worktree: lastTopLevelEntry(tokens, CORE_SECTION, WORKTREE_KEY),
    worktreeConfig: lastTopLevelEntry(tokens, EXTENSIONS_SECTION, WORKTREE_CONFIG_KEY),
    objectFormat: lastTopLevelEntry(tokens, EXTENSIONS_SECTION, OBJECT_FORMAT_KEY),
    refStorage: lastTopLevelEntry(tokens, EXTENSIONS_SECTION, REFSTORAGE_KEY),
    tokens,
  };
};

/** The version arm of the acceptance verdict — refuse strictly above the named ceiling. */
const versionRefusal = (version: number | undefined): RepositoryFormatRefusal | undefined =>
  version !== undefined && version > MAX_REPOSITORY_FORMAT_VERSION
    ? { kind: 'version', version }
    : undefined;

/** `core.bare`'s resolved value, throwing `CONFIG_BAD_BOOLEAN_VALUE` on a malformed one. */
const resolveBare = (entry: ScannedEntry | undefined, source: string): boolean | undefined => {
  if (entry === undefined) return undefined;
  if (entry.value === null) return true; // valueless is git's internal NULL — boolean true
  const parsed = parseGitBoolean(entry.value);
  if (!parsed.ok) throw configBadBooleanValue('core.bare', source, entry.value);
  return parsed.value;
};

/** `core.worktree`'s resolved value, throwing `CONFIG_MISSING_VALUE` on a valueless one. */
const resolveWorktree = (entry: ScannedEntry | undefined, source: string): string | undefined => {
  if (entry === undefined) return undefined;
  if (entry.value === null) throw configMissingValue('core.worktree', source, entry.line);
  return entry.value;
};

const isWorktreeConfigActive = (entry: ScannedEntry | undefined): boolean => {
  if (entry === undefined) return false;
  const parsed = parseGitBoolean(entry.value);
  // A value git's boolean grammar refuses is inert here — the discovery-tier
  // gate elsewhere is what raises it on every command, and runs independently.
  return parsed.ok && parsed.value;
};

/**
 * Reads the repository-format keys — `core.bare`, `core.worktree`,
 * `extensions.worktreeConfig`, `extensions.objectFormat`,
 * `extensions.refStorage`, `core.repositoryformatversion` — from
 * `<commonDir>/config`, and, when that file sets `extensions.worktreeConfig`
 * true, ALSO from `<gitDir>/config.worktree`, whose `core.bare`/
 * `core.worktree` win when present. No global, no system, no `include.path`
 * expansion. `core.repositoryformatversion`, `extensions.objectFormat` and
 * `extensions.refStorage` are read ONLY from `<commonDir>/config` — unlike
 * `core.bare`/`core.worktree`, none of the three is ever scoped to
 * `config.worktree`. Everything else in the file is validated later, on
 * first command, by the existing two-tier eager gates.
 *
 * Throws, in order: `CONFIG_BAD_NUMERIC_VALUE` for a malformed
 * `core.repositoryformatversion` occurrence, `CONFIG_BAD_BOOLEAN_VALUE` for
 * a malformed `core.bare`, `CONFIG_MISSING_VALUE` for a valueless
 * `core.worktree`, and `CONFIG_INVALID_ENUM_VALUE` — or, for a valueless
 * entry, `CONFIG_MISSING_VALUE` again — for an out-of-grammar
 * `extensions.objectFormat` or `extensions.refStorage` — git's setup-time
 * refusals, now surfacing at `openRepository` rather than the first command.
 * Both enum keys' grammar checks run unconditionally, ahead of every
 * acceptance-gate verdict below them (measured: git rejects a malformed
 * value even at an unsupported `core.repositoryformatversion`). A version
 * ABOVE the supported ceiling is not thrown here — it is carried on
 * `refusal`, since `core.bare`/
 * `core.worktree`/`extensions.objectFormat`/`extensions.refStorage` still
 * need resolving either way.
 * An absent or non-regular config file behaves as empty, never as a
 * refusal: discovery must stay lenient so `init`/`clone` can bootstrap into
 * a gitDir that is not yet a repository.
 */
export const readRepositoryFormat = async (
  probe: LayoutProbe,
  gitDir: string,
  commonDir: string,
  pathPolicy: PathPolicy,
): Promise<RepositoryFormat> => {
  const localPath = pathPolicy.join(commonDir, CONFIG_FILE);
  const local = await scanConfigFile(probe, localPath);
  const version = resolveFormatVersion(local?.tokens ?? [], localPath);
  const worktreeConfig = isWorktreeConfigActive(local?.worktreeConfig);
  const scopedPath = pathPolicy.join(gitDir, WORKTREE_CONFIG_FILE);
  const scoped = worktreeConfig ? await scanConfigFile(probe, scopedPath) : undefined;
  const bare = pickScoped(local?.bare, localPath, scoped?.bare, scopedPath);
  const worktree = pickScoped(local?.worktree, localPath, scoped?.worktree, scopedPath);
  const resolvedBare = resolveBare(bare.entry, bare.source);
  const resolvedWorktree = resolveWorktree(worktree.entry, worktree.source);
  // The value GRAMMAR is checked at every version; the extension is only
  // HONOURED from version 1 up. Measured on git 2.55.0: with no
  // `core.repositoryformatversion` key, `extensions.objectFormat = sha256`
  // parses, is ignored, and `rev-parse --show-object-format` reports `sha1` —
  // while an INVALID value at that same absent version still refuses. So the
  // resolve runs unconditionally and only its ADOPTION is version-gated;
  // gating the resolve itself would silently accept a malformed value, and
  // adopting it ungated would read a repository git reads as SHA-1 at the
  // wrong width.
  const declaredObjectFormat = resolveEnum(
    local?.objectFormat,
    localPath,
    `${EXTENSIONS_SECTION}.${OBJECT_FORMAT_KEY}`,
    OBJECT_FORMAT_VALUES,
    'sha1',
  );
  const objectFormat = honoursExtensions(version) ? declaredObjectFormat : 'sha1';
  const declaredRefStorage = resolveEnum(
    local?.refStorage,
    localPath,
    `${EXTENSIONS_SECTION}.${REFSTORAGE_KEY}`,
    REF_STORAGE_VALUES,
    'files',
  );
  const refStorage = honoursExtensions(version) ? declaredRefStorage : 'files';
  const extensions = enumerateExtensionEntries(local?.tokens ?? []);
  const refusal = formatRefusal(version, extensions);
  if (refusal === undefined) {
    assertExtensionBacked(version, extensions, local?.worktreeConfig, localPath);
  }
  return {
    bare: resolvedBare,
    worktree: resolvedWorktree,
    worktreeConfig,
    objectFormat,
    refStorage,
    refusal,
  };
};

/** A key's winning entry with the file it came from — scoped (`config.worktree`) wins when present. */
interface AttributedEntry {
  readonly entry: ScannedEntry | undefined;
  readonly source: string;
}

const pickScoped = (
  base: ScannedEntry | undefined,
  basePath: string,
  scoped: ScannedEntry | undefined,
  scopedPath: string,
): AttributedEntry =>
  scoped !== undefined ? { entry: scoped, source: scopedPath } : { entry: base, source: basePath };
