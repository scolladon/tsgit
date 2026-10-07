import { revparseUnresolved } from '../../../domain/commands/error.js';
import { findBranchMark } from '../../../domain/refs/branch-mark.js';

/**
 * Pure parser for the revision-expression grammar. Turns a raw expression into
 * a structured `RevExpression`; evaluation (lookup against the repository) is a
 * separate concern handled by tier-1 commands.
 *
 * Grammar (subset accepted):
 *   - empty                       throws REVPARSE_UNRESOLVED
 *   - `:<stage>:<path>`           IndexStage (stage in 0..3, path non-empty)
 *   - `:<path>`                   IndexStage at stage 0
 *   - `:/<regex>`                 MessageSearch from every ref and HEAD
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

type IndexStage = 0 | 1 | 2 | 3;

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
      readonly stage: IndexStage;
      readonly path: string;
    }
  | { readonly kind: 'message-search'; readonly pattern: string }
  | {
      readonly kind: 'tree-path';
      readonly rev: string;
      readonly path: string;
    };

const PEEL_TARGETS: ReadonlyArray<PeelTarget> = ['commit', 'tree', 'blob', 'tag', 'object'];
const INDEX_STAGE_PATTERN = /^:([0-3]):/;
const MESSAGE_SEARCH_PREFIX = ':/';
const TRAILING_STEP_PATTERN = /([~^])(\d*)$/;
const DIGITS_ONLY_PATTERN = /^\d+$/;
/** What no ref name, object id or describe output can hold. */
const FOREIGN_BASE_PATTERN = /[~^]|@\{/;
/** git's `@{-<n>}` prior-checkout opener: only a whole base may start with it. */
const PRIOR_CHECKOUT_PATTERN = /^@\{-\d+\}$/;
const PRIOR_CHECKOUT_MARK = '-';
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

/** git's `:/<regex>`: a leading `:/` with a pattern after it. */
export const isMessageSearch = (raw: string): boolean =>
  raw.length > MESSAGE_SEARCH_PREFIX.length && raw.startsWith(MESSAGE_SEARCH_PREFIX);

/**
 * git's leading-colon forms: `:/<regex>` (longer than `:/`) searches every
 * ref's history; `:<0-3>:<path>` names an index stage and any other `:<path>`
 * stage 0 — so `:4:x` is the path `4:x`.
 */
const parseIndexStage = (raw: string): RevExpression => {
  if (isMessageSearch(raw)) {
    return { kind: 'message-search', pattern: raw.slice(MESSAGE_SEARCH_PREFIX.length) };
  }
  const staged = INDEX_STAGE_PATTERN.exec(raw);
  const stage = staged === null ? 0 : (Number(staged[1]) as IndexStage);
  const path = raw.slice(staged === null ? 1 : staged[0].length);
  if (path === '') fail(raw);
  return { kind: 'index-stage', stage, path };
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
  const selected = splitReflog(name, raw);
  const base = selected?.base ?? name;
  if (FOREIGN_BASE_PATTERN.test(base) && !spellsBranchName(base)) fail(raw);
  if (selected === undefined) {
    if (base === '') fail(raw);
    return { kind: 'ref-or-hex', base };
  }
  return { kind: 'ref-or-hex', base, reflog: selected.reflog };
};

/** A base git's `interpret_branch_name` may still spell: `@{-<n>}`, or a branch mark. */
const spellsBranchName = (base: string): boolean =>
  PRIOR_CHECKOUT_PATTERN.test(base) || findBranchMark(base) !== undefined;

/** git's `get_oid_basic`: a closing `@{<body>}`, its opener the last one with a
 *  non-empty body; a `@{-<n>}` there is no selector, and only leads the name,
 *  and an `@{upstream}` / `@{push}` mark is none either. */
const splitReflog = (
  name: string,
  raw: string,
): { readonly base: string; readonly reflog: ReflogSelector } | undefined => {
  if (name.length < MIN_BRACED_LENGTH || !name.endsWith(CLOSER)) return undefined;
  const at = name.lastIndexOf(REFLOG_OPENER, name.length - MIN_BRACED_LENGTH);
  if (at === -1) return undefined;
  const body = name.slice(at + REFLOG_OPENER.length, -1);
  if (body.startsWith(PRIOR_CHECKOUT_MARK)) return at === 0 ? undefined : fail(raw);
  if (findBranchMark(name.slice(at))?.branch === '') return undefined;
  const reflog: ReflogSelector = DIGITS_ONLY_PATTERN.test(body)
    ? { kind: 'index', n: Number(body) }
    : { kind: 'date', raw: body };
  return { base: name.slice(0, at), reflog };
};
