export { buildConeSpec, coneMatcher, parseCone, serializeCone } from './cone.js';
export { compileSparseRule, nonConeMatcher } from './non-cone.js';
export {
  buildSparseMatcher,
  MAX_SPARSE_PATTERN_BYTES,
  MAX_SPARSE_PATTERNS,
  type ParsedSparseCheckout,
  parseSparseCheckout,
} from './parse-sparse-checkout.js';
export type { SparseMatcher, SparseRule, SparseSpec } from './sparse-pattern.js';
