/**
 * Raw merge-join tree diff — walks two byte cursors in lock-step and emits
 * the same `DiffChange` variants, in the same order, as `tree-diff.ts`'s
 * `diffTrees` — without parsing either side into a `Tree` first.
 *
 * Enforces only the structural checks the cursor scan performs (missing
 * space/NUL, malformed mode, empty name, truncated hash); no sort, no
 * duplicate-name/order/name-shape validation. The walk streams both sides
 * in on-disk order exactly as git's tree merge-join does, so an unsorted or
 * duplicate-name tree is diffed, not refused.
 */

import type { HashConfig } from '../objects/hash-config.js';
import type { FilePath } from '../objects/index.js';
import {
  advanceCursor,
  compareCursorNames,
  cursorMode,
  cursorName,
  cursorOid,
  cursorsSame,
  openTreeCursor,
  type TreeCursor,
} from '../objects/tree-cursor.js';
import type { DiffChange, TreeDiff } from './diff-change.js';
import { isSameKind } from './mode-kind.js';

const EMPTY_CONTENT = new Uint8Array(0);

export function diffRawTrees(
  oldContent: Uint8Array | undefined,
  newContent: Uint8Array | undefined,
  hash: HashConfig,
): TreeDiff {
  const a = openTreeCursor(oldContent ?? EMPTY_CONTENT, hash);
  const b = openTreeCursor(newContent ?? EMPTY_CONTENT, hash);
  const changes: DiffChange[] = [];

  while (!a.done && !b.done) {
    const cmp = compareCursorNames(a, b);
    if (cmp < 0) {
      changes.push(deleteFromCursor(a));
      advanceCursor(a);
    } else if (cmp > 0) {
      changes.push(addFromCursor(b));
      advanceCursor(b);
    } else {
      const change = classifySamePathCursor(a, b);
      if (change !== undefined) changes.push(change);
      advanceCursor(a);
      advanceCursor(b);
    }
  }

  while (!a.done) {
    changes.push(deleteFromCursor(a));
    advanceCursor(a);
  }
  while (!b.done) {
    changes.push(addFromCursor(b));
    advanceCursor(b);
  }

  return { changes };
}

function addFromCursor(c: TreeCursor): DiffChange {
  return {
    type: 'add',
    newPath: cursorName(c) as FilePath,
    newId: cursorOid(c),
    newMode: cursorMode(c),
  };
}

function deleteFromCursor(c: TreeCursor): DiffChange {
  return {
    type: 'delete',
    oldPath: cursorName(c) as FilePath,
    oldId: cursorOid(c),
    oldMode: cursorMode(c),
  };
}

function classifySamePathCursor(a: TreeCursor, b: TreeCursor): DiffChange | undefined {
  if (cursorsSame(a, b)) return undefined;

  const path = cursorName(a) as FilePath;
  const oldId = cursorOid(a);
  const newId = cursorOid(b);
  const oldMode = cursorMode(a);
  const newMode = cursorMode(b);

  if (!isSameKind(oldMode, newMode)) {
    return { type: 'type-change', path, oldId, newId, oldMode, newMode };
  }
  return { type: 'modify', path, oldId, newId, oldMode, newMode };
}
