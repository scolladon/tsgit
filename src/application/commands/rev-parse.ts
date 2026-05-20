import { objectNotFound } from '../../domain/objects/error.js';
import {
  type ObjectId,
  ObjectId as ObjectIdFactory,
  type RefName,
} from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import { readIndex } from '../primitives/read-index.js';
import { readObject } from '../primitives/read-object.js';
import { resolveRef } from '../primitives/resolve-ref.js';
import { assertRepository } from './internal/repo-state.js';
import {
  parseExpression,
  type RevExpression,
  type RevOperation,
} from './internal/rev-parse-grammar.js';

export const revParse = async (ctx: Context, expression: string): Promise<ObjectId> => {
  await assertRepository(ctx);
  const expr = parseExpression(expression);
  return evaluate(ctx, expr);
};

const evaluate = async (ctx: Context, expr: RevExpression): Promise<ObjectId> => {
  if (expr.kind === 'index-stage') {
    return resolveIndexStage(ctx, expr);
  }
  let id = await resolveBase(ctx, expr.base);
  for (const op of expr.operations) {
    id = await applyOperation(ctx, id, op);
  }
  return id;
};

const resolveBase = async (ctx: Context, base: string): Promise<ObjectId> => {
  if (/^[0-9a-f]{40}$/.test(base)) return ObjectIdFactory.from(base);
  // Try as a ref name; the verbatim candidate also covers the HEAD literal,
  // which resolveRef accepts directly.
  const candidates: ReadonlyArray<RefName | 'HEAD'> = [
    base as RefName,
    `refs/heads/${base}` as RefName,
    `refs/tags/${base}` as RefName,
    `refs/remotes/${base}` as RefName,
  ];
  for (const candidate of candidates) {
    try {
      return await resolveRef(ctx, candidate);
    } catch {
      // continue
    }
  }
  throw objectNotFound(base as ObjectId);
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
