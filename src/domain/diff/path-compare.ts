import type { FilePath } from '../objects/index.js';
import { compareBytes } from '../objects/index.js';

const pathEncoder = new TextEncoder();

export function comparePaths(a: FilePath, b: FilePath): number {
  return compareBytes(pathEncoder.encode(a), pathEncoder.encode(b));
}

export function sortByPath<T>(items: ReadonlyArray<T>, pathOf: (item: T) => FilePath): T[] {
  const encoded = items.map((item) => ({ item, key: pathEncoder.encode(pathOf(item)) }));
  encoded.sort((a, b) => compareBytes(a.key, b.key));
  return encoded.map((e) => e.item);
}
