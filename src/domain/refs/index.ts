// Error types
export type { RefsError, ReftableCheck } from './error.js';
export { invalidPackedRefs, invalidRef, invalidReftable } from './error.js';

// Loose refs
export { parseLooseRef, serializeDirectRef, serializeSymbolicRef } from './loose-ref.js';

// Packed refs
export { parsePackedRefs, serializePackedRefs } from './packed-refs.js';

// Peel
export type { PeelResult } from './peel.js';
export { peelOneLevel } from './peel.js';
// Per-worktree ref classification (worktree gitdir vs common dir)
export { isPerWorktreeRef } from './per-worktree-ref.js';
// Revision DWIM candidate ladder (shared by rev-parse + merge)
export { refCandidates } from './ref-candidates.js';
// Ref types
export type { DirectRef, LooseRef, PackedRefEntry, PackedRefs, SymbolicRef } from './ref-types.js';
// Validation
export { isSafeRefName, validateRefName } from './ref-validation.js';
// Reftable codec: header, footer, varint and block framing
export type { Reftable, ReftableFooter, ReftableHeader } from './reftable/reftable-format.js';
export { parseReftable } from './reftable/reftable-format.js';
