/**
 * The two-line identity header `git show` prints for an `Author` (commit) or
 * `Tagger` (annotated tag): `<label>: <name> <<email>>` followed by
 * `Date:   <formatted date>`. The date formatter is injected so `--date=<mode>`
 * threads through; it defaults to the medium (`DATE_NORMAL`) form.
 */
import type { AuthorIdentity } from '../../../src/domain/objects/index.js';
import { formatGitDate } from './git-date.js';

export type DateFormatter = (identity: AuthorIdentity) => string;

export const defaultDateFormatter: DateFormatter = (identity) =>
  formatGitDate(identity.timestamp, identity.timezoneOffset);

export function renderIdentityHeader(
  label: string,
  identity: AuthorIdentity,
  formatDate: DateFormatter = defaultDateFormatter,
): ReadonlyArray<string> {
  return [`${label}: ${identity.name} <${identity.email}>`, `Date:   ${formatDate(identity)}`];
}
