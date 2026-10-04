import { pathspecOutsideRepo, revparseUnresolved } from '../../domain/commands/error.js';
import { applyGraft } from '../../domain/commit/graft.js';
import { TsgitError, type TsgitErrorData } from '../../domain/error.js';
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
import type { RevParseEntry } from '../../domain/objects/rev-parse-entry.js';
import { normalizePathCopy } from '../../domain/path/normalize-path-copy.js';
import { parseApproxidate } from '../../domain/reflog/approxidate.js';
import { reflogEntryOutOfRange } from '../../domain/reflog/error.js';
import type { ReflogEntry } from '../../domain/reflog/reflog-entry.js';
import { refCandidates, validateRefName } from '../../domain/refs/index.js';
import { workTreeRequired } from '../../domain/repository/error.js';
import type { Context } from '../../ports/context.js';
import { committishFilter, treeishFilter } from '../primitives/internal/disambiguation-hints.js';
import { lookupCommitReference } from '../primitives/internal/lookup-commit-reference.js';
import {
  createObjectTypeTable,
  type ObjectTypeTable,
  parseTypedObject,
} from '../primitives/internal/object-type-table.js';
import { peel } from '../primitives/internal/peel.js';
import { assertRepoSettingsValid } from '../primitives/internal/repo-settings-gate.js';
import { descendTreePath } from '../primitives/internal/resolve-tree-path.js';
import { loadShallowSet } from '../primitives/internal/shallow-set.js';
import { mergeBasesOf } from '../primitives/merge-base.js';
import { readIndex } from '../primitives/read-index.js';
import { readObject } from '../primitives/read-object.js';
import { readTree } from '../primitives/read-tree.js';
import { listReflogs, readReflogLenient } from '../primitives/reflog-store.js';
import type { CandidateFilter } from '../primitives/resolve-oid-prefix.js';
import { readRefCandidate } from '../primitives/resolve-ref.js';
import { reportAmbiguousOid } from './internal/ambiguous-oid-report.js';
import { searchCommitMessages, searchRefMessages } from './internal/commit-message-search.js';
import {
  namesFilename,
  namesNoObject,
  rereadsMisspeltRevision,
} from './internal/misspelt-revision.js';
import { readCandidateRef, resolveAmbiguousLadder } from './internal/refname-ambiguity.js';
import { assertOperationalRepository } from './internal/repo-state.js';
import {
  type DifferenceSides,
  differenceSides,
  rangeSides,
} from './internal/rev-parse-difference.js';
import {
  isMessageSearch,
  type PeelTarget,
  parseExpression,
  type ReflogSelector,
  type RevExpression,
  type RevOperation,
} from './internal/rev-parse-grammar.js';
import { type ParentShorthand, parentShorthand } from './internal/rev-parse-parent-shorthand.js';
import { resolveRevisionName } from './internal/revision-name.js';
import { startupPrefix } from './internal/startup-prefix.js';

export type { RevParseEntry } from '../../domain/objects/rev-parse-entry.js';

const NEGATION = '^';

const included = (id: ObjectId): RevParseEntry => ({ kind: 'object', id, negated: false });
const excluded = (id: ObjectId): RevParseEntry => ({ kind: 'object', id, negated: true });
const pathEntry = (path: string): RevParseEntry => ({ kind: 'path', path });

/** What one of git's `try_*` readers printed, and whether it consumed the argument. */
interface Attempt {
  readonly printed: ReadonlyArray<RevParseEntry>;
  readonly consumed: boolean;
}

const NOTHING_PRINTED: Attempt = { printed: [], consumed: false };

/**
 * `git rev-parse <arg>`: every line git prints for the argument, in its
 * order. An argument holding `..` whose sides both name objects is a range —
 * `A..B` answers B then ^A, `A...B` B, A, then ^ each merge base; a commit
 * `X` read as `X^@` answers its parents, `X^!` X then ^ each parent, `X^-<n>`
 * X then ^ its n-th parent; otherwise the argument names one object,
 * excluded when spelt `^<rev>`, or else an existing path, printed as given.
 * A refusal carries the lines git printed before it.
 */
export const revParse = (ctx: Context, expression: string): Promise<ReadonlyArray<RevParseEntry>> =>
  revParseScoped(ctx, createObjectTypeTable(), expression);

const revParseScoped = async (
  ctx: Context,
  table: ObjectTypeTable,
  expression: string,
): Promise<ReadonlyArray<RevParseEntry>> => {
  const difference = await tryDifference(ctx, table, expression);
  if (difference.consumed) return difference.printed;
  const shorthand = await tryParentShorthands(ctx, table, expression);
  if (shorthand !== undefined) return [...difference.printed, ...shorthand];
  return readArgument(ctx, table, expression, difference.printed);
};

const readArgument = async (
  ctx: Context,
  table: ObjectTypeTable,
  expression: string,
  printed: ReadonlyArray<RevParseEntry>,
): Promise<ReadonlyArray<RevParseEntry>> => {
  const negated = expression.startsWith(NEGATION);
  const name = negated ? expression.slice(NEGATION.length) : expression;
  try {
    const id = await readReporting(ctx, table, name);
    return [...printed, negated ? excluded(id) : included(id)];
  } catch (error) {
    if (!namesNoObject(error)) throw error;
    return readFilename(ctx, table, expression, [...printed, pathEntry(expression)], error);
  }
};

/**
 * git's `show_file` then `verify_filename`: the argument is printed as a
 * path, then refused — after the misspelt-name re-read — unless it names one.
 */
const readFilename = async (
  ctx: Context,
  table: ObjectTypeTable,
  arg: string,
  printed: ReadonlyArray<RevParseEntry>,
  failure: unknown,
): Promise<ReadonlyArray<RevParseEntry>> => {
  if (await namesFilename(ctx, arg)) return printed;
  await rereadMisspelt(ctx, table, arg).catch((error: unknown) => {
    throw withPrinted(error, printed);
  });
  throw withPrinted(failure, printed);
};

/**
 * git's `maybe_die_on_misspelt_object_name`: a second, quiet read of `arg`,
 * which skips a `:/` search — quiet but below a `^<n>` or `~<n>`, which reads
 * what precedes it without the quiet flag, so an ambiguity there is reported again.
 */
const rereadMisspelt = async (
  ctx: Context,
  table: ObjectTypeTable | undefined,
  arg: string,
): Promise<void> => {
  if (isMessageSearch(arg)) return;
  try {
    await evaluateTyped(ctx, table, arg);
  } catch (error) {
    if (errorDataCode(error) === 'AMBIGUOUS_OID_PREFIX' && dropsQuietRead(arg)) {
      reportAmbiguousOid(ctx, error);
    }
    throw error;
  }
};

const PARENT_STEPS: ReadonlySet<RevOperation['kind']> = new Set(['parent', 'ancestor']);

/** Whether `arg` holds a `^<n>` or `~<n>`: git's `get_parent` and `get_nth_ancestor` drop the quiet flag. */
const dropsQuietRead = (arg: string): boolean => {
  const expr = parseExpression(arg);
  if (expr.kind === 'tree-path') return dropsQuietRead(expr.rev);
  return expr.kind === 'ref-or-hex' && expr.operations.some((op) => PARENT_STEPS.has(op.kind));
};

/** git's `get_oid` read aloud: an ambiguous abbreviated name is reported before the read fails. */
export const readReporting = async (
  ctx: Context,
  table: ObjectTypeTable | undefined,
  expression: string,
  accepts?: CandidateFilter,
): Promise<ObjectId> => {
  try {
    return await evaluateTyped(ctx, table, expression, accepts);
  } catch (error) {
    reportAmbiguousOid(ctx, error);
    throw error;
  }
};

type PrintingRefusal = Extract<
  TsgitErrorData,
  {
    readonly code:
      | 'OBJECT_NOT_FOUND'
      | 'REVPARSE_UNRESOLVED'
      | 'PATH_NOT_IN_TREE'
      | 'AMBIGUOUS_OID_PREFIX';
  }
>;

const withPrinted = (refusal: unknown, printed: ReadonlyArray<RevParseEntry>): unknown => {
  if (!namesNoObject(refusal)) return refusal;
  const { data } = refusal as { readonly data: PrintingRefusal };
  return new TsgitError({ ...data, printed });
};

/**
 * Where a `setup_revisions` reader takes its argument from: the command line,
 * where an argument naming no object may be a filename, or a `--stdin` line,
 * where it cannot — a bare `..` is then `HEAD..HEAD`, and a miss is refused
 * without the misspelt-name re-read.
 */
export type RevisionSource = 'command-line' | 'stdin';

const SIDES_BY_SOURCE: Readonly<
  Record<RevisionSource, (expression: string) => DifferenceSides | undefined>
> = { 'command-line': differenceSides, stdin: rangeSides };

/**
 * The single object a `setup_revisions` reader takes from `expression`: an
 * expression holding `..` has its sides read first, as git tries it as a
 * range, then the whole is read as one name — every lookup typed into one
 * table, as one git process types them.
 */
export const resolveRevision = async (
  ctx: Context,
  expression: string,
  source: RevisionSource = 'command-line',
): Promise<ObjectId> => {
  const table = createObjectTypeTable();
  await readDifferenceSides(ctx, table, SIDES_BY_SOURCE[source](expression));
  if (source === 'stdin') return readReporting(ctx, table, expression);
  return readNamedObject(ctx, table, expression, expression);
};

/**
 * `name` read once; naming no object, git's misspelt-name diagnosis of `arg`
 * re-runs `get_oid`, re-emitting each warning — unless `arg` reads as a
 * pathspec or names a working-tree path.
 */
export const readNamedObject = async (
  ctx: Context,
  table: ObjectTypeTable | undefined,
  name: string,
  arg: string,
): Promise<ObjectId> => {
  try {
    return await readReporting(ctx, table, name);
  } catch (error) {
    if (await rereadsMisspeltRevision(ctx, arg, error)) await rereadMisspelt(ctx, table, arg);
    throw error;
  }
};

/** A range side or shorthand base, read commit-ish; a read that names no object is not a refusal here. */
export const readCommittish = async (
  ctx: Context,
  table: ObjectTypeTable | undefined,
  side: string,
): Promise<ObjectId | undefined> => {
  try {
    return await readReporting(ctx, table, side, committishFilter(ctx));
  } catch (error) {
    if (namesNoObject(error)) return undefined;
    throw error;
  }
};

/**
 * git's `handle_dotdot` reads: the side before a `..`, then the side after it
 * once the first resolves, each printing its own warnings.
 */
const readDifferenceSides = async (
  ctx: Context,
  table: ObjectTypeTable | undefined,
  sides: DifferenceSides | undefined,
): Promise<void> => {
  if (sides === undefined) return;
  if ((await readCommittish(ctx, table, sides.start)) === undefined) return;
  await readCommittish(ctx, table, sides.end);
};

/**
 * git rev-parse's `try_difference`: both sides named, the range's revisions;
 * a symmetric range whose sides are not both commits has printed both sides
 * but leaves the argument unconsumed, so the whole is read as one name.
 */
const tryDifference = async (
  ctx: Context,
  table: ObjectTypeTable,
  expression: string,
): Promise<Attempt> => {
  const sides = differenceSides(expression);
  if (sides === undefined) return NOTHING_PRINTED;
  const start = await readCommittish(ctx, table, sides.start);
  if (start === undefined) return NOTHING_PRINTED;
  const end = await readCommittish(ctx, table, sides.end);
  if (end === undefined) return NOTHING_PRINTED;
  if (!sides.symmetric) return { printed: [included(end), excluded(start)], consumed: true };
  return symmetricDifference(ctx, start, end);
};

const symmetricDifference = async (
  ctx: Context,
  start: ObjectId,
  end: ObjectId,
): Promise<Attempt> => {
  const sides = [included(end), included(start)];
  const a = await lookupCommitReference(ctx, start);
  const b = await lookupCommitReference(ctx, end);
  if (a === undefined || b === undefined) return { printed: sides, consumed: false };
  const bases = await mergeBasesOf(ctx, [a.id, b.id], { all: true });
  return { printed: [...sides, ...bases.map(excluded)], consumed: true };
};

/**
 * git rev-parse's `try_parent_shorthands`: the base read commit-ish and
 * looked up as a commit, its parents as its shallow graft leaves them; a
 * base naming no commit, or `^-<n>` past its last parent, answers `undefined`
 * so the whole argument is read as one name.
 */
const tryParentShorthands = async (
  ctx: Context,
  table: ObjectTypeTable,
  expression: string,
): Promise<ReadonlyArray<RevParseEntry> | undefined> => {
  const shorthand = parentShorthand(expression);
  if (shorthand === undefined) return undefined;
  const id = await readCommittish(ctx, table, shorthand.base);
  if (id === undefined) return undefined;
  const commit = await lookupCommitReference(ctx, id);
  if (commit === undefined) return undefined;
  const { parents } = applyGraft(commit, await loadShallowSet(ctx)).data;
  return shorthandEntries(shorthand, id, parents);
};

const shorthandEntries = (
  shorthand: ParentShorthand,
  id: ObjectId,
  parents: ReadonlyArray<ObjectId>,
): ReadonlyArray<RevParseEntry> | undefined => {
  if (shorthand.kind === 'parents') return parents.map(included);
  if (shorthand.kind === 'exclude-parents') return [included(id), ...parents.map(excluded)];
  const parent = parents[shorthand.n - 1];
  return parent === undefined ? undefined : [included(id), excluded(parent)];
};

/**
 * git's `get_oid` over one expression, read once and typed into its own
 * table: the commands that refuse their argument without the misspelt-name
 * diagnosis. `accepts` is the
 * caller's disambiguation hint for an abbreviated name read as is.
 */
export const evaluateRevision = (
  ctx: Context,
  expression: string,
  accepts?: CandidateFilter,
): Promise<ObjectId> => evaluateTyped(ctx, createObjectTypeTable(), expression, accepts);

/** git's `get_oid` typing each object it parses into `table`, the invocation's. */
const evaluateTyped = async (
  ctx: Context,
  table: ObjectTypeTable | undefined,
  expression: string,
  accepts?: CandidateFilter,
): Promise<ObjectId> => {
  await assertOperationalRepository(ctx);
  await assertRepoSettingsValid(ctx);
  const expr = parseExpression(expression);
  return evaluate(ctx, table, expr, expression, accepts);
};

const evaluate = async (
  ctx: Context,
  table: ObjectTypeTable | undefined,
  expr: RevExpression,
  raw: string,
  accepts?: CandidateFilter,
): Promise<ObjectId> => {
  if (expr.kind === 'index-stage') {
    return resolveIndexStage(ctx, { stage: expr.stage, path: resolveRelativePath(ctx, expr.path) });
  }
  if (expr.kind === 'tree-path') {
    return resolveTreePath(ctx, table, expr.rev, expr.path);
  }
  if (expr.kind === 'message-search') return searchFromRefs(ctx, expr.pattern, raw);
  // `now` is read once per call so the reflog `@{date}` resolution is
  // deterministic within an evaluation; the grammar parser stays clock-free.
  const now = Math.floor(Date.now() / 1000);
  let id =
    expr.reflog !== undefined
      ? await resolveReflogBase(ctx, expr.base, expr.reflog, now, raw)
      : await resolveBase(ctx, expr.base, baseHint(ctx, expr.operations, accepts));
  for (const op of expr.operations) {
    id = await applyOperation(ctx, table, id, op);
  }
  return id;
};

const EMPTY_AT = '@';
const HEAD = 'HEAD';

/** git's `interpret_empty_at`: a lone `@` — `@@{...}` included — stands for `HEAD`. */
const interpretEmptyAt = (base: string): string => (base === EMPTY_AT ? HEAD : base);

/**
 * The disambiguation hint the base is read with: the caller's when no
 * operation applies, else the one git's innermost operation asks for —
 * commit-ish for `^`, `~`, `^{commit}` and `^{/re}`, tree-ish for `^{tree}`,
 * none for the other peels.
 */
const baseHint = (
  ctx: Context,
  operations: ReadonlyArray<RevOperation>,
  accepts: CandidateFilter | undefined,
): CandidateFilter | undefined => {
  const [innermost] = operations;
  if (innermost === undefined) return accepts;
  if (innermost.kind === 'deref') return undefined;
  if (innermost.kind !== 'peel') return committishFilter(ctx);
  if (innermost.target === 'commit') return committishFilter(ctx);
  return innermost.target === 'tree' ? treeishFilter(ctx) : undefined;
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
  const id = await resolveRevisionName(ctx, interpretEmptyAt(base), accepts);
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
  const ref =
    base === '' ? await currentBranchLog(ctx) : await dwimLog(ctx, interpretEmptyAt(base));
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

const applyOperation = async (
  ctx: Context,
  table: ObjectTypeTable | undefined,
  id: ObjectId,
  op: RevOperation,
): Promise<ObjectId> => {
  if (op.kind === 'deref') return derefTags(ctx, table, id, op.name);
  if (op.kind === 'peel') return peelTo(ctx, table, id, op.target, op.name);
  if (op.kind === 'search') return searchFrom(ctx, table, id, op);
  const commit = await commitToWalk(ctx, id);
  if (op.kind === 'parent') return op.n === 0 ? commit.id : nthParent(ctx, commit, op.n);
  return nthAncestor(ctx, commit, op.n);
};

/** git's `peel_onion`: `^{object}` only needs the object to exist. */
const peelTo = async (
  ctx: Context,
  table: ObjectTypeTable | undefined,
  id: ObjectId,
  target: PeelTarget,
  name: string,
): Promise<ObjectId> => {
  if (target !== 'object') return peel(ctx, table, id, target, name);
  await readObject(ctx, id);
  return id;
};

/** git's `^{/<regex>}`: peel to a commit, then search back from it; `^{/}` is the commit itself. */
const searchFrom = async (
  ctx: Context,
  table: ObjectTypeTable | undefined,
  id: ObjectId,
  op: Extract<RevOperation, { readonly kind: 'search' }>,
): Promise<ObjectId> => {
  const peeled = await commitToWalk(ctx, await peel(ctx, table, id, 'commit', op.name));
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
const derefTags = async (
  ctx: Context,
  table: ObjectTypeTable | undefined,
  id: ObjectId,
  name: string,
): Promise<ObjectId> => {
  let current = await parseTypedObject(ctx, table, id);
  if (current === undefined) throw objectNotFound(id);
  while (current.type === 'tag') {
    current = await readTagged(ctx, table, current.data.object, name);
  }
  return current.id;
};

const reportMissingReferenced = (ctx: Context, name: string, id: ObjectId): void => {
  ctx.logger?.error?.(`missing object referenced by '${name}'`, { name, id });
};

/** `parse_object` of a tag's target: absent or mistyped, git names the tag's spelling. */
const readTagged = async (
  ctx: Context,
  table: ObjectTypeTable | undefined,
  id: ObjectId,
  name: string,
): Promise<GitObject> => {
  let tagged: GitObject | undefined;
  try {
    tagged = await parseTypedObject(ctx, table, id);
  } catch (error) {
    if (errorDataCode(error) === 'OBJECT_NOT_FOUND') reportMissingReferenced(ctx, name, id);
    throw error;
  }
  if (tagged !== undefined) return tagged;
  reportMissingReferenced(ctx, name, id);
  throw objectNotFound(id);
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
const resolveTreePath = async (
  ctx: Context,
  table: ObjectTypeTable | undefined,
  rev: string,
  rawPath: string,
): Promise<ObjectId> => {
  const baseId = await evaluate(ctx, table, parseExpression(rev), rev, treeishFilter(ctx));
  const path = resolveRelativePath(ctx, rawPath);
  const treeId = await peel(ctx, table, baseId, 'tree');
  if (path === '') return treeId;
  // `treeId` is already a tree (peeled above), so `readTree` loads it without a
  // further peel; the shared descent then walks the `/`-separated components.
  const rootTree = await readTree(ctx, treeId);
  return (await descendTreePath(ctx, rootTree, path, rev)).id;
};

const RELATIVE_PATH_PREFIXES: ReadonlyArray<string> = ['./', '../'];

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
