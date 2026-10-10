/**
 * Pure grammar for the rebase todo list (`.git/rebase-merge/git-rebase-todo`
 * and `done`), the git-faithful work-list of a `rebase`. Each instruction line
 * is `<verb> <oid> # <subject>` for one of the six interactive verbs (`pick`,
 * `reword`, `edit`, `squash`, `fixup`, `drop`) — note the ` # ` separator, which
 * distinguishes it from the `domain/sequencer` grammar (`pick <oid> <subject>`,
 * no `#`) used by cherry-pick / revert. A non-interactive rebase only ever emits
 * `pick`; `--rebase-merges` adds `label`, `reset` and `merge -C`. `serializeRebaseTodo` writes **full** oids (git re-resolves them);
 * `parseRebaseTodo` extracts the raw oid token (full or abbreviated) and leaves
 * resolution to the command tier. Blank and `#`-comment lines are ignored so a
 * git-written todo (which carries the help block) and the `.backup` round-trip.
 */
import { invalidSequencerTodo } from '../commands/error.js';

export type RebaseTodoAction = 'pick' | 'reword' | 'edit' | 'squash' | 'fixup' | 'drop';

export interface RebaseTodoEntry {
  readonly action: RebaseTodoAction;
  readonly oid: string;
  readonly subject: string;
}

/** `label <name>`: names the current HEAD `refs/rewritten/<name>`. */
export interface RebaseLabelLine {
  readonly action: 'label';
  readonly label: string;
}

/** `reset <label> [# <oneline>]`: moves HEAD to a label (or a commit-ish). */
export interface RebaseResetLine {
  readonly action: 'reset';
  readonly label: string;
  readonly subject?: string;
  /** The block's tip label, git's `# Branch <label>` header — kept by the backup only. */
  readonly branch?: string;
}

/** `merge -C <oid> <label>… # <oneline>`: recreates a merge with the original's message. */
export interface RebaseMergeLine {
  readonly action: 'merge';
  readonly oid: string;
  readonly labels: ReadonlyArray<string>;
  readonly subject: string;
}

/** One instruction of a todo, `--rebase-merges` verbs included. */
export type RebaseTodoLine = RebaseTodoEntry | RebaseLabelLine | RebaseResetLine | RebaseMergeLine;

const TODO_LINE = /^(pick|reword|edit|squash|fixup|drop) (\S+) # (.*)$/;
const LABEL_LINE = /^label (\S+)$/;
const RESET_LINE = /^reset (\[new root\]|\S+)(?: # (.*))?$/;
const MERGE_LINE = /^merge -C (\S+) (\S.*?) # (.*)$/;

const resetText = (line: RebaseResetLine): string =>
  `reset ${line.label}${line.subject !== undefined ? ` # ${line.subject}` : ''}\n`;

const branchHeader = (line: RebaseTodoLine): string =>
  line.action === 'reset' && line.branch !== undefined ? `# Branch ${line.branch}\n` : '';

// git separates each `--rebase-merges` block — always opened by a `reset` — with a blank line.
const serializeLine = (line: RebaseTodoLine): string => {
  switch (line.action) {
    case 'label':
      return `label ${line.label}\n`;
    case 'reset':
      return `\n${resetText(line)}`;
    case 'merge':
      return `merge -C ${line.oid} ${line.labels.join(' ')} # ${line.subject}\n`;
    default:
      return `${line.action} ${line.oid} # ${line.subject}\n`;
  }
};

export const serializeRebaseTodo = (entries: ReadonlyArray<RebaseTodoLine>): string =>
  entries.map(serializeLine).join('');

/** The todo as generated, before git strips its comments: blocks keep their `# Branch` header. */
export const serializeRebaseScript = (entries: ReadonlyArray<RebaseTodoLine>): string =>
  entries
    .map((line) => {
      const header = branchHeader(line);
      return header === ''
        ? serializeLine(line)
        : `\n${header}${resetText(line as RebaseResetLine)}`;
    })
    .join('');

const parseLine = (line: string): RebaseTodoLine => {
  const pick = TODO_LINE.exec(line);
  if (pick !== null) {
    return { action: pick[1] as RebaseTodoAction, oid: pick[2]!, subject: pick[3]! };
  }
  const label = LABEL_LINE.exec(line);
  if (label !== null) return { action: 'label', label: label[1]! };
  const reset = RESET_LINE.exec(line);
  if (reset !== null) {
    const subject = reset[2];
    // Stryker disable next-line ConditionalExpression: equivalent — a reset's subject is read only through `!== undefined`, so `{ subject: undefined }` reads as no subject
    return { action: 'reset', label: reset[1]!, ...(subject !== undefined ? { subject } : {}) };
  }
  const merge = MERGE_LINE.exec(line);
  if (merge === null) throw invalidSequencerTodo(line);
  return { action: 'merge', oid: merge[1]!, labels: merge[2]!.split(' '), subject: merge[3]! };
};

export const parseRebaseTodo = (text: string): ReadonlyArray<RebaseTodoLine> =>
  text
    .split('\n')
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map(parseLine);
