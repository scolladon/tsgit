/**
 * Cache-tree (`TREE` extension) serializer — the exact inverse of
 * `parseCacheTree`. Emits index bytes whose oid width is the caller's
 * `digestLength`.
 *
 * @writes
 *   surface: index
 *   kind:    equivalent-under-readback
 *   format:  git-index-dirc
 */
import { encode, hexToBytes } from '../objects/encoding.js';
import type { FilePath } from '../objects/object-id.js';
import { invalidIndexEntry } from './error.js';
import type { CacheTreeEntry } from './index-entry.js';

const NUL = 0;

interface EncodedNode {
  readonly path: Uint8Array;
  readonly header: Uint8Array;
  readonly oid: Uint8Array;
  readonly children: ReadonlyArray<EncodedNode>;
}

function encodeOid(entry: CacheTreeEntry, digestLength: 20 | 32): Uint8Array {
  if (entry.entryCount < 0 || entry.id === undefined) return new Uint8Array(0);
  const oid = hexToBytes(entry.id);
  if (oid.length !== digestLength) {
    throw invalidIndexEntry(0, 'cache-tree oid width does not match the digest length');
  }
  return oid;
}

function measure(entry: CacheTreeEntry, digestLength: 20 | 32): EncodedNode {
  return {
    path: encode(entry.path),
    header: encode(`${entry.entryCount} ${entry.subtreeCount}\n`),
    oid: encodeOid(entry, digestLength),
    children: entry.children.map((child) => measure(child, digestLength)),
  };
}

function sizeOf(node: EncodedNode): number {
  let size = node.path.length + 1 + node.header.length + node.oid.length;
  for (const child of node.children) size += sizeOf(child);
  return size;
}

function write(node: EncodedNode, out: Uint8Array, start: number): number {
  let cursor = start;
  out.set(node.path, cursor);
  cursor += node.path.length;
  out[cursor++] = NUL;
  out.set(node.header, cursor);
  cursor += node.header.length;
  out.set(node.oid, cursor);
  cursor += node.oid.length;
  for (const child of node.children) cursor = write(child, out, cursor);
  return cursor;
}

export function serializeCacheTree(root: CacheTreeEntry, digestLength: 20 | 32): Uint8Array {
  const node = measure(root, digestLength);
  const out = new Uint8Array(sizeOf(node));
  write(node, out, 0);
  return out;
}

function invalidated(
  entry: CacheTreeEntry,
  children: ReadonlyArray<CacheTreeEntry>,
): CacheTreeEntry {
  return {
    path: entry.path,
    entryCount: -1,
    subtreeCount: entry.subtreeCount - (entry.children.length - children.length),
    children,
  };
}

function invalidateAlong(entry: CacheTreeEntry, components: ReadonlyArray<string>): CacheTreeEntry {
  const [head, ...rest] = components;
  const index = entry.children.findIndex((child) => child.path === head);
  const child = entry.children[index];
  if (child === undefined) return invalidated(entry, entry.children);
  const next = rest.length === 0 ? undefined : invalidateAlong(child, rest);
  const children =
    next === undefined
      ? entry.children.filter((_, i) => i !== index)
      : entry.children.map((c, i) => (i === index ? next : c));
  return invalidated(entry, children);
}

export function invalidateCacheTree(
  root: CacheTreeEntry,
  paths: ReadonlyArray<FilePath>,
): CacheTreeEntry {
  return paths.reduce((tree, path) => invalidateAlong(tree, path.split('/')), root);
}
