import { encodeEscaped, hasEscapedBytes } from '../objects/encoding.js';
import type { FilePath } from '../objects/index.js';
import { compareBytes } from '../objects/index.js';

const pathEncoder = new TextEncoder();

const encodePath = (path: FilePath): Uint8Array =>
  hasEscapedBytes(path) ? encodeEscaped(path) : pathEncoder.encode(path);

export function comparePaths(a: FilePath, b: FilePath): number {
  return compareBytes(encodePath(a), encodePath(b));
}

export function sortByPath<T>(items: ReadonlyArray<T>, pathOf: (item: T) => FilePath): T[] {
  const encoded = items.map((item) => ({ item, key: encodePath(pathOf(item)) }));
  encoded.sort((a, b) => compareBytes(a.key, b.key));
  return encoded.map((e) => e.item);
}
