/**
 * Tiny I/O helpers for the raw byte-cursor tree walkers: reading a tree
 * object's raw content by id (`flatten-raw.ts`, `walk-raw-subtree.ts`,
 * `diff-trees.ts`), with the same non-tree refusal every raw walker needs
 * at its root, and joining a possibly-empty path prefix with the next
 * segment (`flatten-raw.ts`, `diff-trees.ts` — `walk-raw-subtree.ts` keeps
 * a local join whose prefix is provably non-empty).
 */
import { unexpectedObjectType } from '../../../domain/objects/error.js';
import type { FilePath, ObjectId } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import { readRawObject } from '../read-object.js';

export async function readRawTreeById(ctx: Context, id: ObjectId): Promise<Uint8Array> {
  const raw = await readRawObject(ctx, id);
  if (raw.type !== 'tree') throw unexpectedObjectType('tree', raw.type, id);
  return raw.content;
}

export function joinPath(prefix: string, name: string): FilePath {
  return (prefix === '' ? name : `${prefix}/${name}`) as FilePath;
}
