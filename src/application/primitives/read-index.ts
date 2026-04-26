import { invalidIndexHeader } from '../../domain/git-index/error.js';
import { type GitIndex, parseIndex } from '../../domain/git-index/index.js';
import { bytesToHex } from '../../domain/objects/encoding.js';
import type { Context } from '../../ports/context.js';
import { indexPath } from './path-layout.js';
import {
  exceedsMaxIndexBytes,
  REASON_INDEX_CHECKSUM_MISMATCH,
  REASON_INDEX_EXCEEDS_MAX,
} from './validators.js';

export async function readIndex(ctx: Context): Promise<GitIndex> {
  const path = indexPath(ctx.layout.gitDir);
  if (!(await ctx.fs.exists(path))) {
    return { version: 2, entries: [], extensions: [] };
  }
  // Pre-check against stat to reject oversized files before allocating.
  const stat = await ctx.fs.stat(path);
  if (exceedsMaxIndexBytes(stat.size)) {
    throw invalidIndexHeader(REASON_INDEX_EXCEEDS_MAX);
  }
  const bytes = await ctx.fs.read(path);
  // Post-check against the actual read size — defeats TOCTOU where a concurrent
  // writer grows the file between stat and read.
  if (exceedsMaxIndexBytes(bytes.length)) {
    throw invalidIndexHeader(REASON_INDEX_EXCEEDS_MAX);
  }

  // Integrity-first: validate trailing checksum BEFORE parsing the structure,
  // so malformed payloads cannot leak parser state through error messages.
  // Trailer size follows the active hash algorithm (SHA-1 = 20, SHA-256 = 32).
  const trailerSize = ctx.hashConfig.digestLength;
  // A file too short to carry the trailer is not a valid index. Reject early —
  // don't silently hand unvalidated bytes to parseIndex.
  if (bytes.length < trailerSize) {
    throw invalidIndexHeader('file is shorter than the hash trailer');
  }
  const payload = bytes.subarray(0, bytes.length - trailerSize);
  const trailerBytes = bytes.subarray(bytes.length - trailerSize);
  const trailer = bytesToHex(trailerBytes);
  const computed = await ctx.hash.hashHex(payload);
  if (computed !== trailer) {
    throw invalidIndexHeader(REASON_INDEX_CHECKSUM_MISMATCH);
  }

  return parseIndex(bytes);
}
