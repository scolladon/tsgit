import type { AuthorIdentity } from '../objects/author-identity.js';
import type { ObjectId } from '../objects/object-id.js';

/** One line of a reflog file: a single ref movement from `oldId` to `newId`. */
export interface ReflogEntry {
  readonly oldId: ObjectId;
  readonly newId: ObjectId;
  readonly identity: AuthorIdentity;
  readonly message: string;
  /**
   * The on-disk byte slices this entry was parsed from — `identity` is the
   * verbatim bytes from after the second SP through the closing `>`
   * (name + email, brackets included); `message` is the verbatim bytes
   * after the TAB, with no trailing LF. Present only on entries the files
   * backend parsed from disk; entries built programmatically (append,
   * rename) have no on-disk bytes to preserve and stay raw-less. Carrying
   * these lets a rewrite (`reflog expire`/`delete`) re-emit non-UTF-8
   * content byte-for-byte instead of mangling it through a decode/re-encode
   * round trip.
   */
  readonly raw?: { readonly identity: Uint8Array; readonly message: Uint8Array };
}
