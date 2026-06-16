/**
 * @deprecated — Source of truth moved to `primitives/internal/repo-state.ts`.
 * This shim keeps the existing command imports working; new callers should
 * import from the primitives location.
 */
export {
  assertNoPendingOperation,
  assertNotBare,
  assertNoValuelessCorePaths,
  assertOperationalRepository,
  assertRepository,
  isBare,
  readHeadRaw,
} from '../../primitives/internal/repo-state.js';
