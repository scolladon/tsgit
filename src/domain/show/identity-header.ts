/**
 * The two-line identity header `git show` prints for an `Author` (commit) or
 * `Tagger` (annotated tag): `<label>: <name> <<email>>` followed by
 * `Date:   <medium-format date>`.
 */
import type { AuthorIdentity } from '../objects/index.js';
import { formatGitDate } from './git-date.js';

export function renderIdentityHeader(
  label: string,
  identity: AuthorIdentity,
): ReadonlyArray<string> {
  return [
    `${label}: ${identity.name} <${identity.email}>`,
    `Date:   ${formatGitDate(identity.timestamp, identity.timezoneOffset)}`,
  ];
}
