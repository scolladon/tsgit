/**
 * Callback return that may be resolved synchronously or via any thenable.
 * Uses `PromiseLike<T>` — the exact shape `await` accepts under ES2022 —
 * so custom thenables and test doubles compose cleanly.
 */
export type Awaitable<T> = T | PromiseLike<T>;
