/**
 * Pure grammar for the sequencer `todo` list (`.git/sequencer/todo`), the
 * git-faithful work-list of a multi-pick `cherry-pick` / `revert`. Each line is
 * `pick <oid> <subject>`. `serializeTodo` emits **full** oids (git re-resolves
 * them); `parseTodo` extracts the raw oid token (full or abbreviated) and leaves
 * resolution to the command tier. Blank and `#`-comment lines are ignored so a
 * git-written todo (which may interleave them) round-trips.
 */
import { invalidSequencerTodo } from '../commands/error.js';

export interface TodoEntry {
  readonly command: 'pick';
  readonly oid: string;
  readonly subject: string;
}

const PICK_LINE = /^pick (\S+) (.*)$/;

export const serializeTodo = (entries: ReadonlyArray<TodoEntry>): string =>
  entries.map((e) => `pick ${e.oid} ${e.subject}\n`).join('');

export const parseTodo = (text: string): ReadonlyArray<TodoEntry> => {
  const entries: TodoEntry[] = [];
  for (const line of text.split('\n')) {
    if (line === '' || line.startsWith('#')) continue;
    const match = PICK_LINE.exec(line);
    if (match === null) throw invalidSequencerTodo(line);
    entries.push({ command: 'pick', oid: match[1] as string, subject: match[2] as string });
  }
  return entries;
};
