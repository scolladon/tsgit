import type { BundlePrerequisite, BundleRef, BundleVersion } from '../../domain/bundle/index.js';
import { serializeBundleHeader } from '../../domain/bundle/index.js';
import {
  bundleEmpty,
  bundlePrerequisiteNotCommit,
  bundleUnsupportedSerializeVersion,
  invalidRevisionRange,
  invalidSymmetricRange,
} from '../../domain/commands/error.js';
import { foldSubject } from '../../domain/objects/commit-message.js';
import type { Commit, GitObject, ObjectId, RefName } from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import { buildPack } from '../primitives/build-pack.js';
import { assertValidPackIntConfig } from '../primitives/config-read.js';
import { enumerateBundleObjects } from '../primitives/enumerate-bundle-objects.js';
import { enumerateRefs } from '../primitives/enumerate-refs.js';
import type { ClosureTip } from '../primitives/internal/closure-engine.js';
import { boundedMapFor } from '../primitives/internal/concurrency.js';
import {
  createObjectTypeTable,
  type ObjectTypeTable,
  parseTypedObjectOrAbsent,
} from '../primitives/internal/object-type-table.js';
import { readObject } from '../primitives/read-object.js';
import { resolveRef, resolveRefForReading } from '../primitives/resolve-ref.js';
import { assertOperationalRepository } from './internal/repo-state.js';
import { requireReference } from './internal/require-reference.js';
import { symmetricBases } from './internal/symmetric-bases.js';
import { resolveRevision } from './rev-parse.js';

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

export type BundleRevArg =
  | { readonly tip: string }
  | { readonly exclude: string }
  | { readonly range: readonly [string, string] }
  | { readonly symmetricRange: readonly [string, string] };

export interface BundleCreateOptions {
  readonly revs?: ReadonlyArray<BundleRevArg>;
  readonly all?: boolean;
  readonly branches?: boolean;
  readonly tags?: boolean;
  /** Omitted: derived from `selectBundleVersion`'s rule. Supplied: honoured, or refused if it cannot express the rule's requirement (e.g. `2` when the algorithm or a filter requires `3`). */
  readonly version?: 2 | 3;
}

export interface BundleCreateResult {
  readonly version: BundleVersion;
  readonly bytes: Uint8Array;
  readonly refs: ReadonlyArray<BundleRef>;
  readonly prerequisites: ReadonlyArray<BundlePrerequisite>;
  readonly objectCount: number;
  readonly packSha: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal types
// ─────────────────────────────────────────────────────────────────────────────

interface Accumulator {
  readonly refs: BundleRef[];
  /** Every tip in git's pending order — `handle_revision_arg`'s. */
  readonly pending: ClosureTip[];
  /** The bundle process's object-type table, shared by its arguments and its walk. */
  readonly objectTypes: ObjectTypeTable;
}

const want = (acc: Accumulator, id: ObjectId): void => {
  acc.pending.push({ id, excluded: false });
};

const exclude = (acc: Accumulator, id: ObjectId): void => {
  acc.pending.push({ id, excluded: true });
};

// ─────────────────────────────────────────────────────────────────────────────
// Ref-name lookup helpers
// ─────────────────────────────────────────────────────────────────────────────

const SHORT_NAME_PREFIXES = ['refs/', 'refs/tags/', 'refs/heads/', 'refs/remotes/'] as const;

/**
 * Returns the full RefName if `name` matches exactly or via git short-name
 * expansion order; returns `undefined` if no ref matches.
 * Pure string lookup — no I/O.
 */
const findFullRef = (name: string, allRefs: ReadonlyArray<RefName>): RefName | undefined => {
  const refs = allRefs as readonly string[];
  if (refs.includes(name)) return name as RefName;
  for (const prefix of SHORT_NAME_PREFIXES) {
    const full = `${prefix}${name}`;
    if (refs.includes(full)) return full as RefName;
  }
  return undefined;
};

// ─────────────────────────────────────────────────────────────────────────────
// Pseudo-ref expansion (--all / --branches / --tags)
// ─────────────────────────────────────────────────────────────────────────────

/** git's `handle_one_ref`: the ref's object parsed into the table, dying `bad object <spelt>`. */
const addRefToAccumulator = async (
  ctx: Context,
  ref: RefName,
  spelt: string,
  acc: Accumulator,
): Promise<void> => {
  const oid = await resolveRef(ctx, ref);
  await requireReference(ctx, acc.objectTypes, spelt, oid);
  acc.refs.push({ name: ref, oid });
  want(acc, oid);
};

const refsWithPrefix = (prefix: string, allRefs: ReadonlyArray<RefName>): RefName[] =>
  allRefs.filter((r) => (r as string).startsWith(prefix)).sort() as RefName[];

/** git's `for_each_ref_in(prefix)`: each ref under `prefix`, spelt with the prefix `trimmed` off. */
const addRefsUnder = async (
  ctx: Context,
  prefix: string,
  trimmed: string,
  allRefs: ReadonlyArray<RefName>,
  acc: Accumulator,
): Promise<void> => {
  for (const ref of refsWithPrefix(prefix, allRefs)) {
    await addRefToAccumulator(ctx, ref, ref.slice(trimmed.length), acc);
  }
};

/** git's `head_ref`: HEAD only once it resolves — an unborn HEAD adds nothing. */
const addHead = async (ctx: Context, acc: Accumulator): Promise<void> => {
  const head = 'HEAD' as RefName;
  if ((await resolveRefForReading(ctx, head)) === undefined) return;
  await addRefToAccumulator(ctx, head, head, acc);
};

const expandPseudoRefs = async (
  ctx: Context,
  opts: BundleCreateOptions,
  allRefs: ReadonlyArray<RefName>,
  acc: Accumulator,
): Promise<void> => {
  if (opts.branches === true) await addRefsUnder(ctx, 'refs/heads/', 'refs/heads/', allRefs, acc);
  if (opts.tags === true) await addRefsUnder(ctx, 'refs/tags/', 'refs/tags/', allRefs, acc);
  if (opts.all === true) {
    await addRefsUnder(ctx, 'refs/', '', allRefs, acc);
    await addHead(ctx, acc);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Rev-arg processors
// ─────────────────────────────────────────────────────────────────────────────

const processTip = async (
  ctx: Context,
  tip: string,
  allRefs: ReadonlyArray<RefName>,
  acc: Accumulator,
): Promise<void> => {
  const oid = await resolveRevision(ctx, tip);
  await requireReference(ctx, acc.objectTypes, tip, oid);
  const fullRef = findFullRef(tip, allRefs);
  if (fullRef !== undefined) acc.refs.push({ name: fullRef, oid });
  want(acc, oid);
};

const processExclude = async (ctx: Context, excluded: string, acc: Accumulator): Promise<void> => {
  const oid = await resolveRevision(ctx, excluded);
  await requireReference(ctx, acc.objectTypes, excluded, oid);
  exclude(acc, oid);
};

/** git's `handle_dotdot_1`: both ends parsed into the table before a failed parse of either refuses the range. */
const parseRangeEnds = async (
  ctx: Context,
  acc: Accumulator,
  ends: readonly [ObjectId, ObjectId],
): Promise<boolean> => {
  const a = await parseTypedObjectOrAbsent(ctx, acc.objectTypes, ends[0]);
  const b = await parseTypedObjectOrAbsent(ctx, acc.objectTypes, ends[1]);
  return a !== undefined && b !== undefined;
};

const processRange = async (
  ctx: Context,
  range: readonly [string, string],
  allRefs: ReadonlyArray<RefName>,
  acc: Accumulator,
): Promise<void> => {
  const [aExpr, bExpr] = range;
  const aOid = await resolveRevision(ctx, aExpr);
  const bOid = await resolveRevision(ctx, bExpr);
  if (!(await parseRangeEnds(ctx, acc, [aOid, bOid]))) {
    throw invalidRevisionRange(`${aExpr}..${bExpr}`);
  }
  exclude(acc, aOid);
  const bFullRef = findFullRef(bExpr, allRefs);
  if (bFullRef !== undefined) acc.refs.push({ name: bFullRef, oid: bOid });
  want(acc, bOid);
};

const processSymmetricRange = async (
  ctx: Context,
  sym: readonly [string, string],
  allRefs: ReadonlyArray<RefName>,
  acc: Accumulator,
): Promise<void> => {
  const [aExpr, bExpr] = sym;
  const aOid = await resolveRevision(ctx, aExpr);
  const bOid = await resolveRevision(ctx, bExpr);
  if (!(await parseRangeEnds(ctx, acc, [aOid, bOid]))) {
    throw invalidSymmetricRange(`${aExpr}...${bExpr}`, []);
  }
  const aFullRef = findFullRef(aExpr, allRefs);
  if (aFullRef !== undefined) acc.refs.push({ name: aFullRef, oid: aOid });
  const bFullRef = findFullRef(bExpr, allRefs);
  if (bFullRef !== undefined) acc.refs.push({ name: bFullRef, oid: bOid });
  // git's `handle_dotdot_1` pends the merge bases before either side.
  for (const base of await symmetricBases(ctx, `${aExpr}...${bExpr}`, [aOid, bOid])) {
    exclude(acc, base);
  }
  want(acc, aOid);
  want(acc, bOid);
};

const processRevArgs = async (
  ctx: Context,
  revs: ReadonlyArray<BundleRevArg>,
  allRefs: ReadonlyArray<RefName>,
  acc: Accumulator,
): Promise<void> => {
  for (const arg of revs) {
    if ('tip' in arg) await processTip(ctx, arg.tip, allRefs, acc);
    else if ('exclude' in arg) await processExclude(ctx, arg.exclude, acc);
    else if ('range' in arg) await processRange(ctx, arg.range, allRefs, acc);
    else await processSymmetricRange(ctx, arg.symmetricRange, allRefs, acc);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Ref deduplication
// ─────────────────────────────────────────────────────────────────────────────

const deduplicateRefs = (refs: ReadonlyArray<BundleRef>): ReadonlyArray<BundleRef> => {
  const seen = new Set<string>();
  return refs.filter((r) => {
    if (seen.has(r.name as string)) return false;
    seen.add(r.name as string);
    return true;
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// Prerequisite builder
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Narrows a git object to Commit, throwing `BUNDLE_PREREQUISITE_NOT_COMMIT`
 * if the object is not a commit. Boundary oids are always commits by
 * construction (they come from `peel(ctx, oid, 'commit')`); this guard
 * surfaces store corruption.
 *
 * Exported for direct unit testing of the invariant guard.
 */
export const assertBoundaryCommit = (obj: GitObject, oid: ObjectId): Commit => {
  if (obj.type !== 'commit') throw bundlePrerequisiteNotCommit(oid, obj.type);
  return obj;
};

const makePrerequisites = async (
  ctx: Context,
  boundary: ReadonlyArray<ObjectId>,
): Promise<ReadonlyArray<BundlePrerequisite>> =>
  boundedMapFor(ctx, 'ioBound', [...boundary].sort(), async (oid) => {
    const obj = await readObject(ctx, oid);
    // git uses format_subject (%s): folds the whole first paragraph
    // (all non-blank lines before the first blank) into a single line
    const commit = assertBoundaryCommit(obj, oid);
    return { oid, comment: foldSubject(commit.data.message) };
  });

// ─────────────────────────────────────────────────────────────────────────────
// Byte concatenation helper
// ─────────────────────────────────────────────────────────────────────────────

const concat = (a: Uint8Array, b: Uint8Array): Uint8Array => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
};

// ─────────────────────────────────────────────────────────────────────────────
// Version selection
// ─────────────────────────────────────────────────────────────────────────────

export interface SelectBundleVersionInput {
  readonly algorithm: 'sha1' | 'sha256';
  /** Whether a `--filter` capability will be written. tsgit has no `--filter`
   * on `bundleCreate` yet, so every caller passes `false` today — the rule
   * still tests it explicitly so a future filter option composes for free. */
  readonly filter: boolean;
  readonly requested?: number;
}

const isSerializableVersion = (version: number): version is BundleVersion =>
  version === 2 || version === 3;

/**
 * The bundle-version selection rule, measured against git 2.55.0: v3 is
 * required the moment EITHER the repository's algorithm is not sha1 OR a
 * filter is present — never "v3 iff sha256" alone, since a sha1 repository
 * with a filter also writes v3. Absent a requested version, the rule
 * derives the version from that OR; supplied, the request is honoured
 * unless it cannot express the rule's requirement, in which case it is
 * refused rather than silently upgraded (`2` while v3 is required, or any
 * version outside `{2, 3}`).
 */
export const selectBundleVersion = (input: SelectBundleVersionInput): BundleVersion => {
  const requiresV3 = input.algorithm !== 'sha1' || input.filter;
  if (input.requested === undefined) return requiresV3 ? 3 : 2;
  if (!isSerializableVersion(input.requested)) {
    throw bundleUnsupportedSerializeVersion(input.requested);
  }
  if (input.requested === 2 && requiresV3) throw bundleUnsupportedSerializeVersion(2);
  return input.requested;
};

// ─────────────────────────────────────────────────────────────────────────────
// Main command
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Produces a git bundle — the full object closure for the given rev
 * selection plus the structured header metadata. The bundle version is
 * selected by `selectBundleVersion` (v2 by default for a SHA-1 repository,
 * v3 otherwise, or as `opts.version` requests and permits).
 *
 * Returns `bytes` (header ++ packfile) for the caller to write, alongside
 * the structured metadata so the caller can inspect the result without
 * re-parsing. Like git, a ref whose object the walk leaves uninteresting —
 * excluded, reached through an excluded tag or tree, or an ancestor of an
 * excluded commit — writes no ref line. Throws `BUNDLE_EMPTY`
 * (`reason: 'no-refs'`) when no ref line remains; an empty pack is written
 * as git writes it.
 */
export const bundleCreate = async (
  ctx: Context,
  opts: BundleCreateOptions,
): Promise<BundleCreateResult> => {
  await assertOperationalRepository(ctx);
  await assertValidPackIntConfig(ctx);
  const version = selectBundleVersion({
    algorithm: ctx.hashConfig.algorithm,
    filter: false,
    // Stryker disable next-line ConditionalExpression: equivalent — `selectBundleVersion` reads `requested` only through its first guard, `input.requested === undefined`, so spreading `{ requested: undefined }` and omitting the key take the same branch and return the same version.
    ...(opts.version !== undefined ? { requested: opts.version } : {}),
  });
  const allRefs = await enumerateRefs(ctx);
  const acc: Accumulator = { refs: [], pending: [], objectTypes: createObjectTypeTable() };
  await expandPseudoRefs(ctx, opts, allRefs, acc);
  await processRevArgs(ctx, opts.revs ?? [], allRefs, acc);
  if (acc.refs.length === 0) throw bundleEmpty('no-refs');
  const closure = await enumerateBundleObjects(ctx, {
    wants: acc.pending.filter((tip) => !tip.excluded).map((tip) => tip.id),
    haves: acc.pending.filter((tip) => tip.excluded).map((tip) => tip.id),
    tips: acc.pending,
    objectTypes: acc.objectTypes,
  });
  const refs = deduplicateRefs(acc.refs.filter((ref) => !closure.uninteresting.has(ref.oid)));
  if (refs.length === 0) throw bundleEmpty('no-refs');
  const prerequisites = await makePrerequisites(ctx, closure.boundary);
  const pack = await buildPack(ctx, { objects: closure.objects, delta: true });
  const header = serializeBundleHeader({
    version,
    hashAlgorithm: ctx.hashConfig.algorithm,
    prerequisites,
    refs,
  });
  const bytes = concat(header, pack.bytes);
  return {
    version,
    bytes,
    refs,
    prerequisites,
    objectCount: pack.objectCount,
    packSha: pack.sha,
  };
};
