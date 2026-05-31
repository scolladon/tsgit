import { revparseUnresolved } from '../../domain/commands/error.js';
import { objectNotFound } from '../../domain/objects/error.js';
import {
  type ObjectId,
  ObjectId as ObjectIdFactory,
  type RefName,
} from '../../domain/objects/index.js';
import { parseApproxidate } from '../../domain/reflog/approxidate.js';
import { reflogEntryOutOfRange } from '../../domain/reflog/error.js';
import type { ReflogEntry } from '../../domain/reflog/reflog-entry.js';
import { refCandidates, validateRefName } from '../../domain/refs/index.js';
import type { Context } from '../../ports/context.js';
import { readIndex } from '../primitives/read-index.js';
import { readObject } from '../primitives/read-object.js';
import { getRefStore } from '../primitives/ref-store.js';
import { readReflog, reflogExists } from '../primitives/reflog-store.js';
import { resolveOidPrefix } from '../primitives/resolve-oid-prefix.js';
import { resolveRef } from '../primitives/resolve-ref.js';
import { assertRepository } from './internal/repo-state.js';
import {
  parseExpression,
  type ReflogSelector,
  type RevExpression,
  type RevOperation,
} from './internal/rev-parse-grammar.js';

export const revParse = async (ctx: Context, expression: string): Promise<ObjectId> => {
  await assertRepository(ctx);
  const expr = parseExpression(expression);
  return evaluate(ctx, expr, expression);
};

const evaluate = async (ctx: Context, expr: RevExpression, raw: string): Promise<ObjectId> => {
  if (expr.kind === 'index-stage') {
    return resolveIndexStage(ctx, expr);
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
  if (/^[0-9a-f]{40}$/.test(base)) return ObjectIdFactory.from(base);
  // Try as a ref name; the verbatim candidate also covers the HEAD literal,
  // which resolveRef accepts directly.
  for (const candidate of refCandidates(base)) {
    try {
      return await resolveRef(ctx, candidate);
    } catch {
      // continue
    }
  }
  // Not a ref — try as an abbreviated object id (git's get_oid fallback).
  // Throws AMBIGUOUS_OID_PREFIX when the prefix matches more than one object.
  const byPrefix = await resolveOidPrefix(ctx, base);
  if (byPrefix !== undefined) return byPrefix;
  throw objectNotFound(base as ObjectId);
};

/** Resolve `<base>@{<selector>}` through the reflog of the base ref. */
const resolveReflogBase = async (
  ctx: Context,
  base: string,
  selector: ReflogSelector,
  now: number,
  raw: string,
): Promise<ObjectId> => {
  const ref = base === '' ? await currentBranchRef(ctx) : await canonicalizeRef(ctx, base);
  const entries = await readReflog(ctx, ref);
  if (entries.length === 0) throw revparseUnresolved(raw);
  if (selector.kind === 'index') return pickByIndex(entries, selector.n, ref);
  return pickByDate(entries, selector.raw, now, raw);
};

/** HEAD's symbolic branch target, or the `HEAD` literal when HEAD is detached. */
const currentBranchRef = async (ctx: Context): Promise<RefName> => {
  const result = await getRefStore(ctx).resolveDirect('HEAD' as RefName);
  return result.kind === 'symbolic' ? result.target : ('HEAD' as RefName);
};

/**
 * Map a short base to the `RefName` whose reflog to read: the first candidate
 * with a reflog file, else the first that resolves as a ref (so the empty-log
 * path still fires with a sensible ref).
 */
const canonicalizeRef = async (ctx: Context, base: string): Promise<RefName> => {
  // Validate before any candidate reaches the filesystem: an unchecked `base`
  // carrying `..` would otherwise be probed on disk by reflogExists/refResolves.
  const validated = validateBaseRef(base);
  const candidates = refCandidates(validated);
  for (const candidate of candidates) {
    if (await reflogExists(ctx, candidate as RefName)) return candidate as RefName;
  }
  // The loop below picks a "sensible ref" for the empty-log case, but once the
  // loop above proves no candidate has a reflog file, its chosen ref is never
  // observable: resolveReflogBase reads that ref's reflog (empty for every
  // candidate, since none has a file) and throws REVPARSE_UNRESOLVED, which
  // carries the raw expression — not the ref. Hence the equivalent-mutant
  // suppressions: any ref name here yields the identical empty-log error.
  // Stryker disable next-line BlockStatement: equivalent — see above.
  for (const candidate of candidates) {
    // Stryker disable next-line ConditionalExpression: equivalent — see above.
    if (await refResolves(ctx, candidate)) return candidate as RefName;
  }
  // No candidate has a reflog or resolves: fall back to the validated base.
  return validated;
};

const validateBaseRef = (base: string): RefName => {
  try {
    return validateRefName(base);
  } catch {
    throw revparseUnresolved(base);
  }
};

// Only feeds canonicalizeRef's second loop, whose chosen ref is never
// observable (see the comment there) — so both return values are
// equivalent-mutant territory.
const refResolves = async (ctx: Context, candidate: RefName | 'HEAD'): Promise<boolean> => {
  try {
    await resolveRef(ctx, candidate);
    // Stryker disable next-line BooleanLiteral: equivalent — refResolves only gates canonicalizeRef's unobservable fallback loop.
    return true;
  } catch {
    // Stryker disable next-line BooleanLiteral: equivalent — refResolves only gates canonicalizeRef's unobservable fallback loop.
    return false;
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
): ObjectId => {
  const target = parseApproxidate(rawDate, now);
  if (target === undefined) throw revparseUnresolved(raw);
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i] as ReflogEntry;
    if (entry.identity.timestamp <= target) return entry.newId;
  }
  return (entries[0] as ReflogEntry).oldId;
};

const applyOperation = async (ctx: Context, id: ObjectId, op: RevOperation): Promise<ObjectId> => {
  if (op.kind === 'parent') return getNthParent(ctx, id, op.n);
  if (op.kind === 'ancestor') {
    let cur = id;
    for (let i = 0; i < op.n; i += 1) cur = await getNthParent(ctx, cur, 1);
    return cur;
  }
  return peel(ctx, id, op.target);
};

const getNthParent = async (ctx: Context, id: ObjectId, n: number): Promise<ObjectId> => {
  const obj = await readObject(ctx, id);
  if (obj.type !== 'commit') throw objectNotFound(id);
  const parents = obj.data.parents;
  const parent = parents[n - 1];
  if (parent === undefined) throw objectNotFound(id);
  return parent;
};

const peel = async (
  ctx: Context,
  id: ObjectId,
  target: 'commit' | 'tree' | 'blob' | 'tag',
): Promise<ObjectId> => {
  let current: ObjectId = id;
  for (let i = 0; i < 5; i += 1) {
    const obj = await readObject(ctx, current);
    if (obj.type === target) return current;
    if (obj.type === 'tag') {
      current = obj.data.object;
      continue;
    }
    if (target === 'tree' && obj.type === 'commit') return obj.data.tree;
    throw objectNotFound(current);
  }
  throw objectNotFound(current);
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
