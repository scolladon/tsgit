import type { AuthorIdentity } from './author-identity.js';
import type { ObjectId } from './object-id.js';

/** A date git shows beside a candidate: seconds since the epoch, in the `+hhmm` zone git renders it in. */
export type CandidateDate = Pick<AuthorIdentity, 'timestamp' | 'timezoneOffset'>;

/**
 * One object an abbreviated id names among several, as git's `hint:` lists it:
 * a commit with its author date and folded subject; a tag with its tagger
 * date — in UTC, as git shows it, and the epoch when the tag has no tagger —
 * and its tag name as `subject`; a tree or a blob by type alone; an object
 * whose type cannot be read as `bad-object` (git's `[bad object]`); a tag whose
 * body git's parser refuses as `bad-tag` (git's `[bad tag, could not parse it]`).
 */
export type AmbiguousCandidate =
  | {
      readonly id: ObjectId;
      readonly type: 'commit' | 'tag';
      readonly date: CandidateDate;
      readonly subject: string;
    }
  | { readonly id: ObjectId; readonly type: 'tree' | 'blob' | 'bad-object' | 'bad-tag' };

/**
 * One read of a candidate's type that failed while git sorted or showed the
 * candidates: the object, and the inflate reason git reports for it on its
 * `inflate: data stream error (<reason>)` and `unable to unpack <id> header` lines.
 */
export interface CandidateReadFault {
  readonly id: ObjectId;
  readonly reason: string;
}
