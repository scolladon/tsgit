/**
 * `submodule` porcelain — the `repo.submodule.*` nested namespace.
 *
 * `list` materialises the streaming `walkSubmodules` primitive over a tree-ish
 * (mirrors `log` / `walkCommits`). The write verbs (`init` / `sync` / `deinit`)
 * operate on local state — the working-tree `.gitmodules`, `.git/config`
 * `[submodule "<name>"]` sections, and (for `deinit`) the submodule working
 * tree. Each verb is a Context-aware function returning a per-verb concrete
 * result (no discriminator); the namespace binder lives in
 * `internal/submodule-namespace.ts`.
 */
import { invalidOption, pathspecNoMatch } from '../../domain/commands/error.js';
import { type FilePath, ObjectId, type RefName } from '../../domain/objects/index.js';
import { validateRefName } from '../../domain/refs/index.js';
import { resolveSubmoduleUrl } from '../../domain/submodule/relative-url.js';
import { parseUpdateMode, type SubmoduleUpdateMode } from '../../domain/submodule/update-mode.js';
import type { Context } from '../../ports/context.js';
import { type ParsedConfig, readConfig } from '../primitives/config-read.js';
import { deriveSubmoduleContext } from '../primitives/internal/submodule-context.js';
import { type GitmodulesRow, parseGitmodules } from '../primitives/parse-gitmodules.js';
import { getRefStore } from '../primitives/ref-store.js';
import type { SubmoduleEntry } from '../primitives/types.js';
import { type ConfigOperation, updateConfigOperations } from '../primitives/update-config.js';
import { looksLikeObjectId } from '../primitives/validators.js';
import { walkSubmodules } from '../primitives/walk-submodules.js';
import { assertRepository } from './internal/repo-state.js';

export type { SubmoduleEntry };

const GITMODULES_FILE = '.gitmodules';
const HEADS_PREFIX = 'refs/heads/';
const HEAD_REF = 'HEAD' as RefName;

/** A `.gitmodules` row that is actionable by the write verbs (has a path). */
interface PathedRow extends GitmodulesRow {
  readonly path: string;
}

const hasPath = (row: GitmodulesRow): row is PathedRow => row.path !== undefined;

/** Parse the working-tree `.gitmodules`; absent file ⇒ no submodules. */
const readWorktreeGitmodules = async (ctx: Context): Promise<ReadonlyArray<GitmodulesRow>> => {
  const path = `${ctx.layout.workDir}/${GITMODULES_FILE}`;
  if (!(await ctx.fs.exists(path))) return [];
  return parseGitmodules(await ctx.fs.readUtf8(path));
};

/**
 * Validate every declared `submodule.<name>.update` up front — git parses the
 * whole `.gitmodules` before acting, so a single invalid (`!command` / unknown)
 * value refuses the command before any write. Returns the validated mode per
 * row name.
 */
const validateUpdateModes = (
  rows: ReadonlyArray<GitmodulesRow>,
): ReadonlyMap<string, SubmoduleUpdateMode> => {
  const modes = new Map<string, SubmoduleUpdateMode>();
  for (const row of rows) {
    if (row.update === undefined) continue;
    const mode = parseUpdateMode(row.update);
    if (mode === undefined) {
      throw invalidOption(`submodule.${row.name}.update`, `invalid value '${row.update}'`);
    }
    modes.set(row.name, mode);
  }
  return modes;
};

/** Select the actionable rows; with `paths`, every entry must match a submodule. */
const selectRows = (
  rows: ReadonlyArray<GitmodulesRow>,
  paths: ReadonlyArray<string> | undefined,
): ReadonlyArray<PathedRow> => {
  const pathed = rows.filter(hasPath);
  if (paths === undefined) return pathed;
  const matched = pathed.filter((row) => paths.includes(row.path));
  const matchedPaths = new Set(matched.map((row) => row.path));
  for (const path of paths) {
    if (!matchedPaths.has(path)) throw pathspecNoMatch(path);
  }
  return matched;
};

/**
 * The base URL relative `.gitmodules` URLs resolve against: the current
 * branch's upstream remote (`branch.<HEAD>.remote`, default `origin`) URL,
 * falling back to the superproject's worktree path when no remote URL is set
 * (git's "own authoritative upstream").
 */
const resolveBaseUrl = async (ctx: Context, config: ParsedConfig): Promise<string> => {
  const head = await getRefStore(ctx).resolveDirect(HEAD_REF);
  const branch =
    head.kind === 'symbolic' && head.target.startsWith(HEADS_PREFIX)
      ? head.target.slice(HEADS_PREFIX.length)
      : undefined;
  const remoteName =
    (branch !== undefined ? config.branch?.get(branch)?.remote : undefined) ?? 'origin';
  return config.remote?.get(remoteName)?.url ?? ctx.layout.workDir;
};

/**
 * `set`/`appendEntry` insert a fresh key right after the section header, so a
 * forward sequence of ops on a new section reverses the key order. Emit them
 * in reverse (`update`, `url`, `active`) so the file ends up in git's order:
 * `active`, `url`, `update`.
 */
const registerOps = (
  name: string,
  url: string,
  update: SubmoduleUpdateMode | undefined,
): ReadonlyArray<ConfigOperation> => {
  const set = (key: string, value: string): ConfigOperation => ({
    kind: 'set',
    section: 'submodule',
    subsection: name,
    key,
    value,
  });
  const ordered: ConfigOperation[] = [set('active', 'true'), set('url', url)];
  if (update !== undefined) ordered.push(set('update', update));
  return [...ordered].reverse();
};

export interface SubmoduleInitOptions {
  /** Submodule paths to register. Default: every submodule in `.gitmodules`. */
  readonly paths?: ReadonlyArray<string>;
}

export interface SubmoduleInitEntry {
  readonly name: string;
  readonly path: FilePath;
  /** Resolved URL now in `.git/config` (newly written, or the preserved existing value). */
  readonly url: string;
  /** True when this call wrote the registration; false when it was already registered. */
  readonly registered: boolean;
  readonly update?: SubmoduleUpdateMode;
}

export interface SubmoduleInitResult {
  readonly entries: ReadonlyArray<SubmoduleInitEntry>;
}

/**
 * Register submodules into `.git/config` (`git submodule init`). For each
 * un-registered submodule (no `submodule.<name>.url` in config) writes
 * `active = true`, the resolved `url`, and (when declared) a validated
 * `update` mode, in git's key order. An already-registered submodule keeps its
 * url untouched (`registered: false`). Relative `.gitmodules` URLs resolve
 * against the superproject's default-remote URL.
 */
export const submoduleInit = async (
  ctx: Context,
  opts: SubmoduleInitOptions = {},
): Promise<SubmoduleInitResult> => {
  await assertRepository(ctx);
  const rows = await readWorktreeGitmodules(ctx);
  const updateModes = validateUpdateModes(rows);
  const selected = selectRows(rows, opts.paths);
  const config = await readConfig(ctx);
  const base = await resolveBaseUrl(ctx, config);
  const entries: SubmoduleInitEntry[] = [];
  const ops: ConfigOperation[] = [];
  for (const row of selected) {
    if (row.url === undefined) continue;
    const path = row.path as FilePath;
    const update = updateModes.get(row.name);
    const existing = config.submodule?.get(row.name)?.url;
    if (existing !== undefined) {
      entries.push({
        name: row.name,
        path,
        url: existing,
        registered: false,
        ...(update !== undefined ? { update } : {}),
      });
      continue;
    }
    const url = resolveSubmoduleUrl(base, row.url);
    ops.push(...registerOps(row.name, url, update));
    entries.push({
      name: row.name,
      path,
      url,
      registered: true,
      ...(update !== undefined ? { update } : {}),
    });
  }
  if (ops.length > 0) await updateConfigOperations(ctx, ops);
  return { entries };
};

export interface SubmoduleSyncOptions {
  /** Submodule paths to sync. Default: every initialised submodule. */
  readonly paths?: ReadonlyArray<string>;
}

export interface SubmoduleSyncEntry {
  readonly name: string;
  readonly path: FilePath;
  /** Resolved URL written to `submodule.<name>.url`. */
  readonly url: string;
  /** True when the checked-out submodule's own `remote.origin.url` was updated too. */
  readonly syncedRemote: boolean;
}

export interface SubmoduleSyncResult {
  readonly entries: ReadonlyArray<SubmoduleSyncEntry>;
}

/** Update a checked-out submodule's own `remote.origin.url`; false when absent. */
const syncSubmoduleRemote = async (
  ctx: Context,
  name: string,
  path: FilePath,
  url: string,
): Promise<boolean> => {
  const child = await deriveSubmoduleContext(ctx, name, path);
  if (child === undefined) return false;
  await updateConfigOperations(child, [
    { kind: 'set', section: 'remote', subsection: 'origin', key: 'url', value: url },
  ]);
  return true;
};

/**
 * Re-point configured submodule URLs from `.gitmodules` (`git submodule sync`).
 * Operates only on **initialised** submodules (those already carrying
 * `submodule.<name>.url` in config); a fresh clone with nothing initialised is a
 * no-op. Overwrites `submodule.<name>.url` with the freshly resolved URL and,
 * when the submodule is checked out, its own `remote.origin.url`.
 */
export const submoduleSync = async (
  ctx: Context,
  opts: SubmoduleSyncOptions = {},
): Promise<SubmoduleSyncResult> => {
  await assertRepository(ctx);
  const selected = selectRows(await readWorktreeGitmodules(ctx), opts.paths);
  const config = await readConfig(ctx);
  const base = await resolveBaseUrl(ctx, config);
  const entries: SubmoduleSyncEntry[] = [];
  const ops: ConfigOperation[] = [];
  for (const row of selected) {
    if (row.url === undefined) continue;
    if (config.submodule?.get(row.name)?.url === undefined) continue;
    const path = row.path as FilePath;
    const url = resolveSubmoduleUrl(base, row.url);
    ops.push({ kind: 'set', section: 'submodule', subsection: row.name, key: 'url', value: url });
    const syncedRemote = await syncSubmoduleRemote(ctx, row.name, path, url);
    entries.push({ name: row.name, path, url, syncedRemote });
  }
  if (ops.length > 0) await updateConfigOperations(ctx, ops);
  return { entries };
};

export interface SubmoduleListOptions {
  /** Tree-ish to walk. Default: `'HEAD'`. */
  readonly ref?: string;
  /** Descend into nested submodules' own `.gitmodules`. Default: `false`. */
  readonly recursive?: boolean;
  /**
   * Cap on recursion depth. Default: `MAX_SUBMODULE_DEPTH`. Entries at exactly
   * this depth are yielded but not recursed into.
   */
  readonly maxDepth?: number;
}

export interface SubmoduleListResult {
  readonly entries: ReadonlyArray<SubmoduleEntry>;
}

const coerceRef = (ref: string): RefName | ObjectId =>
  looksLikeObjectId(ref) ? ObjectId.from(ref) : validateRefName(ref);

export const submoduleList = async (
  ctx: Context,
  opts: SubmoduleListOptions = {},
): Promise<SubmoduleListResult> => {
  await assertRepository(ctx);
  const ref = coerceRef(opts.ref ?? 'HEAD');
  const recursive = opts.recursive === true;
  const entries: SubmoduleEntry[] = [];
  for await (const entry of walkSubmodules(ctx, {
    ref,
    recursive,
    // Stryker disable next-line ConditionalExpression,ObjectLiteral: equivalent — `walkSubmodules` reads `options?.maxDepth ?? MAX_SUBMODULE_DEPTH`, so spreading `{ maxDepth: undefined }` is identical to spreading `{}`; the conditional only exists to keep the spread well-typed under `exactOptionalPropertyTypes`.
    ...(opts.maxDepth !== undefined ? { maxDepth: opts.maxDepth } : {}),
  })) {
    entries.push(entry);
  }
  return { entries };
};
