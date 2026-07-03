import { type ObjectId, serializeIdentity, type Tag } from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import type { CreateTagInput } from './types.js';
import { writeObject } from './write-object.js';

/**
 * Build and write an annotated tag object (`object`/`type`/`tag`/`tagger` +
 * message). Tag-name validity (non-empty, no `\n`/`\0`) is enforced by
 * `serializeTagContent` during `writeObject`; the tagger identity is
 * roundtripped through `serializeIdentity` here first (rejects control
 * characters per Step 0(a)), matching `createCommit`'s author/committer
 * validation.
 */
export async function createTag(ctx: Context, input: CreateTagInput): Promise<ObjectId> {
  serializeIdentity(input.tagger);

  const tag: Tag = {
    type: 'tag',
    id: '' as ObjectId,
    data: {
      object: input.object,
      objectType: input.objectType,
      tagName: input.tagName,
      tagger: input.tagger,
      message: input.message,
      ...(input.gpgSignature !== undefined ? { gpgSignature: input.gpgSignature } : {}),
      extraHeaders: input.extraHeaders ?? [],
    },
  };
  return writeObject(ctx, tag);
}
