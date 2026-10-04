import { pathspecOutsideRepo, revparseUnresolved } from '../../domain/commands/error.js';
import { applyGraft } from '../../domain/commit/graft.js';
import { errorDataCode } from '../../domain/error-data-code.js';
import type { Commit } from '../../domain/objects/commit.js';
import { objectNotFound } from '../../domain/objects/error.js';
import {
  type FilePath,
  type GitObject,
  type HashConfig,
  type ObjectId,
  type RefName,
  zeroOid,
} from '../../domain/objects/index.js';
import { normalizePathCopy } from '../../domain/path/normalize-path-copy.js';
import { parseApproxidate } from '../../domain/reflog/approxidate.js';
import { reflogEntryOutOfRange } from '../../domain/reflog/error.js';
import type { ReflogEntry } from '../../domain/reflog/reflog-entry.js';
import { refCandidates, validateRefName } from '../../domain/refs/index.js';
import { workTreeRequired } from '../../domain/repository/error.js';
import type { Context } from '../../ports/context.js';
import { lookupCommitReference } from '../primitives/internal/lookup-commit-reference.js';
import { peel } from '../primitives/internal/peel.js';
import { assertRepoSettingsValid } from '../primitives/internal/repo-settings-gate.js';
import { descendTreePath } from '../primitives/internal/resolve-tree-path.js';
import { loadShallowSet } from '../primitives/internal/shallow-set.js';
import { mergeBase } from '../primitives/merge-base.js';
import { readIndex } from '../primitives/read-index.js';
import { readObject } from '../primitives/read-object.js';
import { readTree } from '../primitives/read-tree.js';
import { listReflogs, readReflogLenient } from '../primitives/reflog-store.js';
import type { CandidateFilter } from '../primitives/resolve-oid-prefix.js';
import { readRefCandidate } from '../primitives/resolve-ref.js';
import { searchCommitMessages, searchRefMessages } from './internal/commit-message-search.js';
import { committishFilter } from './internal/disambiguate-committish.js';
import { namesNoObject, rereadsMisspeltRevision } from './internal/misspelt-revision.js';
import { readCandidateRef, resolveAmbiguousLadder } from './internal/refname-ambiguity.js';
import { assertOperationalRepository } from './internal/repo-state.js';
import { differenceSides } from './internal/rev-parse-difference.js';
import {
  type PeelTarget,
  parseExpression,
  type ReflogSelector,
  type RevExpression,
  type RevOperation,
} from './internal/rev-parse-grammar.js';
import { resolveRevisionName } from './internal/revision-name.js';

/** One revision `git rev-parse` prints: its object, `negated` where git prefixes `^`. */
export interface RevParseEntry {
  readonly id: ObjectId;
  readonly negated: boolean;
}

const NEGATION = '^';

const included = (id: ObjectId): RevParseEntry => ({ id, negated: false });
const excluded = (id: ObjectId): RevParseEntry => ({ id, negated: true });

/**
 * `git rev-parse <arg>`: every revision git prints for the argument, in its
 * order. An argument holding `..` whose sides both name objects is a range —
 * `A..B` answers B then ^A, `A...B` B, A, then ^ each merge base; otherwise
 * the argument names one object, excluded when spelt `^<rev>`.
 */
export const revParse = async (
  ctx: Context,
  expression: string,
): Promise<ReadonlyArray<RevParseEntry>> => {
  const range = await tryDifference(ctx, expression);
  if (range !== undefined) return range;
  const negated = expression.startsWith(NEGATION);
  const name = negated ? expression.slice(NEGATION.length) : expression;
  const id = await readNamedObject(ctx, name, expression);
  return [negated ? excluded(id) : included(id)];
};

/**
 * The single object a `setup_revisions` reader takes from `expression`: an
 * expression holding `..` has its sides read first, as git tries it as a
 * range, then the whole is read as one name.
 */
export const resolveRevision = async (ctx: Context, expression: string): Promise<ObjectId> => {
  await readDifferenceSides(ctx, expression);
  return readNamedObject(ctx, expression, expression);
};

/**
 * `name` read once; naming no object, git's misspelt-name diagnosis of `arg`
 * re-runs `get_oid`, re-emitting each warning — unless `arg` reads as a
 * pathspec or names a working-tree path.
 */
const readNamedObject = async (ctx: Context, name: string, arg: string): Promise<ObjectId> => {
  try {
    return await evaluateRevision(ctx, name);
  } catch (error) {
    if (await rereadsMisspeltRevision(ctx, arg, error)) {
      await evaluateRevision(ctx, arg);
    }
    throw error;
  }
};

/** One side of a `..`, read commit-ish; a read that names no object is not a refusal here. */
const readSide = async (ctx: Context, side: string): Promise<ObjectId | undefined> => {
  try {
    return await evaluateRevision(ctx, side, committishFilter(ctx));
  } catch (error) {
    if (namesNoObject(error)) return undefined;
    throw error;
  }
};

/**
 * git's `handle_dotdot` reads: the side before a `..`, then the side after it
 * once the first resolves, each printing its own warnings.
 */
const readDifferenceSides = async (ctx: Context, expression: string): Promise<void> => {
  const sides = differenceSides(expression);
  if (sides === undefined) return;
  if ((await readSide(ctx, sides.start)) !== undefined) await readSide(ctx, sides.end);
};

/**
 * git rev-parse's `try_difference`: both sides named, the range's revisions;
 * a symmetric range whose sides are not both commits answers `undefined`, so
 * the whole argument is read as one name.
 */
const tryDifference = async (
  ctx: Context,
  expression: string,
): Promise<ReadonlyArray<RevParseEntry> | undefined> => {
  const sides = differenceSides(expression);
  if (sides === undefined) return undefined;
  const start = await readSide(ctx, sides.start);
  if (start === undefined) return undefined;
  const end = await readSide(ctx, sides.end);
  if (end === undefined) return undefined;
  if (!sides.symmetric) return [included(end), excluded(start)];
  return symmetricDifference(ctx, start, end);
};

const symmetricDifference = async (
  ctx: Context,
  start: ObjectId,
  end: ObjectId,
): Promise<ReadonlyArray<RevParseEntry> | undefined> => {
  const a = await lookupCommitReference(ctx, start);
  const b = await lookupCommitReference(ctx, end);
  if (a === undefined || b === undefined) return undefined;
  const bases = await mergeBase(ctx, [a.id, b.id], { all: true });
  return [included(end), included(start), ...bases.map(excluded)];
};

/**
 * git's `get_oid` over one expression, read once: the commands that refuse
 * their argument without the misspelt-name diagnosis. `accepts` is the
 * caller's disambiguation hint for an abbreviated name read as is.
 */
export const evaluateRevision = async (
  ctx: Context,
  expression: string,
  accepts?: CandidateFilter,
): Promise<ObjectId> => {
  await assertOperationalRepository(ctx);
  await assertRepoSettingsValid(ctx);
  const expr = parseExpression(expression);
  return evaluate(ctx, expr, expression, accepts);
};

const evaluate = async (
  ctx: Context,
  expr: RevExpression,
  raw: string,
  accepts?: CandidateFilter,
): Promise<ObjectId> => {
  if (expr.kind === 'index-stage') {
    return resolveIndexStage(ctx, { stage: expr.stage, path: resolveRelativePath(ctx, expr.path) });
  }
  if (expr.kind === 'tree-path') {
    return resolveTreePath(ctx, expr.rev, expr.path);
  }
  if (expr.kind === 'message-search') return searchFromRefs(ctx, expr.pattern, raw);
  // `now` is read once per call so the reflog `@{date}` resolution is
  // deterministic within an evaluation; the grammar parser stays clock-free.
  const now = Math.floor(Date.now() / 1000);
  let id =
    expr.reflog !== undefined
      ? await resolveReflogBase(ctx, expr.base, expr.reflog, now, raw)
      : await resolveBase(ctx, expr.base, expr.operations.length === 0 ? accepts : undefined);
  for (const op of expr.operations) {
    id = await applyOperation(ctx, id, op);
  }
  return id;
};

const resolveBase = async (
  ctx: Context,
  base: string,
  accepts: CandidateFilter | undefined,
): Promise<ObjectId> => {
  // The shared `get_oid` ladder: a full-width oid, then the gitrevisions
  // candidate namespaces (the verbatim one also covering the `HEAD` literal),
  // then an abbreviated object id — which still throws AMBIGUOUS_OID_PREFIX
  // when the prefix matches more than one object.
  const id = await resolveRevisionName(ctx, base, accepts);
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
  if (op.kind === 'deref') return derefTags(ctx, id, op.name);
  if (op.kind === 'peel') return peelTo(ctx, id, op.target, op.name);
  if (op.kind === 'search') return searchFrom(ctx, id, op);
  const commit = await commitToWalk(ctx, id);
  if (op.kind === 'parent') return op.n === 0 ? commit.id : nthParent(ctx, commit, op.n);
  return nthAncestor(ctx, commit, op.n);
};

/** git's `peel_onion`: `^{object}` only needs the object to exist. */
const peelTo = async (
  ctx: Context,
  id: ObjectId,
  target: PeelTarget,
  name: string,
): Promise<ObjectId> => {
  if (target !== 'object') return peel(ctx, id, target, name);
  await readObject(ctx, id);
  return id;
};

/** git's `^{/<regex>}`: peel to a commit, then search back from it; `^{/}` is the commit itself. */
const searchFrom = async (
  ctx: Context,
  id: ObjectId,
  op: Extract<RevOperation, { readonly kind: 'search' }>,
): Promise<ObjectId> => {
  const peeled = await commitToWalk(ctx, await peel(ctx, id, 'commit', op.name));
  if (op.pattern === '') return peeled.id;
  const found = await searchCommitMessages(ctx, [peeled.commit], op.pattern);
  if (found === undefined) throw revparseUnresolved(op.name);
  return found;
};

const searchFromRefs = async (ctx: Context, pattern: string, raw: string): Promise<ObjectId> => {
  const found = await searchRefMessages(ctx, pattern);
  if (found === undefined) throw revparseUnresolved(raw);
  return found;
};

/** git's `deref_tag`: follow tags to the first non-tag, naming `name` when one is missing. */
const derefTags = async (ctx: Context, id: ObjectId, name: string): Promise<ObjectId> => {
  let current = await readObject(ctx, id);
  while (current.type === 'tag') {
    current = await readTagged(ctx, current.data.object, name);
  }
  return current.id;
};

const readTagged = async (ctx: Context, id: ObjectId, name: string): Promise<GitObject> => {
  try {
    return await readObject(ctx, id);
  } catch (error) {
    if (errorDataCode(error) === 'OBJECT_NOT_FOUND') {
      ctx.logger?.error?.(`missing object referenced by '${name}'`, { name, id });
    }
    throw error;
  }
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
const resolveTreePath = async (ctx: Context, rev: string, rawPath: string): Promise<ObjectId> => {
  const baseId = await evaluate(ctx, parseExpression(rev), rev);
  const path = resolveRelativePath(ctx, rawPath);
  const treeId = await peel(ctx, baseId, 'tree');
  if (path === '') return treeId;
  // `treeId` is already a tree (peeled above), so `readTree` loads it without a
  // further peel; the shared descent then walks the `/`-separated components.
  const rootTree = await readTree(ctx, treeId);
  return (await descendTreePath(ctx, rootTree, path, rev)).id;
};

const RELATIVE_PATH_PREFIXES: ReadonlyArray<string> = ['./', '../'];

/**
 * git's startup prefix: the caller's directory within the worktree,
 * `/`-terminated and empty at its root; `undefined` outside the worktree.
 */
const startupPrefix = (cwd: string, workDir: string | undefined): string | undefined => {
  if (workDir === undefined) return undefined;
  if (cwd === workDir) return '';
  const root = `${workDir}/`;
  return cwd.startsWith(root) ? `${cwd.slice(root.length)}/` : undefined;
};

/**
 * git's `resolve_relative_path`: a path spelt from `./` or `../` is taken
 * against the caller's directory within the worktree and normalised, refused
 * where there is no working tree or where it climbs out of the repository.
 */
const resolveRelativePath = (ctx: Context, path: string): string => {
  if (!RELATIVE_PATH_PREFIXES.some((prefix) => path.startsWith(prefix))) return path;
  const prefix = startupPrefix(ctx.cwd, ctx.layout.workDir);
  if (prefix === undefined) throw workTreeRequired('relative path syntax');
  const normalized = normalizePathCopy(`${prefix}${path}`);
  if (normalized === undefined) throw pathspecOutsideRepo(path as FilePath);
  return normalized;
};
