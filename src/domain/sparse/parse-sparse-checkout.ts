import { invalidOption } from '../commands/error.js';
import { tokenizeIgnoreLine } from '../ignore/index.js';
import { coneMatcher, parseCone } from './cone.js';
import { compileSparseRule, nonConeMatcher } from './non-cone.js';
import type { SparseMatcher, SparseRule, SparseSpec } from './sparse-pattern.js';

/** Maximum UTF-8 byte length of a single sparse-checkout pattern line. */
export const MAX_SPARSE_PATTERN_BYTES = 256;
/** Maximum number of pattern lines in a sparse-checkout file. */
export const MAX_SPARSE_PATTERNS = 2048;

const PATTERN_ENCODER = new TextEncoder();

/** Result of parsing a sparse-checkout pattern file. */
export interface ParsedSparseCheckout {
  readonly spec: SparseSpec;
  /** True when a cone-mode parse fell back to non-cone matching. */
  readonly degraded: boolean;
}

/**
 * Parse the non-cone rules out of a pattern file, enforcing the per-pattern
 * budget — at most `MAX_SPARSE_PATTERNS` effective compiled rules (blank and
 * comment lines do not count), each at most `MAX_SPARSE_PATTERN_BYTES` UTF-8
 * bytes.
 */
const parseNonCone = (text: string): ReadonlyArray<SparseRule> => {
  const lines = text.split('\n');
  const rules: SparseRule[] = [];
  for (const line of lines) {
    if (PATTERN_ENCODER.encode(line).byteLength > MAX_SPARSE_PATTERN_BYTES) {
      throw invalidOption(
        'patterns',
        `pattern exceeds max length ${MAX_SPARSE_PATTERN_BYTES} bytes`,
      );
    }
    const tokenized = tokenizeIgnoreLine(line);
    if (tokenized === undefined) continue;
    if (rules.length >= MAX_SPARSE_PATTERNS) {
      throw invalidOption('patterns', `pattern file exceeds max ${MAX_SPARSE_PATTERNS} patterns`);
    }
    rules.push(compileSparseRule(tokenized, line));
  }
  return rules;
};

/**
 * Parse a `.git/info/sparse-checkout` pattern file. When `coneRequested` is
 * true, a cone-shaped file parses to a cone spec; a non-cone-shaped file
 * falls back to non-cone matching with `degraded: true`.
 */
export const parseSparseCheckout = (text: string, coneRequested: boolean): ParsedSparseCheckout => {
  if (coneRequested) {
    const cone = parseCone(text);
    if (cone !== undefined) return { spec: cone, degraded: false };
    return { spec: { mode: 'no-cone', rules: parseNonCone(text) }, degraded: true };
  }
  return { spec: { mode: 'no-cone', rules: parseNonCone(text) }, degraded: false };
};

/** Build a matcher from a parsed sparse spec, dispatching on its mode. */
export const buildSparseMatcher = (spec: SparseSpec): SparseMatcher => {
  if (spec.mode === 'cone') return coneMatcher(spec);
  return nonConeMatcher(spec.rules);
};
