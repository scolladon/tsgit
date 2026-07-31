import { unexpectedObjectType } from '../../domain/objects/error.js';
import type { ObjectId } from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import { NEVER_BUFFER, openBlobSource } from './internal/blob-source.js';

export interface StreamBlobOptions {
  readonly verifyHash?: boolean;
}

export interface BlobStream extends AsyncIterable<Uint8Array> {
  readonly materialised: boolean;
}

export async function streamBlob(
  ctx: Context,
  id: ObjectId,
  options?: StreamBlobOptions,
): Promise<BlobStream> {
  const source = await openBlobSource(ctx, id, NEVER_BUFFER, options);

  if (source.type !== undefined && source.type !== 'blob') {
    // Refusing discards the stream, so cancel its inflate pipeline first.
    if (source.kind === 'stream') await source.release();
    throw unexpectedObjectType('blob', source.type, id);
  }

  if (source.kind === 'stream') {
    return Object.assign(source.stream, { materialised: false as const });
  }

  return wrapBufferedContent(source.content);
}

function wrapBufferedContent(content: Uint8Array): BlobStream {
  async function* gen(): AsyncIterable<Uint8Array> {
    if (content.length > 0) {
      yield content;
    }
  }
  return Object.assign(gen(), { materialised: true as const });
}
