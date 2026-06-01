/**
 * Pure grammar for the rebase todo list (`.git/rebase-merge/git-rebase-todo`
 * and `done`), the git-faithful work-list of a non-interactive `rebase`. Each
 * instruction line is `pick <oid> # <subject>` — note the ` # ` separator, which
 * distinguishes it from the `domain/sequencer` grammar (`pick <oid> <subject>`,
 * no `#`) used by cherry-pick / revert. `serializeRebaseTodo` emits **full** oids
 * (git re-resolves them); `parseRebaseTodo` extracts the raw oid token (full or
 * abbreviated) and leaves resolution to the command tier. Blank and `#`-comment
 * lines are ignored so a git-written todo (which carries the help block) and the
 * `.backup` round-trip.
 */
import { invalidSequencerTodo } from '../commands/error.js';

export interface RebaseTodoEntry {
  readonly oid: string;
  readonly subject: string;
}

const TODO_LINE = /^pick (\S+) # (.*)$/;

export const serializeRebaseTodo = (entries: ReadonlyArray<RebaseTodoEntry>): string =>
  entries.map((e) => `pick ${e.oid} # ${e.subject}\n`).join('');

export const parseRebaseTodo = (text: string): ReadonlyArray<RebaseTodoEntry> => {
  const entries: RebaseTodoEntry[] = [];
  for (const line of text.split('\n')) {
    if (line === '' || line.startsWith('#')) continue;
    const match = TODO_LINE.exec(line);
    if (match === null) throw invalidSequencerTodo(line);
    entries.push({ oid: match[1] as string, subject: match[2] as string });
  }
  return entries;
};
