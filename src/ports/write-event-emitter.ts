import type { WriteScope } from './write-scope.js';

/**
 * Command side of the write-event triple (ADR-157). Write-boundary primitives
 * depend on this interface only — they cannot observe events, only emit them.
 *
 * Implementations MUST be called AFTER a successful write but BEFORE
 * releasing any acquired lock. See `docs/understand/caching.md` for the
 * lock-ordering protocol; in-process readers rely on the
 * emit-before-release ordering to avoid TOCTOU windows.
 */
export interface WriteEventEmitter {
  emit(scope: WriteScope): void;
}
