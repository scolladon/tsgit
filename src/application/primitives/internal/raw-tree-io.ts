/**
 * Tiny I/O helpers shared by every raw byte-cursor tree walker
 * (`flatten-raw.ts`, `walk-raw-subtree.ts`, `diff-trees.ts`): reading a tree
 * object's raw content by id, with the same non-tree refusal every raw
 * walker needs at its root, and joining a path prefix with the next segment.
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
