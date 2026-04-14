import type { ObjectId } from './object-id.js';

export interface Blob {
  readonly type: 'blob';
  readonly id: ObjectId;
  readonly content: Uint8Array;
}

export function parseBlobContent(id: ObjectId, content: Uint8Array): Blob {
  return { type: 'blob', id, content };
}

export function serializeBlobContent(blob: Blob): Uint8Array {
  return blob.content;
}
