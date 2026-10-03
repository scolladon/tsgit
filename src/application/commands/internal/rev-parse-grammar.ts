import { revparseUnresolved } from '../../../domain/commands/error.js';

/**
 * Pure parser for the revision-expression grammar. Turns a raw expression into
 * a structured `RevExpression`; evaluation (lookup against the repository) is a
 * separate concern handled by tier-1 commands.
 *
 * Grammar (subset accepted):
 *   - empty                       throws REVPARSE_UNRESOLVED
 *   - `:<stage>:<path>`           IndexStage (stage in 0..3, path non-empty)
 *   - `<tree-ish>:<path>`         TreePath — a `:` outside any `@{…}`/`^{…}`
 *                                 splits the tree-ish from the path (path may be empty)
 *   - `<base>` `<op>*`            RefOrHex with chained operations
 *
 * Operations, read from the right as git's `get_oid_1` does:
 *   - `~N`            ancestor (first-parent N times); `~` alone is `~1`
 *   - `^N`            parent N (1-based; 1 = first parent); `^` alone is `^1`
 *   - `^{<type>}`     peel to type (commit | tree | blob | tag), or `object`: any kind
 *   - `^{}`           dereference tags until a non-tag
 *   - `^{/<regex>}`   the youngest commit reachable from the peeled commit whose
 *                     message matches; `^{/}` is the commit itself
 * A peel opens at the last `^{` and its kind is read from the start of what
 * follows, the rest up to the final `}` ignored (`HEAD^{commit}x}`), so a
 * search pattern may hold any character.
 *
 * A reflog `@{…}` selector closes the base, before any operation:
 *   `<base> @{ <selector> } <op>*`
 * A digits-only body is an index; anything else is a date string the evaluator
 * resolves. An empty base (bare `@{N}`) is allowed and resolves against the
 * current branch.
 */

export type PeelTarget = 'commit' | 'tree' | 'blob' | 'tag' | 'object';

export type RevOperation =
  | { readonly kind: 'parent'; readonly n: number }
  | { readonly kind: 'ancestor'; readonly n: number }
  /** `name` spells the expression up to this operator's `}` — the name git reports a mismatch under. */
  | { readonly kind: 'peel'; readonly target: PeelTarget; readonly name: string }
  /** `name` spells the expression before this `^{}` — the name git reports a missing object under. */
  | { readonly kind: 'deref'; readonly name: string }
  /** `name` spells the expression up to this operator's `}`, as for `peel`. */
  | { readonly kind: 'search'; readonly pattern: string; readonly name: string };

export type ReflogSelector =
  | { readonly kind: 'index'; readonly n: number }
  | { readonly kind: 'date'; readonly raw: string };

export type RevExpression =
  | {
      readonly kind: 'ref-or-hex';
      readonly base: string;
      readonly reflog?: ReflogSelector;
      readonly operations: ReadonlyArray<RevOperation>;
    }
  | {
      readonly kind: 'index-stage';
      readonly stage: 0 | 1 | 2 | 3;
      readonly path: string;
    }
  | {
      readonly kind: 'tree-path';
      readonly rev: string;
      readonly path: string;
    };

const PEEL_TARGETS: ReadonlyArray<PeelTarget> = ['commit', 'tree', 'blob', 'tag', 'object'];
const INDEX_STAGE_PATTERN = /^:(\d):(.+)$/;
const TRAILING_STEP_PATTERN = /([~^])(\d*)$/;
const DIGITS_ONLY_PATTERN = /^\d+$/;
/** What no ref name, object id or describe output can hold. */
const FOREIGN_BASE_PATTERN = /[~^]|@\{/;
const PEEL_OPENER = '^{';
const REFLOG_OPENER = '@{';
const CLOSER = '}';
/** git's reflog scan needs room for the `@{` opener, a body and the closer. */
const MIN_BRACED_LENGTH = 4;

const fail = (raw: string): never => {
  throw revparseUnresolved(raw);
};

export const parseExpression = (raw: string): RevExpression => {
  // Stryker disable next-line ConditionalExpression: equivalent — when this guard is removed, '' still fails identically: parseRefOrHex's `base === ''` guard throws revparseUnresolved('') for the same input.
  if (raw === '') fail(raw);
  if (raw.startsWith(':')) return parseIndexStage(raw);
  // A colon outside any `@{…}` selector or `^{…}` peel splits `<tree-ish>:<path>`
  // — git resolves this everywhere, not just in `show`. Colons inside the
  // braces (ISO dates, search patterns) belong to them, so the scan tracks depth.
  const colon = findTreePathColon(raw);
  if (colon !== -1) {
    return { kind: 'tree-path', rev: raw.slice(0, colon), path: raw.slice(colon + 1) };
  }
  return parseRefOrHex(raw);
};

/** Index of the first `:` outside any `@{…}`/`^{…}` region, or -1. */
const findTreePathColon = (raw: string): number => {
  let depth = 0;
  // Stryker disable next-line EqualityOperator: equivalent — at i === raw.length, raw[i] is undefined and matches none of '@'/'^'/'}'/':' , so the extra iteration is a harmless no-op.
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if ((ch === '@' || ch === '^') && raw[i + 1] === '{') {
      depth += 1;
    } else if (depth > 0 && ch === CLOSER) {
      depth -= 1;
    } else if (depth === 0 && ch === ':') {
      return i;
    }
  }
  return -1;
};

const parseIndexStage = (raw: string): RevExpression => {
  const match = INDEX_STAGE_PATTERN.exec(raw);
  if (match === null) fail(raw);
  const stageStr = (match as RegExpMatchArray)[1] as string;
  const path = (match as RegExpMatchArray)[2] as string;
  const stage = Number(stageStr);
  // `INDEX_STAGE_PATTERN` captures a single digit, so `stage` is always 0..9 — only the upper bound can be exceeded.
  if (stage > 3) fail(raw);
  // The `(.+)` capture in `INDEX_STAGE_PATTERN` guarantees `path` is non-empty,
  // so no empty-path guard is needed here.
  return { kind: 'index-stage', stage: stage as 0 | 1 | 2 | 3, path };
};

interface Step {
  readonly op: RevOperation;
  readonly rest: string;
}

/** git's `get_oid_1`: strip operations off the right until only the base remains. */
const parseRefOrHex = (raw: string): RevExpression => {
  const reversed: RevOperation[] = [];
  let rest = raw;
  for (let step = trailingStep(rest); step !== undefined; step = trailingStep(rest)) {
    reversed.push(step.op);
    rest = step.rest;
  }
  return { ...parseBase(rest, raw), operations: reversed.reverse() };
};

const trailingStep = (name: string): Step | undefined => trailingCount(name) ?? trailingPeel(name);

/** A trailing `~<n>` or `^<n>`; no count steps once. */
const trailingCount = (name: string): Step | undefined => {
  const match = TRAILING_STEP_PATTERN.exec(name);
  if (match === null) return undefined;
  const [, operator, digits] = match as unknown as readonly [string, string, string];
  const n = digits === '' ? 1 : Number(digits);
  const op: RevOperation = operator === '~' ? { kind: 'ancestor', n } : { kind: 'parent', n };
  return { op, rest: name.slice(0, match.index) };
};

/** git's `peel_onion`: the last `^{`, its kind read from what follows it. */
const trailingPeel = (name: string): Step | undefined => {
  if (!name.endsWith(CLOSER)) return undefined;
  const opener = name.lastIndexOf(PEEL_OPENER);
  if (opener === -1) return undefined;
  const op = peelOperation(name, opener);
  return op === undefined ? undefined : { op, rest: name.slice(0, opener) };
};

const peelOperation = (name: string, opener: number): RevOperation | undefined => {
  const body = name.slice(opener + PEEL_OPENER.length);
  const target = PEEL_TARGETS.find((type) => body.startsWith(`${type}${CLOSER}`));
  if (target !== undefined) return { kind: 'peel', target, name };
  if (body.startsWith(CLOSER)) return { kind: 'deref', name: name.slice(0, opener) };
  if (body.startsWith('/')) return { kind: 'search', pattern: body.slice(1, -1), name };
  return undefined;
};

/** The base and its reflog selector; a base no ref, oid or describe name can spell is refused. */
const parseBase = (
  name: string,
  raw: string,
): { readonly kind: 'ref-or-hex'; readonly base: string; readonly reflog?: ReflogSelector } => {
  const selected = splitReflog(name);
  const base = selected?.base ?? name;
  if (FOREIGN_BASE_PATTERN.test(base)) fail(raw);
  if (selected === undefined) {
    if (base === '') fail(raw);
    return { kind: 'ref-or-hex', base };
  }
  return { kind: 'ref-or-hex', base, reflog: selected.reflog };
};

/** git's `get_oid_basic`: a closing `@{<body>}`, its opener the last one with a non-empty body. */
const splitReflog = (
  name: string,
): { readonly base: string; readonly reflog: ReflogSelector } | undefined => {
  if (name.length < MIN_BRACED_LENGTH || !name.endsWith(CLOSER)) return undefined;
  const at = name.lastIndexOf(REFLOG_OPENER, name.length - MIN_BRACED_LENGTH);
  if (at === -1) return undefined;
  const body = name.slice(at + REFLOG_OPENER.length, -1);
  const reflog: ReflogSelector = DIGITS_ONLY_PATTERN.test(body)
    ? { kind: 'index', n: Number(body) }
    : { kind: 'date', raw: body };
  return { base: name.slice(0, at), reflog };
};
