const parentIndex = (index: number): number => (index - 1) >> 1;
const leftChildIndex = (index: number): number => 2 * index + 1;
const rightChildIndex = (index: number): number => 2 * index + 2;

const swap = <T>(values: T[], i: number, j: number): void => {
  const temp = values[i]!;
  values[i] = values[j]!;
  values[j] = temp;
};

const siftUp = <T>(values: T[], less: (a: T, b: T) => boolean, start: number): void => {
  let index = start;
  while (index > 0 && less(values[index]!, values[parentIndex(index)]!)) {
    swap(values, index, parentIndex(index));
    index = parentIndex(index);
  }
};

const smallerChild = <T>(
  values: T[],
  less: (a: T, b: T) => boolean,
  left: number,
  right: number,
): number => (right < values.length && less(values[right]!, values[left]!) ? right : left);

const siftDown = <T>(values: T[], less: (a: T, b: T) => boolean, start: number): void => {
  let index = start;
  for (;;) {
    const left = leftChildIndex(index);
    if (left >= values.length) return;
    const child = smallerChild(values, less, left, rightChildIndex(index));
    if (!less(values[child]!, values[index]!)) return;
    swap(values, index, child);
    index = child;
  }
};

/**
 * Array-backed binary min-heap ordered "by should-pop-first": `less(a, b) === true`
 * means `a` pops before `b`. The backing array is mutated in place, only ever through
 * {@link push}/{@link pop}; {@link entries} hands out a read-only view of it.
 */
export class BinaryHeap<T> {
  private readonly values: T[] = [];

  constructor(private readonly less: (a: T, b: T) => boolean) {}

  push(value: T): void {
    this.values.push(value);
    siftUp(this.values, this.less, this.values.length - 1);
  }

  pop(): T | undefined {
    // equivalent-mutant (if false): on an empty heap this.values[0] and this.values.pop()
    // are both already `undefined`, and the `this.values.length > 0` guard below skips
    // siftDown — dropping this short-circuit is a no-op micro-optimization, not a behavior change.
    if (this.values.length === 0) return undefined;
    const root = this.values[0]!;
    const last = this.values.pop()!;
    if (this.values.length > 0) {
      this.values[0] = last;
      siftDown(this.values, this.less, 0);
    }
    return root;
  }

  size(): number {
    return this.values.length;
  }

  /**
   * A live, read-only view of the unsorted backing entries — returned by reference
   * (zero-copy) so frontier scans stay allocation-free on the hot path. Callers must
   * treat it as read-only; the heap owns the array and re-sifts it on the next push/pop.
   */
  entries(): ReadonlyArray<T> {
    return this.values;
  }
}
