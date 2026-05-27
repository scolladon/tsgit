import type { FilePath } from '../objects/object-id.js';

/**
 * Extracts the entry shape `E` from a `Snapshot<E>` constraint. Used by
 * the join row types to project each slot's entry shape onto the merged
 * row.
 */
export type EntryOf<X> = X extends { entries(opts?: unknown): AsyncIterable<infer E> } ? E : never;

/**
 * Outer-join row — `path` is mandatory, every named slot is OPTIONAL.
 * A slot is `undefined` for rows where that source did not contribute
 * an entry at the given path.
 */
export type OuterJoinRow<S> = {
  readonly path: FilePath;
} & {
  readonly [K in keyof S]?: EntryOf<S[K]>;
};

/**
 * Inner-join row — `path` is mandatory and every named slot is REQUIRED
 * (no `?`). Only rows where every source contributed an entry at the
 * given path are emitted.
 */
export type InnerJoinRow<S> = {
  readonly path: FilePath;
} & {
  readonly [K in keyof S]: EntryOf<S[K]>;
};
