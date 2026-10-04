import type { AuthorIdentity } from './author-identity.js';
import type { ObjectId } from './object-id.js';

/** A date git shows beside a candidate: seconds since the epoch, in the `+hhmm` zone git renders it in. */
export type CandidateDate = Pick<AuthorIdentity, 'timestamp' | 'timezoneOffset'>;

/**
 * One object an abbreviated id names among several, as git's `hint:` lists it:
 * a commit with its author date and folded subject; a tag with its tagger
 * date — in UTC, as git shows it, and the epoch when the tag has no tagger —
 * and its tag name as `subject`; a tree or a blob by type alone.
 */
export type AmbiguousCandidate =
  | {
      readonly id: ObjectId;
      readonly type: 'commit' | 'tag';
      readonly date: CandidateDate;
      readonly subject: string;
    }
  | { readonly id: ObjectId; readonly type: 'tree' | 'blob' };
