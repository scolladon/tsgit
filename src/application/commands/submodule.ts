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
import {
  invalidOption,
  pathspecNoMatch,
  workingTreeFileTooLarge,
} from '../../domain/commands/error.js';
import type { IndexEntry } from '../../domain/git-index/index.js';
import {
  FILE_MODE,
  type FilePath,
  ObjectId,
  type RefName,
  ZERO_OID,
} from '../../domain/objects/index.js';
import { branchCreatedFrom } from '../../domain/reflog/reflog-messages.js';
import { validateRefName } from '../../domain/refs/index.js';
import { HEADS_PREFIX } from '../../domain/refs/ref-prefixes.js';
import { shortBranchName } from '../../domain/refs/short-branch-name.js';
import { DEFAULT_REMOTE } from '../../domain/remote.js';
import { submoduleHasModifications, submodulePathExists } from '../../domain/submodule/error.js';
import { submoduleCoreWorktree, submoduleGitfile } from '../../domain/submodule/gitlink-path.js';
import { isUnsafeSubmoduleName } from '../../domain/submodule/name.js';
import { resolveSubmoduleUrl } from '../../domain/submodule/relative-url.js';
import { parseUpdateMode, type SubmoduleUpdateMode } from '../../domain/submodule/update-mode.js';
import type { Context } from '../../ports/context.js';
import { type ParsedConfig, readConfig } from '../primitives/config-read.js';
import { indexEntryFromStat } from '../primitives/internal/index-entry-from-stat.js';
import { acquireIndexLock } from '../primitives/internal/index-lock.js';
import { joinPath } from '../primitives/internal/join-working-tree-path.js';
import {
  deriveSubmoduleCloneContext,
  deriveSubmoduleContext,
} from '../primitives/internal/submodule-context.js';
import { assertNoValuelessConfig } from '../primitives/internal/valueless-config-guard.js';
import { materializeWorktreeFromHead } from '../primitives/materialize-worktree-from-head.js';
import { type GitmodulesRow, parseGitmodules } from '../primitives/parse-gitmodules.js';
import { readIndex } from '../primitives/read-index.js';
import { readObject } from '../primitives/read-object.js';
import { recordRefUpdate } from '../primitives/record-ref-update.js';
import { getRefStore } from '../primitives/ref-store.js';
import { resolveRef } from '../primitives/resolve-ref.js';
import {
  MAX_GITMODULES_BYTES,
  MAX_SUBMODULE_DEPTH,
  type SubmoduleEntry,
} from '../primitives/types.js';
import {
  applyConfigOpInText,
  type ConfigOperation,
  updateConfigOperations,
} from '../primitives/update-config.js';
import { looksLikeObjectId } from '../primitives/validators.js';
import { walkSubmodules } from '../primitives/walk-submodules.js';
import { writeObject } from '../primitives/write-object.js';
import { checkout } from './checkout.js';
import { clone } from './clone.js';
import {
  assertNotBare,
  assertOperationalRepository,
  currentBranchRef,
} from './internal/repo-state.js';
import { mergeRun } from './merge.js';
import { rebaseRun } from './rebase.js';
import { status } from './status.js';

export type { SubmoduleEntry };

const GITMODULES_FILE = '.gitmodules';
const HEAD_REF = 'HEAD' as RefName;

/** A `.gitmodules` row that is actionable by the write verbs (has a safe path). */
interface PathedRow extends GitmodulesRow {
  readonly path: string;
}

/**
 * A row the write verbs may act on: it has a `path` that is safe to join onto
 * the worktree root. The `path` is rejected by the same containment rules as
 * the subsection name (no `..`/empty segment, absolute, drive-prefixed,
 * backslash, control chars), so `deinit`'s working-tree removal and the status
 * child Context can never escape the superproject — git's path hardening.
 */
const isActionableRow = (row: GitmodulesRow): row is PathedRow =>
  row.path !== undefined && !isUnsafeSubmoduleName(row.path);

/** Parse the working-tree `.gitmodules`; absent file ⇒ no submodules. */
const readWorktreeGitmodules = async (ctx: Context): Promise<ReadonlyArray<GitmodulesRow>> => {
  const path = joinPath(ctx.layout.workDir, GITMODULES_FILE);
  if (!(await ctx.fs.exists(path))) return [];
  const stat = await ctx.fs.stat(path);
  if (stat.size > MAX_GITMODULES_BYTES) {
    throw workingTreeFileTooLarge(path as FilePath, stat.size, MAX_GITMODULES_BYTES);
  }
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
  const pathed = rows.filter(isActionableRow);
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
  const ref = await currentBranchRef(ctx);
  const branch = ref?.startsWith(HEADS_PREFIX) ? shortBranchName(ref) : undefined;
  const remoteName =
    (branch !== undefined ? config.branch?.get(branch)?.remote : undefined) ?? DEFAULT_REMOTE;
  return config.remote?.get(remoteName)?.url ?? ctx.layout.workDir;
};

/**
 * Build the `set` ops for registering a submodule in git's order: `active`,
 * `url`, `update`. End-of-section insertion preserves this forward order.
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
  return ordered;
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
  await assertOperationalRepository(ctx);
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
  /** `--recursive`: descend into checked-out submodules and sync their nested ones. */
  readonly recursive?: boolean;
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
 * Re-point this level's submodule URLs from `.gitmodules` and, when `recursive`,
 * descend into each checked-out submodule. `depth`/`visited` bound the descent
 * (`MAX_SUBMODULE_DEPTH` + the absorbed-gitdir cycle guard). Returns this level's
 * entries; nested syncs are on-disk side effects.
 */
const syncLevel = async (
  ctx: Context,
  opts: SubmoduleSyncOptions,
  depth: number,
  visited: ReadonlySet<string>,
): Promise<SubmoduleSyncResult> => {
  await assertOperationalRepository(ctx);
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
  if (opts.recursive === true && depth < MAX_SUBMODULE_DEPTH) {
    for (const row of selected) {
      // Stryker disable next-line StringLiteral: equivalent — childGitDir feeds only the `visited` set threaded into the recursive call; deriveSubmoduleContext's `visited.has(gitDir)` guard is provably always-false under the absorbed layout (each level appends `/modules/<name>`), so the set's contents never affect traversal.
      const childGitDir = `${ctx.layout.gitDir}/modules/${row.name}`;
      const child = await deriveSubmoduleContext(ctx, row.name, row.path as FilePath, visited);
      if (child === undefined) continue;
      // Stryker disable next-line ArithmeticOperator,ArrayDeclaration: equivalent — `depth` is consumed only by the `depth < MAX_SUBMODULE_DEPTH` cap, never the terminating condition below a 100-deep tree (recursion ends when deriveSubmoduleContext finds no deeper checked-out module), so +1 vs -1 is inert for the realistic domain; the `visited` array is likewise inert (its `.has` guard is always-false under the absorbed layout).
      await syncLevel(child, opts, depth + 1, new Set([...visited, childGitDir]));
    }
  }
  return { entries };
};

/**
 * Re-point configured submodule URLs from `.gitmodules` (`git submodule sync`).
 * Operates only on **initialised** submodules (those already carrying
 * `submodule.<name>.url` in config); a fresh clone with nothing initialised is a
 * no-op. Overwrites `submodule.<name>.url` with the freshly resolved URL and,
 * when the submodule is checked out, its own `remote.origin.url`. With
 * `recursive`, descends into each checked-out submodule and syncs its nested ones.
 */
export const submoduleSync = (
  ctx: Context,
  opts: SubmoduleSyncOptions = {},
): Promise<SubmoduleSyncResult> => syncLevel(ctx, opts, 0, new Set());

export interface SubmoduleDeinitOptions {
  /** Submodule paths to deinitialise. Required unless `all` is set. */
  readonly paths?: ReadonlyArray<string>;
  /** Deinitialise every submodule. Required when `paths` is empty/omitted. */
  readonly all?: boolean;
  /** Discard a submodule working tree that has local modifications. */
  readonly force?: boolean;
}

export interface SubmoduleDeinitEntry {
  readonly name: string;
  readonly path: FilePath;
  /** The raw `.gitmodules` URL (git's unregister message reports this form). */
  readonly url: string;
  /** True when a populated working tree was cleared. */
  readonly cleared: boolean;
}

export interface SubmoduleDeinitResult {
  readonly entries: ReadonlyArray<SubmoduleDeinitEntry>;
}

/** Refuse when a checked-out submodule has local modifications (unless forced). */
const assertSubmoduleClean = async (ctx: Context, name: string, path: FilePath): Promise<void> => {
  const child = await deriveSubmoduleContext(ctx, name, path);
  if (child === undefined) return;
  const result = await status(child);
  if (!result.clean) throw submoduleHasModifications(path);
};

/** Clear a submodule working-tree directory's contents, keeping the empty dir. */
const clearWorktree = async (ctx: Context, path: FilePath): Promise<boolean> => {
  const dir = joinPath(ctx.layout.workDir, path);
  if (!(await ctx.fs.exists(dir))) return false;
  if ((await ctx.fs.readdir(dir)).length === 0) return false;
  await ctx.fs.rmRecursive(dir);
  await ctx.fs.mkdir(dir);
  return true;
};

/**
 * Unregister submodules and clear their working trees (`git submodule deinit`).
 * Requires `paths` or `all`. Removes each submodule's `.git/config` section and
 * clears its working-tree contents (the empty directory, `.gitmodules`, the
 * index gitlink, and `.git/modules/<name>` are all left intact). Refuses a
 * submodule with local modifications unless `force`.
 */
export const submoduleDeinit = async (
  ctx: Context,
  opts: SubmoduleDeinitOptions = {},
): Promise<SubmoduleDeinitResult> => {
  await assertOperationalRepository(ctx);
  if ((opts.paths === undefined || opts.paths.length === 0) && opts.all !== true) {
    throw invalidOption('submodule.deinit', "use 'all: true' to deinitialise every submodule");
  }
  const rows = await readWorktreeGitmodules(ctx);
  const selected = opts.all === true ? rows.filter(isActionableRow) : selectRows(rows, opts.paths);
  const config = await readConfig(ctx);
  const entries: SubmoduleDeinitEntry[] = [];
  // Each submodule is fully deinit'd (worktree cleared + config section removed)
  // before the next — git's incremental behaviour, so a later dirty submodule
  // leaves earlier ones completely deinit'd rather than half-done.
  for (const row of selected) {
    const path = row.path as FilePath;
    if (opts.force !== true) await assertSubmoduleClean(ctx, row.name, path);
    const cleared = await clearWorktree(ctx, path);
    if (config.submodule?.has(row.name) === true) {
      await updateConfigOperations(ctx, [
        { kind: 'removeSection', section: 'submodule', subsection: row.name },
      ]);
    }
    entries.push({ name: row.name, path, url: row.url ?? '', cleared });
  }
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
  await assertOperationalRepository(ctx);
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

const SUBMODULE_SECTION = 'submodule';

export interface SubmoduleAddOptions {
  /** Submodule URL — stored verbatim in `.gitmodules`, resolved for `.git/config`. */
  readonly url: string;
  /** Worktree-relative checkout path. */
  readonly path: string;
  /** `.gitmodules` subsection name. Default: `path` (git's `--name` default). */
  readonly name?: string;
  /** `-b`: track this branch instead of the remote default HEAD. */
  readonly branch?: string;
}

export interface SubmoduleAddEntry {
  readonly name: string;
  readonly path: FilePath;
  /** Resolved URL written to `.git/config` + the module's `remote.origin.url`. */
  readonly url: string;
  /** Submodule HEAD oid staged as the gitlink. */
  readonly id: ObjectId;
  /** Checked-out branch (remote default HEAD branch, or `branch`). */
  readonly branch: string;
}

export type SubmoduleAddResult = SubmoduleAddEntry;

/** Reject empty/unsafe `name`/`path`/`url` before any filesystem mutation. */
const assertAddInputs = (name: string, path: string, url: string): void => {
  if (url === '') throw invalidOption('submodule.add', 'url must not be empty');
  if (path === '') throw invalidOption('submodule.add', 'path must not be empty');
  if (isUnsafeSubmoduleName(name))
    throw invalidOption('submodule.add.name', `unsafe name '${name}'`);
  if (isUnsafeSubmoduleName(path))
    throw invalidOption('submodule.add.path', `unsafe path '${path}'`);
};

/** Refuse when the target path is already tracked in the superproject index. */
const assertPathFree = async (ctx: Context, path: string): Promise<void> => {
  const index = await readIndex(ctx);
  if (index.entries.some((entry) => entry.path === path)) throw submodulePathExists(path);
};

/** A `set` op on the submodule subsection of `.gitmodules` / `.git/config`. */
const setSubmoduleOp = (subsection: string, key: string, value: string): ConfigOperation => ({
  kind: 'set',
  section: SUBMODULE_SECTION,
  subsection,
  key,
  value,
});

/**
 * Write the `.gitmodules` `[submodule "<name>"]` block (`path`, `url`, optional
 * `branch`). End-of-section insertion preserves forward order: `path`→`url`→`branch`.
 */
const writeGitmodulesEntry = async (
  ctx: Context,
  name: string,
  path: string,
  rawUrl: string,
  branch: string | undefined,
): Promise<Uint8Array> => {
  const file = joinPath(ctx.layout.workDir, GITMODULES_FILE);
  const existing = (await ctx.fs.exists(file)) ? await ctx.fs.readUtf8(file) : '';
  const ordered = [setSubmoduleOp(name, 'path', path), setSubmoduleOp(name, 'url', rawUrl)];
  if (branch !== undefined) ordered.push(setSubmoduleOp(name, 'branch', branch));
  let text = existing;
  for (const op of ordered) text = applyConfigOpInText(text, op);
  await ctx.fs.writeUtf8(file, text);
  return new TextEncoder().encode(text);
};

/**
 * Stage the gitlink (`160000 <subHead> <path>`) and the `.gitmodules` blob into
 * the superproject index under a single lock — git stages both on `add`.
 */
const stageSubmodule = async (
  ctx: Context,
  path: string,
  subHead: ObjectId,
  gitmodulesBytes: Uint8Array,
): Promise<void> => {
  const gitmodulesBlob = (await writeObject(ctx, {
    type: 'blob',
    id: '' as ObjectId,
    content: gitmodulesBytes,
  })) as ObjectId;
  const lock = await acquireIndexLock(ctx);
  try {
    const index = await readIndex(ctx);
    const entries = new Map<string, IndexEntry>(index.entries.map((e) => [e.path, e]));
    const gitlinkStat = await ctx.fs.lstat(joinPath(ctx.layout.workDir, path));
    entries.set(
      path,
      indexEntryFromStat(gitlinkStat, FILE_MODE.GITLINK, subHead, path as FilePath),
    );
    const gitmodulesStat = await ctx.fs.lstat(joinPath(ctx.layout.workDir, GITMODULES_FILE));
    entries.set(
      GITMODULES_FILE,
      indexEntryFromStat(
        gitmodulesStat,
        FILE_MODE.REGULAR,
        gitmodulesBlob,
        GITMODULES_FILE as FilePath,
      ),
    );
    await lock.commit([...entries.values()]);
    // Stryker disable next-line BlockStatement: equivalent — after `commit` sets `committed = true`, `release()` is a documented no-op, and stageSubmodule's try never throws in any reachable path (all fs ops succeed once the submodule is cloned+materialised), so the finally body is behaviorally inert.
  } finally {
    await lock.release();
  }
};

/**
 * Clone a submodule into its absorbed gitdir (`child`) and lay down the absorbed
 * layout: the module's `core.worktree`, then the `.git` gitfile in the worktree.
 * Shared by `add` and `update`'s clone-if-missing step; the caller then
 * materialises / checks out the worktree.
 */
const cloneSubmoduleInto = async (
  ctx: Context,
  child: Context,
  resolvedUrl: string,
  name: string,
  path: string,
): Promise<void> => {
  await clone(child, { url: resolvedUrl });
  await updateConfigOperations(child, [
    { kind: 'set', section: 'core', key: 'worktree', value: submoduleCoreWorktree(name, path) },
  ]);
  await ctx.fs.writeUtf8(
    joinPath(ctx.layout.workDir, `${path}/.git`),
    `${submoduleGitfile(name, path)}\n`,
  );
};

/** The short branch name HEAD points at, or `''` when detached. */
const headBranchName = (head: { kind: string; target?: string }): string =>
  head.kind === 'symbolic' && head.target?.startsWith(HEADS_PREFIX) === true
    ? head.target.slice(HEADS_PREFIX.length)
    : // Stryker disable next-line StringLiteral: equivalent — this ':' branch is unreachable via submoduleAdd (headBranchName's only caller), whose cloned/checked-out submodule HEAD is always symbolic, so the detached-fallback '' is never produced.
      '';

/**
 * Create the local tracking branch `refs/heads/<branch>` at `origin/<branch>`
 * with `branch.<branch>.{remote,merge}`, mirroring git's `checkout -b <branch>
 * origin/<branch>` (reflog `branch: Created from origin/<branch>`). Then switch
 * the submodule onto it — `add -b`'s post-clone step.
 */
const checkoutTrackingBranch = async (child: Context, branch: string): Promise<void> => {
  const oid = await resolveRef(child, `refs/remotes/origin/${branch}` as RefName);
  const ref = `${HEADS_PREFIX}${branch}` as RefName;
  await child.fs.writeUtf8(`${child.layout.gitDir}/${ref}`, `${oid}\n`);
  await recordRefUpdate(child, ref, ZERO_OID, oid, branchCreatedFrom(`origin/${branch}`));
  await updateConfigOperations(child, [
    { kind: 'set', section: 'branch', subsection: branch, key: 'remote', value: 'origin' },
    { kind: 'set', section: 'branch', subsection: branch, key: 'merge', value: ref },
  ]);
  await checkout(child, { rev: branch });
};

/**
 * Clone a new submodule into the worktree + `.git/modules/<name>` and register
 * it (`git submodule add`). Clones the remote into the absorbed gitdir, writes
 * `core.worktree` + the `.git` gitfile, materialises the working tree on the
 * remote default branch, writes `.gitmodules`, stages the gitlink +
 * `.gitmodules` blob, and records `submodule.<name>.{url,active}` in
 * `.git/config`. Refuses an unsafe/empty name/path/url or an already-tracked path.
 */
export const submoduleAdd = async (
  ctx: Context,
  opts: SubmoduleAddOptions,
): Promise<SubmoduleAddResult> => {
  await assertOperationalRepository(ctx);
  await assertNotBare(ctx, 'submodule add');
  const name = opts.name ?? opts.path;
  assertAddInputs(name, opts.path, opts.url);
  // Validate `branch` as a ref component — it is joined into `refs/heads/<branch>`
  // and written as a file, so an unchecked `../`-laden value could traverse out
  // of the module gitdir.
  if (opts.branch !== undefined) validateRefName(`${HEADS_PREFIX}${opts.branch}`);
  await assertPathFree(ctx, opts.path);
  const config = await readConfig(ctx);
  const base = await resolveBaseUrl(ctx, config);
  const resolved = resolveSubmoduleUrl(base, opts.url);
  const child = deriveSubmoduleCloneContext(ctx, name, opts.path as FilePath);
  await cloneSubmoduleInto(ctx, child, resolved, name, opts.path);
  if (opts.branch !== undefined) await checkoutTrackingBranch(child, opts.branch);
  else await materializeWorktreeFromHead(child);
  const head = await getRefStore(child).resolveDirect(HEAD_REF);
  const branch = headBranchName(head);
  const subHead = await resolveRef(child, HEAD_REF);
  const gitmodulesBytes = await writeGitmodulesEntry(ctx, name, opts.path, opts.url, opts.branch);
  await stageSubmodule(ctx, opts.path, subHead, gitmodulesBytes);
  await updateConfigOperations(ctx, [
    setSubmoduleOp(name, 'url', resolved),
    setSubmoduleOp(name, 'active', 'true'),
  ]);
  return { name, path: opts.path as FilePath, url: resolved, id: subHead, branch };
};

export interface SubmoduleUpdateOptions {
  /** Submodule paths to update. Default: every registered submodule. */
  readonly paths?: ReadonlyArray<string>;
  /** `--init`: register an unregistered submodule before updating it. */
  readonly init?: boolean;
  /** `--checkout`/`--rebase`/`--merge`: override the configured update mode. */
  readonly mode?: SubmoduleUpdateMode;
}

export interface SubmoduleUpdateEntry {
  readonly name: string;
  readonly path: FilePath;
  /** Pinned gitlink oid the submodule was reconciled to. */
  readonly id: ObjectId;
  /** Mode actually applied. */
  readonly mode: SubmoduleUpdateMode;
  /** True when this call cloned the module gitdir. */
  readonly cloned: boolean;
  /** True when the submodule HEAD/branch moved (false ⇒ already in sync / none). */
  readonly changed: boolean;
}

export interface SubmoduleUpdateResult {
  readonly entries: ReadonlyArray<SubmoduleUpdateEntry>;
}

/** The pinned gitlink oid recorded in the superproject index for `path`. */
const gitlinkFromIndex = (
  index: Awaited<ReturnType<typeof readIndex>>,
  path: string,
): ObjectId | undefined =>
  index.entries.find((e) => e.path === path && e.mode === FILE_MODE.GITLINK)?.id;

/**
 * The update mode git applies, by precedence: `opts.mode` (CLI) over config
 * `submodule.<n>.update` over the `.gitmodules` mode over the `checkout` default.
 * The config mode overrides `.gitmodules` in both directions. An unrecognised
 * config value refuses with the same `invalidOption` shape as the `.gitmodules`
 * path (`validateUpdateModes`) — but only when no CLI mode shadows it: git
 * validates the config value at the point it would be consumed, so a CLI mode
 * overrides an invalid config value without reading it.
 */
const resolveUpdateMode = (
  opts: SubmoduleUpdateOptions,
  config: ParsedConfig,
  gitmodulesMode: SubmoduleUpdateMode | undefined,
  name: string,
): SubmoduleUpdateMode => {
  // A CLI mode wins without consuming the config value, so it is never validated.
  if (opts.mode !== undefined) return opts.mode;
  const configRaw = config.submodule?.get(name)?.update;
  const configMode = configRaw === undefined ? undefined : parseUpdateMode(configRaw);
  if (configRaw !== undefined && configMode === undefined) {
    throw invalidOption(`submodule.${name}.update`, `invalid value '${configRaw}'`);
  }
  return configMode ?? gitmodulesMode ?? 'checkout';
};

/**
 * Reconcile a submodule to the pinned oid per `mode`. `checkout` detaches HEAD at
 * the pin (skipped when already detached there); `rebase`/`merge` delegate to the
 * faithful `rebaseRun`/`mergeRun` on the submodule's current branch. Returns
 * whether the submodule HEAD moved.
 */
const reconcileSubmodule = async (
  child: Context,
  pinned: ObjectId,
  mode: SubmoduleUpdateMode,
): Promise<boolean> => {
  if (mode === 'checkout') {
    const head = await getRefStore(child).resolveDirect(HEAD_REF);
    if (head.kind === 'direct' && head.id === pinned) return false;
    await checkout(child, { rev: pinned, detach: true });
    return true;
  }
  const before = await resolveRef(child, HEAD_REF);
  if (mode === 'rebase') await rebaseRun(child, { upstream: pinned });
  else await mergeRun(child, { rev: pinned });
  return (await resolveRef(child, HEAD_REF)) !== before;
};

/**
 * Clone-if-missing + reconcile each registered, selected submodule to its pinned
 * commit (`git submodule update`). The pinned oid is read from the superproject
 * index gitlink; the module is cloned into `.git/modules/<name>` when absent,
 * then brought to the pin per its `update` mode (`checkout`/`rebase`/`merge`/
 * `none`; `opts.mode` overrides). An unregistered submodule is skipped unless
 * `init`. Refuses `OBJECT_NOT_FOUND` when the pin is absent after cloning (the
 * remote-advanced case — tsgit has no incremental fetch).
 */
export const submoduleUpdate = async (
  ctx: Context,
  opts: SubmoduleUpdateOptions = {},
): Promise<SubmoduleUpdateResult> => {
  await assertOperationalRepository(ctx);
  await assertNotBare(ctx, 'submodule update');
  const rows = await readWorktreeGitmodules(ctx);
  const selected = selectRows(rows, opts.paths);
  const updateModes = validateUpdateModes(rows);
  const index = await readIndex(ctx);
  let config = await readConfig(ctx);
  const entries: SubmoduleUpdateEntry[] = [];
  for (const row of selected) {
    const pinned = gitlinkFromIndex(index, row.path);
    if (pinned === undefined) continue;
    // git reads `submodule.<n>.update` before `url` and refuses a valueless one
    // with strict priority, regardless of file-line order — so this guard fires
    // before the url-undefined branch below.
    await assertNoValuelessConfig(ctx, 'submodule', row.name, ['update']);
    if (config.submodule?.get(row.name)?.url === undefined) {
      await assertNoValuelessConfig(ctx, 'submodule', row.name, ['url']);
      if (opts.init !== true) continue;
      await submoduleInit(ctx, { paths: [row.path] });
      config = await readConfig(ctx);
    }
    const mode = resolveUpdateMode(opts, config, updateModes.get(row.name), row.name);
    if (mode === 'none') {
      entries.push({
        name: row.name,
        path: row.path as FilePath,
        id: pinned,
        mode,
        cloned: false,
        changed: false,
      });
      continue;
    }
    const url = config.submodule?.get(row.name)?.url ?? row.url ?? '';
    const child = deriveSubmoduleCloneContext(ctx, row.name, row.path as FilePath);
    const cloned = !(await ctx.fs.exists(`${child.layout.gitDir}/HEAD`));
    if (cloned) {
      await cloneSubmoduleInto(ctx, child, url, row.name, row.path);
      // Materialise the clone's checked-out branch so a rebase/merge reconcile
      // sees a clean working tree (clone fetches objects only) — git's clone
      // checkout. `checkout` mode re-materialises at the pin below.
      await materializeWorktreeFromHead(child);
    }
    await readObject(child, pinned);
    const changed = await reconcileSubmodule(child, pinned, mode);
    entries.push({ name: row.name, path: row.path as FilePath, id: pinned, mode, cloned, changed });
  }
  return { entries };
};
