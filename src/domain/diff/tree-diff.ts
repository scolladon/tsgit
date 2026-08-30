import { compareBytes } from '../objects/encoding.js';
import { isDirectory } from '../objects/file-mode.js';
import type { FilePath, Tree, TreeEntry } from '../objects/index.js';
import type { DiffChange, TreeDiff } from './diff-change.js';
import { isSameKind } from './mode-kind.js';

function addFrom(entry: TreeEntry): DiffChange {
  return {
    type: 'add',
    newPath: entry.name as FilePath,
    newId: entry.id,
    newMode: entry.mode,
  };
}

function deleteFrom(entry: TreeEntry): DiffChange {
  return {
    type: 'delete',
    oldPath: entry.name as FilePath,
    oldId: entry.id,
    oldMode: entry.mode,
  };
}

function classifySamePath(oldEntry: TreeEntry, newEntry: TreeEntry): DiffChange | undefined {
  if (oldEntry.id === newEntry.id && oldEntry.mode === newEntry.mode) {
    return undefined;
  }
  if (!isSameKind(oldEntry.mode, newEntry.mode)) {
    return {
      type: 'type-change',
      path: oldEntry.name as FilePath,
      oldId: oldEntry.id,
      newId: newEntry.id,
      oldMode: oldEntry.mode,
      newMode: newEntry.mode,
    };
  }
  return {
    type: 'modify',
    path: oldEntry.name as FilePath,
    oldId: oldEntry.id,
    newId: newEntry.id,
    oldMode: oldEntry.mode,
    newMode: newEntry.mode,
  };
}

interface KeyedEntry {
  readonly entry: TreeEntry;
  readonly key: Uint8Array;
}

/**
 * mode+name sort key, mirroring git's tree order (a directory sorts as if
 * suffixed with `/`). Computed once per entry so the merge-join below never
 * re-derives a name it already sorted by — avoids the double `TextEncoder`
 * pass (once to sort, once per merge-join comparison) the naive compare-by-
 * re-encode approach pays.
 */
function entryKey(entry: TreeEntry): Uint8Array {
  const nameBytes = entry.nameBytes;
  if (!isDirectory(entry.mode)) return nameBytes;
  const withSlash = new Uint8Array(nameBytes.length + 1);
  withSlash.set(nameBytes);
  withSlash[nameBytes.length] = 0x2f;
  return withSlash;
}

function entriesOf(tree: Tree | undefined): ReadonlyArray<KeyedEntry> {
  if (tree === undefined) return [];
  const decorated = tree.entries.map((entry) => ({ entry, key: entryKey(entry) }));
  decorated.sort((a, b) => compareBytes(a.key, b.key));
  return decorated;
}

export function diffTrees(oldTree: Tree | undefined, newTree: Tree | undefined): TreeDiff {
  const oldEntries = entriesOf(oldTree);
  const newEntries = entriesOf(newTree);
  const changes: DiffChange[] = [];

  let i = 0;
  let j = 0;
  while (i < oldEntries.length && j < newEntries.length) {
    const oldEntry = oldEntries[i]!;
    const newEntry = newEntries[j]!;
    const cmp = compareBytes(oldEntry.key, newEntry.key);
    if (cmp < 0) {
      changes.push(deleteFrom(oldEntry.entry));
      i++;
    } else if (cmp > 0) {
      changes.push(addFrom(newEntry.entry));
      j++;
    } else {
      const change = classifySamePath(oldEntry.entry, newEntry.entry);
      if (change !== undefined) changes.push(change);
      i++;
      j++;
    }
  }

  while (i < oldEntries.length) {
    changes.push(deleteFrom(oldEntries[i]!.entry));
    i++;
  }
  while (j < newEntries.length) {
    changes.push(addFrom(newEntries[j]!.entry));
    j++;
  }

  return { changes };
}
