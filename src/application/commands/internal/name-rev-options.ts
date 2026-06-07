/**
 * Pure resolver for `name-rev`'s options: normalise the tag-source restriction
 * and the include/exclude ref globs (`string | string[] | undefined` → `string[]`)
 * into the shape `buildRefFilter` consumes.
 */
import type { RefFilterOptions } from '../../../domain/name-rev/index.js';
import type { NameRevOptions } from '../name-rev.js';

const toPatterns = (value: string | ReadonlyArray<string> | undefined): ReadonlyArray<string> => {
  if (value === undefined) return [];
  return typeof value === 'string' ? [value] : value;
};

export const parseNameRevOptions = (opts: NameRevOptions): RefFilterOptions => ({
  tags: opts.tags === true,
  refs: toPatterns(opts.refs),
  exclude: toPatterns(opts.exclude),
});
