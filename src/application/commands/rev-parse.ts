import { revparseUnresolved } from '../../domain/commands/error.js';
import { applyGraft } from '../../domain/commit/graft.js';
import { errorDataCode } from '../../domain/error-data-code.js';
import type { Commit } from '../../domain/objects/commit.js';
import { objectNotFound } from '../../domain/objects/error.js';
import {
  type HashConfig,
  type ObjectId,
  type RefName,
  zeroOid,
} from '../../domain/objects/index.js';
import { parseApproxidate } from '../../domain/reflog/approxidate.js';
import { reflogEntryOutOfRange } from '../../domain/reflog/error.js';
import type { ReflogEntry } from '../../domain/reflog/reflog-entry.js';
import { refCandidates, validateRefName } from '../../domain/refs/index.js';
import type { Context } from '../../ports/context.js';
import { lookupCommitReference } from '../primitives/internal/lookup-commit-reference.js';
import { peel } from '../primitives/internal/peel.js';
import { assertRepoSettingsValid } from '../primitives/internal/repo-settings-gate.js';
import { descendTreePath } from '../primitives/internal/resolve-tree-path.js';
import { loadShallowSet } from '../primitives/internal/shallow-set.js';
import { readIndex } from '../primitives/read-index.js';
import { readObject } from '../primitives/read-object.js';
import { readTree } from '../primitives/read-tree.js';
import { listReflogs, readReflogLenient } from '../primitives/reflog-store.js';
import { readRefCandidate } from '../primitives/resolve-ref.js';
import { rereadsMisspeltRevision } from './internal/misspelt-revision.js';
import { readCandidateRef, resolveAmbiguousLadder } from './internal/refname-ambiguity.js';
import { assertOperationalRepository } from './internal/repo-state.js';
import {
  parseExpression,
  type ReflogSelector,
  type RevExpression,
  type RevOperation,
} from './internal/rev-parse-grammar.js';
import { resolveRevisionName } from './internal/revision-name.js';

/**
 * `git rev-parse <rev>` (and every `setup_revisions` reader): an expression
 * that names no object is read a second time before the refusal — git's
 * misspelt-name diagnosis re-runs `get_oid`, re-emitting each warning — unless
 * the argument reads as a pathspec or names a working-tree path.
 */
export const revParse = async (ctx: Context, expression: string): Promise<ObjectId> => {
  try {
    return await evaluateRevision(ctx, expression);
  } catch (error) {
    if (await rereadsMisspeltRevision(ctx, expression, error)) {
      await evaluateRevision(ctx, expression);
    }
    throw error;
  }
};

/** git's `get_oid` over one expression, read once: the commands that refuse their argument without the misspelt-name diagnosis. */
export const evaluateRevision = async (ctx: Context, expression: string): Promise<ObjectId> => {
  await assertOperationalRepository(ctx);
  await assertRepoSettingsValid(ctx);
  const expr = parseExpression(expression);
  return evaluate(ctx, expr, expression);
};

const evaluate = async (ctx: Context, expr: RevExpression, raw: string): Promise<ObjectId> => {
  if (expr.kind === 'index-stage') {
    return resolveIndexStage(ctx, expr);
  }
  if (expr.kind === 'tree-path') {
    return resolveTreePath(ctx, expr.rev, expr.path);
  }
  // `now` is read once per call so the reflog `@{date}` resolution is
  // deterministic within an evaluation; the grammar parser stays clock-free.
  const now = Math.floor(Date.now() / 1000);
  let id =
    expr.reflog !== undefined
      ? await resolveReflogBase(ctx, expr.base, expr.reflog, now, raw)
      : await resolveBase(ctx, expr.base);
  for (const op of expr.operations) {
    id = await applyOperation(ctx, id, op);
  }
  return id;
};

const resolveBase = async (ctx: Context, base: string): Promise<ObjectId> => {
  // The shared `get_oid` ladder: a full-width oid, then the gitrevisions
  // candidate namespaces (the verbatim one also covering the `HEAD` literal),
  // then an abbreviated object id — which still throws AMBIGUOUS_OID_PREFIX
  // when the prefix matches more than one object.
  const id = await resolveRevisionName(ctx, base);
  if (id !== undefined) return id;
  throw objectNotFound(base as ObjectId);
};

/** Resolve `<base>@{<selector>}` through the reflog `get_oid_basic` picks for the base. */
const resolveReflogBase = async (
  ctx: Context,
  base: string,
  selector: ReflogSelector,
  now: number,
  raw: string,
): Promise<ObjectId> => {
  const ref = base === '' ? await currentBranchLog(ctx) : await dwimLog(ctx, base);
  if (ref === undefined) throw revparseUnresolved(raw);
  const entries = await readReflogLenient(ctx, ref);
  if (entries.length === 0) throw revparseUnresolved(raw);
  if (selector.kind === 'index') return pickByIndex(entries, selector.n, ref);
  return pickByDate(entries, selector.raw, now, raw, ctx.hashConfig);
};

/** git's `@{...}`: `dwim_ref("HEAD")`, its ambiguity warned under the empty name git passes. */
const currentBranchLog = (ctx: Context): Promise<RefName | undefined> =>
  resolveAmbiguousLadder(ctx, '', refCandidates('HEAD'), (candidate) =>
    readCandidateRef(ctx, candidate, (name) => readRefCandidate(ctx, name)),
  );

/**
 * git's `dwim_log`: each candidate namespace that resolves (quietly — a
 * dangling or broken one is skipped unwarned) and carries a reflog, its own
 * or the one of the ref its symbolic chain ends at.
 */
const dwimLog = async (ctx: Context, base: string): Promise<RefName | undefined> => {
  // Validate before any candidate reaches the filesystem: an unchecked `base`
  // carrying `..` would otherwise be probed on disk.
  const validated = validateBaseRef(base);
  const knownReflogs = new Set<string>(await listReflogs(ctx));
  const logOf = async (candidate: RefName | 'HEAD'): Promise<RefName | undefined> => {
    const outcome = await readRefCandidate(ctx, candidate);
    if (outcome.kind !== 'found') return undefined;
    if (knownReflogs.has(candidate)) return candidate as RefName;
    return knownReflogs.has(outcome.ref) ? outcome.ref : undefined;
  };
  return resolveAmbiguousLadder(ctx, base, refCandidates(validated), logOf);
};

const validateBaseRef = (base: string): RefName => {
  try {
    return validateRefName(base);
  } catch (err) {
    if (errorDataCode(err) === 'INVALID_REF') throw revparseUnresolved(base);
    throw err;
  }
};

/** `@{n}` over an oldest-first reflog: the n-th entry counted newest-first. */
const pickByIndex = (entries: ReadonlyArray<ReflogEntry>, n: number, ref: RefName): ObjectId => {
  const position = entries.length - 1 - n;
  const entry = entries[position];
  if (entry === undefined) throw reflogEntryOutOfRange(ref, n, entries.length);
  return entry.newId;
};

/**
 * `@{date}`: the newest entry at or before `target`. A target preceding the
 * oldest entry yields that entry's `oldId` — the ref's value before the log.
 */
const pickByDate = (
  entries: ReadonlyArray<ReflogEntry>,
  rawDate: string,
  now: number,
  raw: string,
  hashConfig: HashConfig,
): ObjectId => {
  const target = parseApproxidate(rawDate, now);
  if (target === undefined) throw revparseUnresolved(raw);
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i] as ReflogEntry;
    if (entry.identity.timestamp <= target) return entry.newId;
  }
  // A date before the log begins clamps to the oldest entry's pre-state;
  // when that pre-state is the null oid (the ref's creation entry) git
  // answers the entry's post-state instead (measured, git 2.55.0).
  const oldest = entries[0] as ReflogEntry;
  return oldest.oldId === zeroOid(hashConfig) ? oldest.newId : oldest.oldId;
};

const applyOperation = async (ctx: Context, id: ObjectId, op: RevOperation): Promise<ObjectId> => {
  if (op.kind === 'peel') return peel(ctx, id, op.target, op.name);
  const commit = await commitToWalk(ctx, id);
  if (op.kind === 'parent') return op.n === 0 ? commit.id : nthParent(ctx, commit, op.n);
  return nthAncestor(ctx, commit, op.n);
};

interface PeeledCommit {
  readonly id: ObjectId;
  readonly commit: Commit;
}

/** The commit `^`/`~` walk from: git's `lookup_commit_reference`, which refuses any other kind. */
const commitToWalk = async (ctx: Context, id: ObjectId): Promise<PeeledCommit> => {
  const commit = await lookupCommitReference(ctx, id);
  if (commit === undefined) throw objectNotFound(id);
  return { id: commit.id, commit };
};

const nthParent = async (ctx: Context, peeled: PeeledCommit, n: number): Promise<ObjectId> => {
  const grafted = applyGraft(peeled.commit, await loadShallowSet(ctx));
  const parent = grafted.data.parents[n - 1];
  if (parent === undefined) throw objectNotFound(peeled.id);
  return parent;
};

/** git's `get_nth_ancestor`: every hop but the last parses the commit it lands on. */
const nthAncestor = async (ctx: Context, start: PeeledCommit, n: number): Promise<ObjectId> => {
  let cur = start;
  for (let i = 1; i < n; i += 1) cur = await readCommitAt(ctx, await nthParent(ctx, cur, 1));
  return n === 0 ? cur.id : nthParent(ctx, cur, 1);
};

const readCommitAt = async (ctx: Context, id: ObjectId): Promise<PeeledCommit> => {
  const obj = await readObject(ctx, id);
  if (obj.type !== 'commit') throw objectNotFound(id);
  return { id, commit: obj };
};

const resolveIndexStage = async (
  ctx: Context,
  expr: { readonly stage: 0 | 1 | 2 | 3; readonly path: string },
): Promise<ObjectId> => {
  const index = await readIndex(ctx);
  for (const entry of index.entries) {
    if (entry.path === expr.path && entry.flags.stage === expr.stage) return entry.id;
  }
  throw objectNotFound(`${expr.stage}:${expr.path}` as ObjectId);
};

/**
 * `<tree-ish>:<path>` — resolve the left side to a tree, then descend `path`'s
 * `/`-separated components to the addressed blob/tree. An empty path returns the
 * tree itself (`HEAD:` ⇒ the root tree).
 */
const resolveTreePath = async (ctx: Context, rev: string, path: string): Promise<ObjectId> => {
  const baseId = await evaluate(ctx, parseExpression(rev), rev);
  const treeId = await peel(ctx, baseId, 'tree');
  if (path === '') return treeId;
  // `treeId` is already a tree (peeled above), so `readTree` loads it without a
  // further peel; the shared descent then walks the `/`-separated components.
  const rootTree = await readTree(ctx, treeId);
  return (await descendTreePath(ctx, rootTree, path, rev)).id;
};
