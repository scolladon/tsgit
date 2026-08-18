/**
 * @deprecated — Source of truth moved to `primitives/internal/repo-state.ts`.
 * This shim keeps the existing command imports working; new callers should
 * import from the primitives location.
 */
export {
  assertEagerConfigValid,
  assertNoPendingOperation,
  assertOperationalRepository,
  assertRepository,
  branchRefFromHead,
  currentBranchRef,
  readHeadRaw,
  requireWorkTree,
} from '../../primitives/internal/repo-state.js';
