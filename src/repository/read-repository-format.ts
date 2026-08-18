import type { PathPolicy } from '../adapters/node/path-policy.js';
import { configBadBooleanValue, configMissingValue } from '../domain/commands/error.js';
import type { ConfigToken } from '../domain/config/config-ini.js';
import { parseGitBoolean, tokenizeConfig } from '../domain/config/config-ini.js';
import type { LayoutProbe } from '../ports/layout-probe.js';

/**
 * The repository-format keys read from a gitDir's config at open time —
 * git's setup-time read, before a work tree is decided and before a Context
 * exists. `worktreeConfig` is whether `extensions.worktreeConfig` parsed as
 * true in `<commonDir>/config` (the gate for also consulting
 * `<gitDir>/config.worktree`).
 */
export interface RepositoryFormat {
  readonly bare: boolean | undefined;
  readonly worktree: string | undefined;
  readonly worktreeConfig: boolean;
}

const CORE_SECTION = 'core';
const EXTENSIONS_SECTION = 'extensions';
const BARE_KEY = 'bare';
const WORKTREE_KEY = 'worktree';
const WORKTREE_CONFIG_KEY = 'worktreeconfig';
const CONFIG_FILE = 'config';
const WORKTREE_CONFIG_FILE = 'config.worktree';

/** One scalar key's raw value, as last seen in file order (git's last-wins resolution). */
interface ScannedEntry {
  readonly value: string | null;
  readonly line: number;
}

/**
 * Scans `tokens` for the LAST top-level (no subsection) entry under
 * `[section] key`, case-insensitively on both — git's scalar-value
 * resolution is last-occurrence-wins within one file.
 */
const lastTopLevelEntry = (
  tokens: ReadonlyArray<ConfigToken>,
  section: string,
  key: string,
): ScannedEntry | undefined => {
  // Stryker disable next-line StringLiteral: equivalent — `lastTopLevelEntry` is only ever called with `section` = 'core' or 'extensions' (both non-empty), and the tokenizer emits `entry` tokens even for lines before any header, so a mutated initial value is compared only against those two literals — never observable regardless of its content.
  let currentSection = '';
  let currentSubsection: string | undefined;
  let found: ScannedEntry | undefined;
  for (const token of tokens) {
    if (token.kind === 'header') {
      currentSection = token.section.toLowerCase();
      currentSubsection = token.subsection;
      continue;
    }
    if (token.kind !== 'entry') continue;
    if (currentSubsection !== undefined) continue;
    if (currentSection !== section) continue;
    if (token.key.toLowerCase() !== key) continue;
    // `startLine` is the 0-based array index into the tokenizer's line
    // split; git's config line numbers (and `configMissingValue`'s `line`
    // field) are 1-based.
    found = { value: token.value, line: token.startLine + 1 };
  }
  return found;
};

/** One config file's relevant entries, or `undefined` when absent (treated as empty — not a refusal). */
interface ScannedFormat {
  readonly bare: ScannedEntry | undefined;
  readonly worktree: ScannedEntry | undefined;
  readonly worktreeConfig: ScannedEntry | undefined;
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
  };
};

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
 * `extensions.worktreeConfig` — from `<commonDir>/config`, and, when that
 * file sets `extensions.worktreeConfig` true, ALSO from
 * `<gitDir>/config.worktree`, whose `core.bare`/`core.worktree` win when
 * present. No global, no system, no `include.path` expansion — only these
 * three keys are extracted; everything else in the file is validated later,
 * on first command, by the existing two-tier eager gates.
 *
 * Throws `CONFIG_BAD_BOOLEAN_VALUE` for a malformed `core.bare` and
 * `CONFIG_MISSING_VALUE` for a valueless `core.worktree` — git's setup-time
 * refusals, now surfacing at `openRepository` rather than the first command.
 * An absent or non-regular config file behaves as empty, never as a refusal:
 * discovery must stay lenient so `init`/`clone` can bootstrap into a gitDir
 * that is not yet a repository.
 */
export const readRepositoryFormat = async (
  probe: LayoutProbe,
  gitDir: string,
  commonDir: string,
  pathPolicy: PathPolicy,
): Promise<RepositoryFormat> => {
  const localPath = pathPolicy.join(commonDir, CONFIG_FILE);
  const local = await scanConfigFile(probe, localPath);
  const worktreeConfig = isWorktreeConfigActive(local?.worktreeConfig);
  const scopedPath = pathPolicy.join(gitDir, WORKTREE_CONFIG_FILE);
  const scoped = worktreeConfig ? await scanConfigFile(probe, scopedPath) : undefined;
  const bare = pickScoped(local?.bare, localPath, scoped?.bare, scopedPath);
  const worktree = pickScoped(local?.worktree, localPath, scoped?.worktree, scopedPath);
  return {
    bare: resolveBare(bare.entry, bare.source),
    worktree: resolveWorktree(worktree.entry, worktree.source),
    worktreeConfig,
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
