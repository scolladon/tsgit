/**
 * The reftable backend's `RefStore` implementation. Every read verb answers
 * from a `loadReftableStack`-loaded stack merge view; `applyRefUpdates`
 * (the write path) is not implemented on this backend yet and refuses.
 */
import { unsupportedOperation } from '../../domain/error.js';
import type { RefName } from '../../domain/objects/index.js';
import type { ReflogEntry } from '../../domain/reflog/reflog-entry.js';
import {
  iterateReftableLogs,
  type ReftableRefValue,
  type ReftableStack,
} from '../../domain/refs/index.js';
import type { Context } from '../../ports/context.js';
import { loadReftableStack } from './load-reftable-stack.js';
import { commonGitDir, perWorktreeRefDir, reftableDir } from './path-layout.js';
import type {
  RefEntry,
  RefIntegrityFinding,
  RefStore,
  RefUpdate,
  ResolveDirectResult,
} from './ref-store.js';

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
   * Reftable records are grammar-validated at load time — a malformed
   * record throws `INVALID_REFTABLE` before the stack is even usable — so
   * there is no post-load "bad ref content" state left to report, unlike
   * the files backend's loose-file probe. Object-backing verification is a
   * separate concern this backend does not perform yet.
   */
  async function verifyIntegrity(): Promise<readonly RefIntegrityFinding[]> {
    return [];
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

  async function listReflogs(): Promise<readonly RefName[]> {
    const stacks = await everyStack();
    const names = new Set<RefName>();
    for (const stack of stacks) {
      for (const table of stack.tables) {
        for (const record of iterateReftableLogs(table)) {
          if (record.entry.kind === 'entry') names.add(record.name);
        }
      }
    }
    return [...names];
  }

  async function applyRefUpdates(_updates: readonly RefUpdate[]): Promise<void> {
    throw unsupportedOperation('reftable-write', 'reftable ref updates are not yet implemented');
  }

  return {
    resolveDirect,
    applyRefUpdates,
    listRefs,
    verifyIntegrity,
    readReflog,
    listReflogs,
  };
}
