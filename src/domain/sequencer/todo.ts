/**
 * Pure grammar for the sequencer `todo` list (`.git/sequencer/todo`), the
 * git-faithful work-list of a multi-commit `cherry-pick` / `revert`. Each line is
 * `<command> <oid> <subject>` where `<command>` is `pick` (cherry-pick) or
 * `revert`. `serializeTodo` emits **full** oids (git re-resolves them);
 * `parseTodo` extracts the raw oid token (full or abbreviated) and leaves
 * resolution to the command tier. Blank and `#`-comment lines are ignored so a
 * git-written todo (which may interleave them) round-trips.
 */
import { invalidSequencerTodo } from '../commands/error.js';

export type TodoCommand = 'pick' | 'revert';

export interface TodoEntry {
  readonly command: TodoCommand;
  readonly oid: string;
  readonly subject: string;
}

const TODO_LINE = /^(pick|revert) (\S+) (.*)$/;

export const serializeTodo = (entries: ReadonlyArray<TodoEntry>): string =>
  entries.map((e) => `${e.command} ${e.oid} ${e.subject}\n`).join('');

export const parseTodo = (text: string): ReadonlyArray<TodoEntry> => {
  const entries: TodoEntry[] = [];
  for (const line of text.split('\n')) {
    if (line === '' || line.startsWith('#')) continue;
    const match = TODO_LINE.exec(line);
    if (match === null) throw invalidSequencerTodo(line);
    entries.push({
      command: match[1] as TodoCommand,
      oid: match[2] as string,
      subject: match[3] as string,
    });
  }
  return entries;
};
