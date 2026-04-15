export interface LruCache<V> {
  get(key: string): V | undefined;
  set(key: string, value: V, byteSize: number): void;
  has(key: string): boolean;
  delete(key: string): boolean;
  clear(): void;
  readonly currentSize: number;
  readonly maxSize: number;
  readonly entryCount: number;
}

interface Node<V> {
  readonly key: string;
  value: V;
  byteSize: number;
  prev: Node<V> | null;
  next: Node<V> | null;
}

export function createLruCache<V>(maxSizeBytes: number): LruCache<V> {
  const map = new Map<string, Node<V>>();
  let head: Node<V> | null = null;
  let tail: Node<V> | null = null;
  let currentSize = 0;

  function removeNode(node: Node<V>): void {
    if (node.prev !== null) {
      node.prev.next = node.next;
    } else {
      head = node.next;
    }
    if (node.next !== null) {
      node.next.prev = node.prev;
    } else {
      tail = node.prev;
    }
    node.prev = null;
    node.next = null;
  }

  function addToHead(node: Node<V>): void {
    node.next = head;
    node.prev = null;
    if (head !== null) {
      head.prev = node;
    }
    head = node;
    if (tail === null) {
      tail = node;
    }
  }

  function evict(): void {
    while (currentSize > maxSizeBytes && tail !== null) {
      const evicted = tail;
      removeNode(evicted);
      map.delete(evicted.key);
      currentSize -= evicted.byteSize;
    }
  }

  return {
    get maxSize() {
      return maxSizeBytes;
    },

    get currentSize() {
      return currentSize;
    },

    get entryCount() {
      return map.size;
    },

    get(key: string): V | undefined {
      const node = map.get(key);
      if (node === undefined) {
        return undefined;
      }
      removeNode(node);
      addToHead(node);
      return node.value;
    },

    set(key: string, value: V, byteSize: number): void {
      if (byteSize <= 0) {
        throw new Error('byteSize must be positive');
      }
      if (byteSize > maxSizeBytes) {
        return;
      }
      const existing = map.get(key);
      if (existing !== undefined) {
        currentSize -= existing.byteSize;
        existing.value = value;
        existing.byteSize = byteSize;
        currentSize += byteSize;
        removeNode(existing);
        addToHead(existing);
      } else {
        const node: Node<V> = { key, value, byteSize, prev: null, next: null };
        map.set(key, node);
        addToHead(node);
        currentSize += byteSize;
      }
      evict();
    },

    has(key: string): boolean {
      return map.has(key);
    },

    delete(key: string): boolean {
      const node = map.get(key);
      if (node === undefined) {
        return false;
      }
      removeNode(node);
      map.delete(key);
      currentSize -= node.byteSize;
      return true;
    },

    clear(): void {
      map.clear();
      head = null;
      tail = null;
      currentSize = 0;
    },
  };
}
