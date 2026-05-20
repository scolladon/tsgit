import type { FilePath } from '../objects/index.js';
import type { DiffChange } from './diff-change.js';

/** Primary path key per variant (used for byte-order sort of TreeDiff.changes). */
export function primaryPath(change: DiffChange): FilePath {
  switch (change.type) {
    case 'add':
      return change.newPath;
    case 'delete':
      return change.oldPath;
    case 'rename':
      return change.newPath;
    // Stryker disable next-line ConditionalExpression: equivalent — empty 'modify' case falls through to 'type-change', which also returns change.path
    case 'modify':
      return change.path;
    case 'type-change':
      return change.path;
  }
}
