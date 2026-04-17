import type { FilePath, Tree, TreeEntry } from '../objects/index.js';
import { sortTreeEntries, treeEntryCompare } from '../objects/index.js';
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

function entriesOf(tree: Tree | undefined): ReadonlyArray<TreeEntry> {
  if (tree === undefined) return [];
  return sortTreeEntries(tree.entries);
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
    const cmp = treeEntryCompare(oldEntry, newEntry);
    if (cmp < 0) {
      changes.push(deleteFrom(oldEntry));
      i++;
    } else if (cmp > 0) {
      changes.push(addFrom(newEntry));
      j++;
    } else {
      const change = classifySamePath(oldEntry, newEntry);
      if (change !== undefined) changes.push(change);
      i++;
      j++;
    }
  }

  while (i < oldEntries.length) {
    changes.push(deleteFrom(oldEntries[i]!));
    i++;
  }
  while (j < newEntries.length) {
    changes.push(addFrom(newEntries[j]!));
    j++;
  }

  return { changes };
}
