/**
 * Shared test fixtures for operator tests.
 *
 * Every fixture is a small async generator paired with a closure variable that
 * exposes the tracked state to the caller. Keep each fixture compact and
 * self-documenting — they are the verification scaffold for cleanup tests.
 */

export interface TrackedRange {
  readonly source: AsyncIterable<number>;
  readonly returnCalled: () => boolean;
}

export function trackedRange(n: number): TrackedRange {
  let aborted = false;
  async function* gen(): AsyncIterable<number> {
    let completed = false;
    try {
      for (let i = 0; i < n; i += 1) {
        yield i;
      }
      completed = true;
    } finally {
      if (!completed) {
        aborted = true;
      }
    }
  }
  const source = gen();
  return {
    source,
    returnCalled: (): boolean => aborted,
  };
}

export function throwingAt(throwAt: number, n: number): AsyncIterable<number> {
  async function* gen(): AsyncIterable<number> {
    for (let i = 0; i < n; i += 1) {
      if (i === throwAt) {
        throw new Error(`throwingAt: threw at item ${throwAt}`);
      }
      yield i;
    }
  }
  return gen();
}

export interface PullCounter {
  readonly source: AsyncIterable<number>;
  readonly pullCount: () => number;
}

export function pullCounter(): PullCounter {
  let pulls = 0;
  async function* gen(): AsyncIterable<number> {
    for (let i = 0; i < Number.MAX_SAFE_INTEGER; i += 1) {
      pulls += 1;
      yield i;
    }
  }
  const source = gen();
  return {
    source,
    pullCount: (): number => pulls,
  };
}

export interface PipelineStages {
  readonly stage0: AsyncIterable<number>;
  readonly stage1: (source: AsyncIterable<number>) => AsyncIterable<number>;
  readonly stage2: (source: AsyncIterable<number>) => AsyncIterable<number>;
  readonly stage3: (source: AsyncIterable<number>) => AsyncIterable<number>;
  readonly returnCalled: () => {
    s0: boolean;
    s1: boolean;
    s2: boolean;
    s3: boolean;
  };
}

export function trackedPipeline4(n: number): PipelineStages {
  const flags = { s0: false, s1: false, s2: false, s3: false };
  async function* s0Gen(): AsyncIterable<number> {
    let completed = false;
    try {
      for (let i = 0; i < n; i += 1) {
        yield i;
      }
      completed = true;
    } finally {
      if (!completed) {
        flags.s0 = true;
      }
    }
  }
  const makeStage = (key: 's1' | 's2' | 's3') =>
    async function* (source: AsyncIterable<number>): AsyncIterable<number> {
      let completed = false;
      try {
        for await (const v of source) {
          yield v;
        }
        completed = true;
      } finally {
        if (!completed) {
          flags[key] = true;
        }
      }
    };
  return {
    stage0: s0Gen(),
    stage1: makeStage('s1'),
    stage2: makeStage('s2'),
    stage3: makeStage('s3'),
    returnCalled: () => ({ ...flags }),
  };
}

export function awaitable<T>(producer: () => T): PromiseLike<T> {
  return {
    // biome-ignore lint/suspicious/noThenProperty: the whole purpose of this fixture is to impersonate a PromiseLike — the `then` property is structurally required by ES2022 await semantics
    then<U = T, V = never>(
      onfulfilled?: ((value: T) => U | PromiseLike<U>) | null,
      onrejected?: ((reason: unknown) => V | PromiseLike<V>) | null,
    ): PromiseLike<U | V> {
      return new Promise<U | V>((resolve, reject) => {
        queueMicrotask(() => {
          try {
            const produced = producer();
            if (onfulfilled) {
              resolve(onfulfilled(produced));
            } else {
              resolve(produced as unknown as U);
            }
          } catch (error) {
            if (onrejected) {
              resolve(onrejected(error));
            } else {
              reject(error);
            }
          }
        });
      });
    },
  };
}

export function throwingPredicate<T>(
  throwFor: (value: T) => boolean,
  error: Error,
): (value: T) => Promise<boolean> {
  return async (value: T): Promise<boolean> => {
    if (throwFor(value)) {
      throw error;
    }
    return false;
  };
}

export async function* fromArray<T>(items: readonly T[]): AsyncIterable<T> {
  for (const item of items) {
    yield item;
  }
}

export function abortableRange(abortAt: number, n: number): AsyncIterable<number> {
  async function* gen(): AsyncIterable<number> {
    for (let i = 0; i < n; i += 1) {
      if (i >= abortAt) {
        return;
      }
      yield i;
    }
  }
  return gen();
}
