/**
 * Pure grammar for the rebase todo list (`.git/rebase-merge/git-rebase-todo`
 * and `done`), the git-faithful work-list of a `rebase`. Each instruction line
 * is `<verb> <oid> # <subject>` for one of the six interactive verbs (`pick`,
 * `reword`, `edit`, `squash`, `fixup`, `drop`) — note the ` # ` separator, which
 * distinguishes it from the `domain/sequencer` grammar (`pick <oid> <subject>`,
 * no `#`) used by cherry-pick / revert. A non-interactive rebase only ever emits
 * `pick`. `serializeRebaseTodo` writes **full** oids (git re-resolves them);
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

const TODO_LINE = /^(pick|reword|edit|squash|fixup|drop) (\S+) # (.*)$/;

export const serializeRebaseTodo = (entries: ReadonlyArray<RebaseTodoEntry>): string =>
  entries.map((e) => `${e.action} ${e.oid} # ${e.subject}\n`).join('');

export const parseRebaseTodo = (text: string): ReadonlyArray<RebaseTodoEntry> => {
  const entries: RebaseTodoEntry[] = [];
  for (const line of text.split('\n')) {
    if (line === '' || line.startsWith('#')) continue;
    const match = TODO_LINE.exec(line);
    if (match === null) throw invalidSequencerTodo(line);
    entries.push({
      action: match[1] as RebaseTodoAction,
      oid: match[2] as string,
      subject: match[3] as string,
    });
  }
  return entries;
};
