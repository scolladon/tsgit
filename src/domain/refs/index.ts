// Error types
export type { RefsError } from './error.js';
export { invalidPackedRefs, invalidRef } from './error.js';

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
export { validateRefName } from './ref-validation.js';
