/**
 * Determinism detector for parity scenario fixtures.
 *
 * Flags non-deterministic time/randomness sources that would break the
 * cross-adapter golden assertion (`commit.id` is SHA-1 of bytes — a single
 * non-deterministic byte and the assertion fails). The detector is
 * line-based + regex; matches inside line comments are ignored.
 *
 * Detected patterns:
 *   - `Date.now(`
 *   - `Math.random` (call or reference)
 *   - `performance.now(`
 *   - `new Date()` (zero args)
 *   - `new Date(<expr>)` where `<expr>` is not a single pinned string literal
 *
 * Pinned string literals (`new Date('2026-01-01')`) are allowed — the value
 * is reproducible across runs.
 */

export type NondeterministicKind =
  | 'Date.now'
  | 'Math.random'
  | 'performance.now'
  | 'new Date()'
  | 'new Date(<non-literal>)';

export interface NondeterministicFinding {
  readonly path: string;
  readonly line: number;
  readonly kind: NondeterministicKind;
}

export interface SourceFile {
  readonly path: string;
  readonly source: string;
}

interface PatternRule {
  readonly kind: NondeterministicKind;
  readonly regex: RegExp;
}

const SIMPLE_PATTERNS: ReadonlyArray<PatternRule> = [
  { kind: 'Date.now', regex: /\bDate\.now\s*\(/ },
  { kind: 'Math.random', regex: /\bMath\.random\b/ },
  { kind: 'performance.now', regex: /\bperformance\.now\s*\(/ },
];

// `new Date()` — empty args.
const NEW_DATE_EMPTY = /\bnew\s+Date\s*\(\s*\)/;
// `new Date(<arg>)` — allowed only if the single arg is a string literal.
const NEW_DATE_PINNED = /\bnew\s+Date\s*\(\s*(['"])[^'"]*\1\s*\)/;
// `new Date(<arg>)` — any invocation with at least one character of args.
const NEW_DATE_ANY = /\bnew\s+Date\s*\(\s*[^)]/;

const stripLineComment = (line: string): string => {
  const idx = line.indexOf('//');
  return idx === -1 ? line : line.slice(0, idx);
};

const classifyNewDate = (line: string): NondeterministicKind | undefined => {
  if (NEW_DATE_EMPTY.test(line)) return 'new Date()';
  if (NEW_DATE_PINNED.test(line)) return undefined;
  if (NEW_DATE_ANY.test(line)) return 'new Date(<non-literal>)';
  return undefined;
};

export const detectNondeterministic = (
  files: ReadonlyArray<SourceFile>,
): ReadonlyArray<NondeterministicFinding> => {
  const findings: NondeterministicFinding[] = [];
  for (const file of files) {
    const lines = file.source.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i] ?? '';
      const line = stripLineComment(raw);
      if (line.length === 0) continue;
      for (const rule of SIMPLE_PATTERNS) {
        if (rule.regex.test(line)) {
          findings.push({ path: file.path, line: i + 1, kind: rule.kind });
        }
      }
      const newDateKind = classifyNewDate(line);
      if (newDateKind !== undefined) {
        findings.push({ path: file.path, line: i + 1, kind: newDateKind });
      }
    }
  }
  return findings;
};
