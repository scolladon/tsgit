/**
 * Render the listing `git show <tree>` prints: a `tree <input-rev>` header
 * (echoing the caller's revision string verbatim), a blank line, then the
 * immediate entry names in stored order — names only, a trailing `/` for
 * sub-trees.
 */
import { type FileMode, isDirectory } from '../objects/index.js';

export interface TreeListingEntry {
  readonly name: string;
  readonly mode: FileMode;
}

export function renderTreeListing(
  inputName: string,
  entries: ReadonlyArray<TreeListingEntry>,
): string {
  const names = entries.map((e) => `${e.name}${isDirectory(e.mode) ? '/' : ''}\n`).join('');
  return `tree ${inputName}\n\n${names}`;
}
