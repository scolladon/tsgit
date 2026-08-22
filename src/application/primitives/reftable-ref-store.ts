/**
 * The reftable backend's `RefStore` implementation. Every read verb answers
 * from a `loadReftableStack`-loaded stack merge view; `applyRefUpdates` (the
 * write path) commits through `reftable-transaction.ts`'s stack-lock
 * protocol.
 */
import { TsgitError } from '../../domain/error.js';
import type { RefName } from '../../domain/objects/index.js';
import type { ReflogEntry } from '../../domain/reflog/reflog-entry.js';
import {
  iterateReftableLogs,
  loadReftable,
  type ReftableCheck,
  type ReftableRefValue,
  type ReftableStack,
} from '../../domain/refs/index.js';
import type { Context } from '../../ports/context.js';
import { isDegradableReftableFault } from './internal/reftable-source.js';
import { loadReftableStack, parseTablesList } from './load-reftable-stack.js';
import { commonGitDir, perWorktreeRefDir, reftableDir } from './path-layout.js';
import type {
  PackRefsOutcome,
  RefEntry,
  RefIntegrityFinding,
  RefStore,
  RefUpdate,
  ResolveDirectResult,
} from './ref-store.js';
import { applyReftableUpdates, packReftableStack } from './reftable-transaction.js';

const TABLES_LIST_FILE = 'tables.list';

/** One finding for a table that failed a structural check — `check` is
 *  whatever the caller already extracted from the caught
 *  `INVALID_REFTABLE` error. */
function tableFinding(table: string, check: ReftableCheck): RefIntegrityFinding {
  return { table, msgId: 'badReftableTable', check };
}

/** `err.data.check` when `err` is an `INVALID_REFTABLE` `TsgitError`,
 *  `undefined` for anything else — the shared narrowing both
 *  `verifyStackTables` and `verifyOneTable` catch on. */
function invalidReftableCheck(err: unknown): ReftableCheck | undefined {
  return err instanceof TsgitError && err.data.code === 'INVALID_REFTABLE'
    ? err.data.check
    : undefined;
}

/**
 * Reads and parses one table `tables.list` names, in isolation from every
 * other table in the stack: a table that has vanished since the listing
 * read (the same compaction race `load-reftable-stack.ts` retries once
 * for) or a structural fault in its bytes both become ONE finding rather
 * than aborting the whole audit.
 */
async function verifyOneTable(
  ctx: Context,
  dir: string,
  name: string,
): Promise<RefIntegrityFinding | undefined> {
  let bytes: Uint8Array;
  try {
    bytes = await ctx.fs.read(`${dir}/${name}`);
  } catch (err) {
    if (isDegradableReftableFault(err)) return tableFinding(name, 'tables-list');
    throw err;
  }
  try {
    await loadReftable(bytes, ctx.compressor.streamInflate);
    return undefined;
  } catch (err) {
    const check = invalidReftableCheck(err);
    if (check !== undefined) return tableFinding(name, check);
    throw err;
  }
}

/**
 * One stack directory's findings. An absent `tables.list` is a
 * legitimately empty stack — no findings, mirroring `load-reftable-stack.ts`'s
 * own degrade — a malformed manifest is one finding naming the manifest
 * itself, and every table the manifest DOES name is then verified
 * independently by {@link verifyOneTable}.
 */
async function verifyStackTables(
  ctx: Context,
  dir: string,
): Promise<readonly RefIntegrityFinding[]> {
  let text: string;
  try {
    text = await ctx.fs.readUtf8(`${dir}/${TABLES_LIST_FILE}`);
  } catch (err) {
    if (isDegradableReftableFault(err)) return [];
    throw err;
  }

  let names: readonly string[];
  try {
    names = parseTablesList(text);
  } catch (err) {
    const check = invalidReftableCheck(err);
    if (check !== undefined) return [tableFinding(TABLES_LIST_FILE, check)];
    throw err;
  }

  const findings: RefIntegrityFinding[] = [];
  for (const name of names) {
    const finding = await verifyOneTable(ctx, dir, name);
    if (finding !== undefined) findings.push(finding);
  }
  return findings;
}

/** Byte-wise total order over ref names, matching git's own ref ordering —
 *  the same comparator `ref-store.ts` defines for the files backend, kept
 *  local here rather than shared across a cross-backend import for one
 *  four-line function. */
const byName = (a: RefEntry, b: RefEntry): number => {
  if (a.name < b.name) return -1;
  if (a.name > b.name) return 1;
  return 0;
};

/**
 * A live ref record's value → the backend-neutral `ResolveDirectResult`.
 * `'peeled'` collapses onto `'direct'`: this backend doesn't expose peel
 * metadata through `resolveDirect` any more than the files backend does —
 * `resolve-ref.ts`'s own peel walk re-derives it from the object store.
 */
function toResolveResult(value: ReftableRefValue): ResolveDirectResult {
  if (value.kind === 'symbolic') {
    return { kind: 'symbolic', target: value.target };
  }
  if (value.kind === 'direct' || value.kind === 'peeled') {
    return { kind: 'direct', id: value.id };
  }
  // Stryker disable next-line ObjectLiteral,StringLiteral: equivalent — `value.kind === 'deletion'` is unreachable here: this function is only ever called with a `stack.lookup()` result, and `lookupInStack` (`reftable-stack.ts`) already shadows a deletion record to `undefined` before it can reach a caller. The arm exists solely so this function stays exhaustive against `ReftableRefValue`'s full kind union.
  return { kind: 'missing' };
}

export function createReftableRefStore(ctx: Context): RefStore {
  async function stackAt(dir: string): Promise<ReftableStack> {
    return loadReftableStack(ctx, reftableDir(dir));
  }

  /** The stack that owns `name`'s record — routes exactly like the files
   *  backend's `refDir(name)`, on the same classification. */
  const stackFor = (name: RefName): Promise<ReftableStack> => stackAt(perWorktreeRefDir(ctx, name));

  /** Every stack this Context can see: the common dir's, plus a linked
   *  worktree's own when it differs from the common dir. */
  async function everyStack(): Promise<readonly ReftableStack[]> {
    const common = commonGitDir(ctx);
    const commonStack = await stackAt(common);
    if (ctx.layout.gitDir === common) return [commonStack];
    return [commonStack, await stackAt(ctx.layout.gitDir)];
  }

  /** Same set of stacks as `everyStack()`, as directory paths rather than
   *  loaded stacks — `verifyIntegrity` needs its own by-table walk, never
   *  `stackAt`'s eager, throw-on-first-fault `loadReftableStack`. */
  function stackDirs(): readonly string[] {
    const common = commonGitDir(ctx);
    const dirs = [reftableDir(common)];
    if (ctx.layout.gitDir !== common) dirs.push(reftableDir(ctx.layout.gitDir));
    return dirs;
  }

  /** `everyStack()`'s own two-dir construction, as gitDirs rather than
   *  reftable subdirectories or loaded stacks — `packRefs` runs its I/O
   *  protocol (`reftable-transaction.ts`) per gitDir, which derives its
   *  own `reftableDir` internally. */
  function gitDirs(): readonly string[] {
    const common = commonGitDir(ctx);
    return ctx.layout.gitDir === common ? [common] : [common, ctx.layout.gitDir];
  }

  async function resolveDirect(name: RefName): Promise<ResolveDirectResult> {
    const stack = await stackFor(name);
    const record = stack.lookup(name);
    return record === undefined ? { kind: 'missing' } : toResolveResult(record.value);
  }

  const matchesPrefix = (name: RefName, prefix: RefName | undefined): boolean =>
    prefix === undefined || name.startsWith(prefix);

  async function listRefs(prefix?: RefName): Promise<readonly RefEntry[]> {
    const stacks = await everyStack();
    const seen = new Set<RefName>();
    const entries: RefEntry[] = [];
    for (const stack of stacks) {
      for (const name of stack.names()) {
        if (!matchesPrefix(name, prefix) || seen.has(name)) continue;
        seen.add(name);
        const record = stack.lookup(name);
        if (record !== undefined) {
          entries.push({ name, value: toResolveResult(record.value) });
        }
      }
    }
    return entries.sort(byName);
  }

  /**
   * Backend-owned ref-content health, per `stackDirs()` (the common stack,
   * plus a linked worktree's own when it differs). Unlike `stackAt`'s eager
   * `loadReftableStack`, this never denies the whole audit for one broken
   * table: each table is read and parsed independently, so a structural
   * fault on one becomes its own `badReftableTable` finding — naming the
   * table and the failed check — and the walk continues past it. There is
   * no raw per-ref text in a reftable, so `badRefContent`'s loose-grammar
   * fault class is structurally unreachable here, and object-backing
   * verification (`badRefOid`'s reftable counterpart) is a separate
   * concern this backend does not perform yet.
   */
  async function verifyIntegrity(): Promise<readonly RefIntegrityFinding[]> {
    const findings: RefIntegrityFinding[] = [];
    for (const dir of stackDirs()) {
      findings.push(...(await verifyStackTables(ctx, dir)));
    }
    return findings;
  }

  async function readReflog(name: RefName): Promise<readonly ReflogEntry[]> {
    const stack = await stackFor(name);
    const entries: ReflogEntry[] = [];
    for (const record of stack.logs(name)) {
      if (record.entry.kind === 'entry') {
        const { oldId, newId, identity, message } = record.entry;
        // The on-disk log record's message always carries the single
        // trailing `\n` the writer appends (`canonicaliseLogMessage`); the
        // shared `ReflogEntry.message` contract is newline-free, matching
        // the files backend's own line-delimited parse.
        entries.push({ oldId, newId, identity, message: message.replace(/\n$/, '') });
      }
    }
    // `stack.logs` yields newest-first; `RefStore.readReflog` promises oldest-first.
    return entries.reverse();
  }

  /** Whether `stack.logs(name)` — already tombstone-shadowed — yields at
   *  least one live entry. A name whose raw tables carry only shadowed-away
   *  entries has no reflog at all, matching the files backend's own
   *  file-deleted-means-gone behaviour. */
  function hasLiveReflog(stack: ReftableStack, name: RefName): boolean {
    for (const _record of stack.logs(name)) return true;
    return false;
  }

  /** Every name ANY raw table in `stack` carries a log record for — a
   *  superset candidate list `hasLiveReflog` then filters down to names
   *  still live after tombstone shadowing. */
  function candidateReflogNames(stack: ReftableStack): ReadonlySet<RefName> {
    const candidates = new Set<RefName>();
    for (const table of stack.tables) {
      for (const record of iterateReftableLogs(table)) {
        candidates.add(record.name);
      }
    }
    return candidates;
  }

  /** `stack`'s own live reflog names — the candidates that survive
   *  tombstone shadowing. */
  function liveReflogNames(stack: ReftableStack): ReadonlySet<RefName> {
    const names = new Set<RefName>();
    for (const name of candidateReflogNames(stack)) {
      if (hasLiveReflog(stack, name)) names.add(name);
    }
    return names;
  }

  async function listReflogs(): Promise<readonly RefName[]> {
    const stacks = await everyStack();
    const names = new Set<RefName>();
    for (const stack of stacks) {
      for (const name of liveReflogNames(stack)) names.add(name);
    }
    return [...names];
  }

  async function applyRefUpdates(updates: readonly RefUpdate[]): Promise<void> {
    await applyReftableUpdates(ctx, updates);
  }

  /**
   * `packRefs`'s reftable-backend verb: forces a full compaction (and
   * unlinks orphaned tables) on every stack this Context can see, then
   * reports the packed ref count from a fresh `listRefs()` merge view —
   * `packReftableStack` reports only what it uniquely knows (the orphan
   * count), never a table count.
   */
  async function packRefs(): Promise<PackRefsOutcome> {
    let removedOrphanCount = 0;
    for (const dir of gitDirs()) {
      removedOrphanCount += (await packReftableStack(ctx, dir)).removedOrphanCount;
    }
    const packedRefCount = (await listRefs()).length;
    return { packedRefCount, prunedLooseRefCount: 0, removedOrphanCount };
  }

  return {
    resolveDirect,
    applyRefUpdates,
    listRefs,
    verifyIntegrity,
    readReflog,
    listReflogs,
    packRefs,
  };
}
