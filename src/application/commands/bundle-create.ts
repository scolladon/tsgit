import type { BundlePrerequisite, BundleRef, BundleVersion } from '../../domain/bundle/index.js';
import { serializeBundleHeader } from '../../domain/bundle/index.js';
import { bundleEmpty, bundlePrerequisiteNotCommit } from '../../domain/commands/error.js';
import { foldSubject } from '../../domain/objects/commit-message.js';
import type { Commit, GitObject, ObjectId, RefName } from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import { buildPack } from '../primitives/build-pack.js';
import { enumerateBundleObjects } from '../primitives/enumerate-bundle-objects.js';
import { enumerateRefs } from '../primitives/enumerate-refs.js';
import { peel } from '../primitives/internal/peel.js';
import { mergeBase } from '../primitives/merge-base.js';
import { readObject } from '../primitives/read-object.js';
import { resolveRef } from '../primitives/resolve-ref.js';
import { assertRepository } from './internal/repo-state.js';
import { revParse } from './rev-parse.js';

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
  readonly wants: ObjectId[];
  readonly haves: ObjectId[];
}

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

const addRefToAccumulator = async (ctx: Context, ref: RefName, acc: Accumulator): Promise<void> => {
  const oid = await resolveRef(ctx, ref);
  acc.refs.push({ name: ref, oid });
  acc.wants.push(oid);
};

const refsWithPrefix = (prefix: string, allRefs: ReadonlyArray<RefName>): RefName[] =>
  allRefs.filter((r) => (r as string).startsWith(prefix)).sort() as RefName[];

const expandPseudoRefs = async (
  ctx: Context,
  opts: BundleCreateOptions,
  allRefs: ReadonlyArray<RefName>,
  acc: Accumulator,
): Promise<void> => {
  if (opts.branches === true) {
    for (const r of refsWithPrefix('refs/heads/', allRefs)) await addRefToAccumulator(ctx, r, acc);
  }
  if (opts.tags === true) {
    for (const r of refsWithPrefix('refs/tags/', allRefs)) await addRefToAccumulator(ctx, r, acc);
  }
  if (opts.all === true) {
    for (const r of refsWithPrefix('refs/', allRefs)) await addRefToAccumulator(ctx, r, acc);
    await addRefToAccumulator(ctx, 'HEAD' as RefName, acc);
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
  const oid = await revParse(ctx, tip);
  const fullRef = findFullRef(tip, allRefs);
  if (fullRef !== undefined) acc.refs.push({ name: fullRef, oid });
  acc.wants.push(oid);
};

const processExclude = async (ctx: Context, exclude: string, acc: Accumulator): Promise<void> => {
  const oid = await revParse(ctx, exclude);
  acc.haves.push(await peel(ctx, oid, 'commit'));
};

const processRange = async (
  ctx: Context,
  range: readonly [string, string],
  allRefs: ReadonlyArray<RefName>,
  acc: Accumulator,
): Promise<void> => {
  const [aExpr, bExpr] = range;
  const aOid = await revParse(ctx, aExpr);
  acc.haves.push(await peel(ctx, aOid, 'commit'));
  const bOid = await revParse(ctx, bExpr);
  const bFullRef = findFullRef(bExpr, allRefs);
  if (bFullRef !== undefined) acc.refs.push({ name: bFullRef, oid: bOid });
  acc.wants.push(bOid);
};

const processSymmetricRange = async (
  ctx: Context,
  sym: readonly [string, string],
  allRefs: ReadonlyArray<RefName>,
  acc: Accumulator,
): Promise<void> => {
  const [aExpr, bExpr] = sym;
  const aOid = await revParse(ctx, aExpr);
  const aFullRef = findFullRef(aExpr, allRefs);
  if (aFullRef !== undefined) acc.refs.push({ name: aFullRef, oid: aOid });
  acc.wants.push(aOid);
  const bOid = await revParse(ctx, bExpr);
  const bFullRef = findFullRef(bExpr, allRefs);
  if (bFullRef !== undefined) acc.refs.push({ name: bFullRef, oid: bOid });
  acc.wants.push(bOid);
  const bases = await mergeBase(
    ctx,
    [await peel(ctx, aOid, 'commit'), await peel(ctx, bOid, 'commit')],
    { all: true },
  );
  acc.haves.push(...bases);
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
  Promise.all(
    [...boundary].sort().map(async (oid) => {
      const obj = await readObject(ctx, oid);
      // git uses format_subject (%s): folds the whole first paragraph
      // (all non-blank lines before the first blank) into a single line
      const commit = assertBoundaryCommit(obj, oid);
      return { oid, comment: foldSubject(commit.data.message) };
    }),
  );

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
// Main command
// ─────────────────────────────────────────────────────────────────────────────

const VERSION: BundleVersion = 2;

/**
 * Produces a v2 git bundle — the full object closure for the given rev
 * selection plus the structured header metadata.
 *
 * Returns `bytes` (header ++ packfile) for the caller to write, alongside
 * the structured metadata so the caller can inspect the result without
 * re-parsing. Throws `BUNDLE_EMPTY` if the selection yields no ref lines
 * (`reason: 'no-refs'`) or an empty object closure (`reason: 'no-objects'`).
 */
export const bundleCreate = async (
  ctx: Context,
  opts: BundleCreateOptions,
): Promise<BundleCreateResult> => {
  await assertRepository(ctx);
  const allRefs = await enumerateRefs(ctx);
  const acc: Accumulator = { refs: [], wants: [], haves: [] };
  await expandPseudoRefs(ctx, opts, allRefs, acc);
  await processRevArgs(ctx, opts.revs ?? [], allRefs, acc);
  const deduped = deduplicateRefs(acc.refs);
  acc.refs.splice(0, acc.refs.length, ...deduped);
  if (acc.refs.length === 0) throw bundleEmpty('no-refs');
  const closure = await enumerateBundleObjects(ctx, { wants: acc.wants, haves: acc.haves });
  if (closure.objects.length === 0) throw bundleEmpty('no-objects');
  const prerequisites = await makePrerequisites(ctx, closure.boundary);
  const pack = await buildPack(ctx, { oids: closure.objects });
  const header = serializeBundleHeader({ version: VERSION, prerequisites, refs: acc.refs });
  const bytes = concat(header, pack.bytes);
  return {
    version: VERSION,
    bytes,
    refs: acc.refs,
    prerequisites,
    objectCount: pack.objectCount,
    packSha: pack.sha,
  };
};
