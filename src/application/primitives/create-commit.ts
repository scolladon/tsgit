import {
  type Commit,
  type HashConfig,
  invalidCommit,
  type ObjectId,
  serializeIdentity,
} from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import type { CreateCommitInput } from './types.js';
import {
  exceedsMaxCommitMessageBytes,
  hasHeaderInjectionChars,
  hasSignatureInjectionChars,
  isInvalidExtraHeaderKey,
  isMalformedParentOid,
  messageContainsNul,
  REASON_EXTRA_HEADER_INJECTION,
  REASON_EXTRA_HEADER_KEY_INVALID,
  REASON_GPG_SIGNATURE_INJECTION,
  REASON_MESSAGE_CONTAINS_NUL,
  REASON_MESSAGE_EXCEEDS_MAX,
  REASON_PARENT_INVALID,
} from './validators.js';
import { writeObject } from './write-object.js';

/** `ObjectId` is a branded string, so a bad upstream cast could smuggle any
 *  value into a `parent <x>` header — this is the last gate before bytes.
 *  Width is checked against the repository hash: a foreign-width oid is
 *  well-formed hex but a permanently unresolvable link in this repo. */
function assertWellFormedParents(parents: ReadonlyArray<ObjectId>, config: HashConfig): void {
  for (const parent of parents) {
    if (isMalformedParentOid(parent, config)) {
      throw invalidCommit(REASON_PARENT_INVALID);
    }
  }
}

export async function createCommit(ctx: Context, input: CreateCommitInput): Promise<ObjectId> {
  assertWellFormedParents(input.parents, ctx.hashConfig);
  if (messageContainsNul(input.message)) {
    throw invalidCommit(REASON_MESSAGE_CONTAINS_NUL);
  }
  if (exceedsMaxCommitMessageBytes(input.message)) {
    throw invalidCommit(REASON_MESSAGE_EXCEEDS_MAX);
  }
  // gpgSignature uses the narrower predicate (NUL/CR only) — a genuine armor
  // block legitimately contains a blank line and a trailing LF. extraHeaders
  // values keep the broader guard since they have no such structural exception.
  if (input.gpgSignature !== undefined && hasSignatureInjectionChars(input.gpgSignature)) {
    throw invalidCommit(REASON_GPG_SIGNATURE_INJECTION);
  }
  if (input.extraHeaders !== undefined) {
    for (const header of input.extraHeaders) {
      if (isInvalidExtraHeaderKey(header.key)) {
        throw invalidCommit(REASON_EXTRA_HEADER_KEY_INVALID);
      }
      if (hasHeaderInjectionChars(header.value)) {
        throw invalidCommit(REASON_EXTRA_HEADER_INJECTION);
      }
    }
  }
  // Validate author / committer by roundtripping through serializeIdentity
  // (which rejects control characters per Step 0(a)).
  serializeIdentity(input.author);
  serializeIdentity(input.committer);

  const commit: Commit = {
    type: 'commit',
    id: '' as ObjectId,
    data: {
      tree: input.tree,
      parents: input.parents,
      author: input.author,
      committer: input.committer,
      message: input.message,
      // Stryker disable next-line ConditionalExpression: equivalent — when gpgSignature is undefined, spreading `{ gpgSignature: undefined }` vs `{}` is invisible to serializeCommitContent (it skips undefined gpgsig), so the written object id is identical
      ...(input.gpgSignature !== undefined ? { gpgSignature: input.gpgSignature } : {}),
      extraHeaders: input.extraHeaders ?? [],
    },
  };
  return writeObject(ctx, commit);
}
