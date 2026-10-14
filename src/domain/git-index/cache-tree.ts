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

const nameBytesOf = (entry: CacheTreeEntry): Uint8Array => entry.nameBytes ?? encode(entry.path);

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
    path: nameBytesOf(entry),
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

/**
 * Children are matched by their byte name, never by the decoded `path`: two
 * siblings may decode to the same string (BOM-prefixed or non-UTF-8 names).
 * ASCII components are their own key, so the common case allocates nothing.
 */
const NON_ASCII = /[\u0080-\uffff]/;

const keyOfBytes = (bytes: Uint8Array): string => {
  let key = '';
  for (const byte of bytes) key += String.fromCharCode(byte);
  return key;
};

const keyOfComponent = (component: string): string =>
  NON_ASCII.test(component) ? keyOfBytes(encode(component)) : component;

const keyOfChild = (child: CacheTreeEntry): string =>
  child.nameBytes === undefined ? keyOfComponent(child.path) : keyOfBytes(child.nameBytes);

/**
 * git never writes two subtrees of one node under the same name; a payload that does
 * would let invalidation miss the twin and keep it valid over a changed path.
 */
export function namesEachSubtreeOnce(entry: CacheTreeEntry): boolean {
  const seen = new Set<string>();
  for (const child of entry.children) {
    const key = keyOfChild(child);
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return entry.children.every(namesEachSubtreeOnce);
}

type Pending = ReadonlyArray<string>;

function groupByComponent(pending: ReadonlyArray<Pending>, depth: number): Map<string, Pending[]> {
  const groups = new Map<string, Pending[]>();
  for (const item of pending) {
    const key = keyOfComponent(item[depth] as string);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [item]);
    else group.push(item);
  }
  return groups;
}

function reachesLeaf(group: ReadonlyArray<Pending>, depth: number): boolean {
  return group.some((item) => item.length === depth + 1);
}

function rebuildChildren(
  entry: CacheTreeEntry,
  groups: Map<string, Pending[]>,
  depth: number,
): ReadonlyArray<CacheTreeEntry> {
  const children: CacheTreeEntry[] = [];
  for (const child of entry.children) {
    const key = groups.size === 0 ? undefined : keyOfChild(child);
    const group = key === undefined ? undefined : groups.get(key);
    if (key !== undefined) groups.delete(key);
    if (group === undefined) children.push(child);
    else if (!reachesLeaf(group, depth)) children.push(invalidateNode(child, group, depth + 1));
  }
  return children;
}

function invalidateNode(
  entry: CacheTreeEntry,
  pending: ReadonlyArray<Pending>,
  depth: number,
): CacheTreeEntry {
  const children = rebuildChildren(entry, groupByComponent(pending, depth), depth);
  return {
    path: entry.path,
    ...(entry.nameBytes === undefined ? {} : { nameBytes: entry.nameBytes }),
    entryCount: -1,
    subtreeCount: entry.subtreeCount - (entry.children.length - children.length),
    children,
  };
}

export function invalidateCacheTree(
  root: CacheTreeEntry,
  paths: ReadonlyArray<FilePath>,
): CacheTreeEntry {
  if (paths.length === 0) return root;
  return invalidateNode(
    root,
    paths.map((path) => path.split('/')),
    0,
  );
}
