/**
 * The extra headers an amend carries from the commit it replaces — git's
 * `read_commit_extra_headers` with `gpgsig`/`gpgsig-sha256` excluded: the old
 * signature no longer covers the new commit (`gpgsig` itself is parsed into
 * its own field, never an extra header). `encoding` is a standard header git
 * writes afresh rather than carries.
 */
import type { ExtraHeader } from './commit.js';

const NOT_CARRIED: ReadonlySet<string> = new Set(['gpgsig-sha256', 'encoding']);

export const amendedExtraHeaders = (
  headers: ReadonlyArray<ExtraHeader>,
): ReadonlyArray<ExtraHeader> => headers.filter((header) => !NOT_CARRIED.has(header.key));
