import { escapedPathOf, type IndexPath } from '../git-index/index-path-key.js';
import type { Pathspec } from './compile-pathspec.js';
import { matchesPathspec, matchesUnmergedPath } from './match-pathspec.js';

export const matchesIndexPath = (spec: Pathspec, entry: IndexPath): boolean =>
  matchesPathspec(spec, escapedPathOf(entry));

export const matchesUnmergedIndexPath = (
  spec: Pathspec,
  entry: IndexPath,
  entryCount: number,
): boolean => matchesUnmergedPath(spec, escapedPathOf(entry), entryCount);
