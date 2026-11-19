import { invalidOption } from '../commands/error.js';
import { tokenizeIgnoreLine } from '../ignore/index.js';
import { coneMatcher, parseCone } from './cone.js';
import { compileSparseRule, nonConeMatcher } from './non-cone.js';
import type {
  SparseMatcher,
  SparseMatchOptions,
  SparseRule,
  SparseSpec,
} from './sparse-pattern.js';

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
const parseNonCone = (
  text: string,
  options: { readonly caseFold?: boolean } = {},
): ReadonlyArray<SparseRule> => {
  // Strip a trailing CR so a CRLF-terminated pattern file (Windows editors,
  // `core.autocrlf`) matches correctly — `tokenizeIgnoreLine` does not, and an
  // unstripped `\r` would compile into a rule that never matches a real path.
  // Mirrors `parseCone`'s CRLF handling.
  const lines = text.split('\n').map((line) => line.replace(/\r$/, ''));
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
    rules.push(compileSparseRule(tokenized, line, options));
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

/**
 * Build a matcher from a parsed sparse spec, dispatching on its mode. With
 * `ignoreCase` (git's `core.ignorecase`) the patterns match ASCII
 * case-insensitively.
 */
export const buildSparseMatcher = (
  spec: SparseSpec,
  options: SparseMatchOptions = {},
): SparseMatcher => {
  if (spec.mode === 'cone') return coneMatcher(spec, options);
  if (options.ignoreCase !== true) return nonConeMatcher(spec.rules);
  // Rules are compiled at parse time, before the case rule is known: re-parse their own lines folded.
  return nonConeMatcher(
    parseNonCone(spec.rules.map((rule) => rule.source).join('\n'), { caseFold: true }),
  );
};
