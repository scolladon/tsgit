// Error types
export type { RefsError, ReftableCheck } from './error.js';
export { invalidPackedRefs, invalidRef, invalidReftable, reftableLocked } from './error.js';

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
// Reftable codec: ref, index and obj block record grammar
export type { ReftableRefRecord, ReftableRefValue } from './reftable/reftable-block.js';
export { iterateReftableRefs, lookupReftableRef } from './reftable/reftable-block.js';
// Reftable codec: compaction policy (size metric, geometric merge segment)
export type { CompactionSegment } from './reftable/reftable-compaction.js';
export {
  compactionMetric,
  DEFAULT_GEOMETRIC_FACTOR,
  suggestCompactionSegment,
} from './reftable/reftable-compaction.js';
// Reftable codec: header, footer, varint and block framing
export type { Reftable, ReftableFooter, ReftableHeader } from './reftable/reftable-format.js';
export { parseReftable, readMagicAndVersion } from './reftable/reftable-format.js';
// Reftable codec: log blocks and reflog records
export type { InflateAt, LoadedReftable, ReftableLogRecord } from './reftable/reftable-log.js';
export { iterateReftableLogs, loadReftable } from './reftable/reftable-log.js';
// Reftable codec: stack merge view (multi-table lookup/names/logs)
export type { ReftableStack } from './reftable/reftable-stack.js';
export { createReftableStack } from './reftable/reftable-stack.js';
// Reftable codec: writer (ref/index/obj/log block emission, header/footer framing)
export type { ReftableWriteOptions } from './reftable/reftable-writer.js';
export { buildReftableRefSection, serializeReftable } from './reftable/reftable-writer.js';
