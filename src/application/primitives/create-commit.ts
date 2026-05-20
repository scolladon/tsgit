import {
  type Commit,
  invalidCommit,
  type ObjectId,
  serializeIdentity,
} from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import type { CreateCommitInput } from './types.js';
import {
  exceedsMaxCommitMessageBytes,
  hasHeaderInjectionChars,
  isInvalidExtraHeaderKey,
  messageContainsNul,
  REASON_EXTRA_HEADER_INJECTION,
  REASON_EXTRA_HEADER_KEY_INVALID,
  REASON_GPG_SIGNATURE_INJECTION,
  REASON_MESSAGE_CONTAINS_NUL,
  REASON_MESSAGE_EXCEEDS_MAX,
} from './validators.js';
import { writeObject } from './write-object.js';

export async function createCommit(ctx: Context, input: CreateCommitInput): Promise<ObjectId> {
  if (messageContainsNul(input.message)) {
    throw invalidCommit(REASON_MESSAGE_CONTAINS_NUL);
  }
  if (exceedsMaxCommitMessageBytes(input.message)) {
    throw invalidCommit(REASON_MESSAGE_EXCEEDS_MAX);
  }
  // Reject NUL / bare-LF-LF in gpgSignature and extraHeaders values — those
  // characters would break the object wire-format's header/message boundary and
  // enable commit-object content injection.
  if (input.gpgSignature !== undefined && hasHeaderInjectionChars(input.gpgSignature)) {
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
