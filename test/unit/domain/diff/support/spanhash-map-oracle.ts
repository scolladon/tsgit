import type { ContentKind } from '../../../../../src/domain/diff/similarity.js';

// Independent oracle for the typed SpanFingerprint scorer: the Map-based
// spanhash implementation this part replaces, copied verbatim (bucketOf's
// 32-bit wrap and the CR-of-CRLF skip included) so the typed array rewrite
// is checked against a genuinely separate code path, not itself.

const HASHBASE = 107927;
const MAX_CHUNK_LEN = 64;
const CR = 0x0d;

function bucketOf(accum1: number, accum2: number): number {
  return ((accum1 + Math.imul(accum2, 0x61)) >>> 0) % HASHBASE;
}

function isSkippedCr(kind: ContentKind, data: Uint8Array, i: number, size: number): boolean {
  return kind === 'text' && data[i] === CR && i + 1 < size && data[i + 1] === 0x0a;
}

export function buildChunkMap(data: Uint8Array, kind: ContentKind): Map<number, number> {
  const map = new Map<number, number>();
  const size = data.length;
  let accum1 = 0;
  let accum2 = 0;
  let n = 0;

  for (let i = 0; i < size; i++) {
    if (isSkippedCr(kind, data, i, size)) continue;
    const c = data[i] as number;
    const old1 = accum1;
    accum1 = (((accum1 << 7) ^ (accum2 >>> 25)) + c) >>> 0;
    accum2 = ((accum2 << 7) ^ (old1 >>> 25)) >>> 0;
    n++;
    if (n >= MAX_CHUNK_LEN || c === 0x0a) {
      const hashval = bucketOf(accum1, accum2);
      map.set(hashval, (map.get(hashval) ?? 0) + n);
      n = 0;
      accum1 = 0;
      accum2 = 0;
    }
  }
  if (n > 0) {
    const hashval = bucketOf(accum1, accum2);
    map.set(hashval, (map.get(hashval) ?? 0) + n);
  }

  return map;
}

export function countSrcCopied(srcMap: Map<number, number>, dstMap: Map<number, number>): number {
  let copied = 0;
  for (const [hashval, srcCnt] of srcMap) {
    const dstCnt = dstMap.get(hashval) ?? 0;
    if (dstCnt > 0) copied += Math.min(srcCnt, dstCnt);
  }
  return copied;
}
