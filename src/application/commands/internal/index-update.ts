/**
 * @deprecated — `acquireIndexLock` lives in `primitives/internal/index-lock.ts`.
 * This shim keeps the existing command imports working without duplicating
 * the implementation; new callers should import from the primitives location.
 */
export { acquireIndexLock } from '../../primitives/internal/index-lock.js';
