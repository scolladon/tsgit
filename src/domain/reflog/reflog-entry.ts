import type { AuthorIdentity } from '../objects/author-identity.js';
import type { ObjectId } from '../objects/object-id.js';

/** One line of a reflog file: a single ref movement from `oldId` to `newId`. */
export interface ReflogEntry {
  readonly oldId: ObjectId;
  readonly newId: ObjectId;
  readonly identity: AuthorIdentity;
  readonly message: string;
}
