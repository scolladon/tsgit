/**
 * git's `make_script_with_merges`: the `--rebase-merges` todo. Branch tips (the
 * second-and-later parents of merges, then HEAD) are walked back first-parent
 * into blocks, each opened by a `reset` to where it forks; `label`s name branch
 * points and merged tips so `merge -C` can recreate each merge. Comment lines
 * (`# Branch …`) are left out, as git strips them before writing the todo.
 */
import type { ObjectId } from '../objects/index.js';
import type { RebaseResetLine, RebaseTodoLine } from './todo.js';

export interface ScriptCommit {
  readonly id: ObjectId;
  readonly parents: ReadonlyArray<ObjectId>;
  readonly subject: string;
  /** Walked yet left out of the todo: already upstream, or originally empty. */
  readonly skipped: boolean;
}

export interface MergesScriptInput {
  /** The walked range, oldest first (git's `--topo-order --reverse`). */
  readonly commits: ReadonlyArray<ScriptCommit>;
  /** The walk's bottom (the first merge base), which the `onto` label stands for. */
  readonly ontoBase: ObjectId | undefined;
  /** Short `refs/heads/` name decorating a commit. */
  readonly branchNames: ReadonlyMap<ObjectId, string>;
  /** Unique abbreviation of every commit a label may fall back to. */
  readonly abbreviations: ReadonlyMap<ObjectId, string>;
  /** Subject of each out-of-range commit a block may reset to. */
  readonly outsideSubjects: ReadonlyMap<ObjectId, string>;
  /** `rebase-cousins`: a block rooted outside the range resets onto the new base. */
  readonly rebaseCousins: boolean;
}

/** git's `GIT_MAX_LABEL_LENGTH`: `NAME_MAX` less `.lock` and slack. */
const MAX_LABEL_LENGTH = 255 - 5 - 16;
const ONTO = 'onto';
const NEW_ROOT = '[new root]';
const HEX = /^[0-9a-fA-F]+$/;
const ALNUM = /^[A-Za-z0-9]$/;

interface LabelState {
  readonly commitToLabel: Map<ObjectId, string>;
  readonly labels: Set<string>;
}

const utf8Length = (char: string): number => new TextEncoder().encode(char).length;

/** git's label sanitizer: alphanumerics and UTF-8 kept, every other run one dash, length-capped. */
const sanitizeLabel = (text: string): string => {
  let out = '';
  let bytes = 0;
  for (const char of text) {
    if (bytes + 1 >= MAX_LABEL_LENGTH) break;
    const width = utf8Length(char);
    if (ALNUM.test(char) || width > 1) {
      if (bytes + width > MAX_LABEL_LENGTH) break;
      out += char;
      bytes += width;
    } else if (out !== '' && !out.endsWith('-')) {
      out += '-';
      bytes += 1;
    }
  }
  return out;
};

const abbreviationOf = (input: MergesScriptInput, oid: ObjectId): string =>
  input.abbreviations.get(oid) ?? oid.slice(0, 7);

/** A commit outside the range's abbreviation, lengthened until no label clashes. */
const uniqueAbbreviation = (state: LabelState, abbrev: string, oid: ObjectId): string => {
  if (!state.labels.has(abbrev)) return abbrev;
  // Stryker disable next-line EqualityOperator: equivalent — the extra turn at `length === oid.length` tries `oid` itself, and returning it there or falling through to `return oid` yields the same label.
  for (let length = abbrev.length + 1; length < oid.length; length += 1) {
    if (!state.labels.has(oid.slice(0, length))) return oid.slice(0, length);
  }
  return oid;
};

/** A label must not read as a full oid. git also refuses `#`, which a sanitized label never is. */
const clashes = (state: LabelState, label: string, oid: ObjectId): boolean =>
  (label.length === oid.length && HEX.test(label)) || state.labels.has(label);

const uniqueLabel = (state: LabelState, label: string, oid: ObjectId): string => {
  if (!clashes(state, label, oid)) return label;
  let suffix = 2;
  while (state.labels.has(`${label}-${suffix}`)) suffix += 1;
  return `${label}-${suffix}`;
};

/** git's `label_oid`: the commit's existing label, else a fresh unique one. */
const labelOid = (
  input: MergesScriptInput,
  state: LabelState,
  oid: ObjectId,
  wanted: string | undefined,
): string => {
  const existing = state.commitToLabel.get(oid);
  if (existing !== undefined) return existing;
  const label =
    wanted === undefined
      ? uniqueAbbreviation(state, abbreviationOf(input, oid), oid)
      : uniqueLabel(state, sanitizeLabel(wanted) || `rev-${abbreviationOf(input, oid)}`, oid);
  state.labels.add(label);
  state.commitToLabel.set(oid, label);
  return label;
};

const MERGED_BRANCH = /^# Merge [^']*'([^']*)'/;
const PULL_REQUEST = /^# Merge pull request .*? from (.*)$/;

/** The label a merge's subject suggests for the branch it merged. */
const labelFromMessage = (subject: string): string => {
  const oneline = `# ${subject}`;
  return MERGED_BRANCH.exec(oneline)?.[1] ?? PULL_REQUEST.exec(oneline)?.[1] ?? oneline;
};

interface Walk {
  readonly byId: Map<ObjectId, ScriptCommit>;
  readonly todo: Map<ObjectId, RebaseTodoLine>;
  readonly tips: ObjectId[];
}

/** First phase: a todo line per kept commit; merged tips in the range become block tips. */
const planCommit = (input: MergesScriptInput, state: LabelState, walk: Walk, c: ScriptCommit) => {
  if (c.skipped) return;
  const [, ...toMerge] = c.parents;
  if (toMerge.length === 0) {
    walk.todo.set(c.id, { action: 'pick', oid: c.id, subject: c.subject });
    return;
  }
  const fromMessage = labelFromMessage(c.subject);
  const labels = toMerge.map((parent) => {
    if (!walk.byId.has(parent)) return labelOid(input, state, parent, undefined);
    walk.tips.push(parent);
    return labelOid(input, state, parent, input.branchNames.get(parent) ?? fromMessage);
  });
  walk.todo.set(c.id, { action: 'merge', oid: c.id, labels, subject: c.subject });
};

/** Second phase: a commit with several children in the range is a `branch-point`. */
const labelBranchPoints = (input: MergesScriptInput, state: LabelState, walk: Walk): void => {
  const childSeen = new Set<ObjectId>();
  for (const c of input.commits) {
    for (const parent of c.parents) {
      if (!walk.byId.has(parent)) continue;
      if (childSeen.has(parent)) labelOid(input, state, parent, 'branch-point');
      childSeen.add(parent);
    }
  }
  const head = input.commits.at(-1);
  if (head !== undefined) walk.tips.push(head.id);
};

const subjectOf = (input: MergesScriptInput, walk: Walk, oid: ObjectId): string =>
  walk.byId.get(oid)?.subject ?? input.outsideSubjects.get(oid) ?? '';

/** Where a block forks from: `onto`, a label, or (for a cousin) its parent's abbreviation. */
const resetLine = (
  input: MergesScriptInput,
  state: LabelState,
  walk: Walk,
  fork: ObjectId | undefined,
): RebaseResetLine => {
  if (fork === undefined) {
    return { action: 'reset', label: input.rebaseCousins ? ONTO : NEW_ROOT };
  }
  const to =
    state.commitToLabel.get(fork) ??
    (input.rebaseCousins ? undefined : labelOid(input, state, fork, undefined));
  if (to === undefined || to === ONTO) return { action: 'reset', label: ONTO };
  return { action: 'reset', label: to, subject: subjectOf(input, walk, fork) };
};

/** The tip's not-yet-shown first-parent chain, oldest first, and the commit it forks from. */
const blockOf = (walk: Walk, shown: ReadonlySet<ObjectId>, tip: ObjectId) => {
  const chain: ObjectId[] = [];
  let fork: ObjectId | undefined = tip;
  while (fork !== undefined && walk.byId.has(fork) && !shown.has(fork)) {
    chain.unshift(fork);
    fork = walk.byId.get(fork)?.parents[0];
  }
  return { chain, fork };
};

/** Third phase: each tip's block, its lines and labels, in tip order. */
const emitBlocks = (input: MergesScriptInput, state: LabelState, walk: Walk) => {
  const out: RebaseTodoLine[] = [{ action: 'label', label: ONTO }];
  const shown = new Set<ObjectId>();
  for (const tip of walk.tips) {
    if (shown.has(tip)) continue;
    const branch = state.commitToLabel.get(tip);
    const { chain, fork } = blockOf(walk, shown, tip);
    const reset = resetLine(input, state, walk, fork);
    out.push(branch !== undefined ? { ...reset, branch } : reset);
    for (const oid of chain) {
      const line = walk.todo.get(oid);
      if (line !== undefined) out.push(line);
      const label = state.commitToLabel.get(oid);
      if (label !== undefined) out.push({ action: 'label', label });
      shown.add(oid);
    }
  }
  return out;
};

export const makeScriptWithMerges = (input: MergesScriptInput): ReadonlyArray<RebaseTodoLine> => {
  const state: LabelState = { commitToLabel: new Map(), labels: new Set() };
  if (input.ontoBase !== undefined) {
    state.commitToLabel.set(input.ontoBase, ONTO);
    state.labels.add(ONTO);
  }
  const walk: Walk = { byId: new Map(), todo: new Map(), tips: [] };
  for (const c of input.commits) {
    walk.byId.set(c.id, c);
    planCommit(input, state, walk, c);
  }
  labelBranchPoints(input, state, walk);
  return emitBlocks(input, state, walk);
};
