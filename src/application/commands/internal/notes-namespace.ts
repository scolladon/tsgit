import type { Context } from '../../../ports/context.js';
import {
  type NotesAddInput,
  type NotesAddResult,
  type NotesListInput,
  type NotesListResult,
  type NotesReadInput,
  type NotesReadResult,
  type NotesRemoveInput,
  type NotesRemoveResult,
  notesAdd,
  notesList,
  notesRead,
  notesRemove,
} from '../notes.js';

/**
 * The nested-namespace surface for `repo.notes.*`. Each method runs the
 * caller-supplied `guard()` first (so a disposed repository throws before any
 * work) and then forwards to the corresponding context-aware command in
 * `commands/notes.ts`.
 */
export interface NotesNamespace {
  readonly add: (input: NotesAddInput) => Promise<NotesAddResult>;
  readonly read: (input: NotesReadInput) => Promise<NotesReadResult>;
  readonly list: (input?: NotesListInput) => Promise<NotesListResult>;
  readonly remove: (input: NotesRemoveInput) => Promise<NotesRemoveResult>;
}

/**
 * Bind the `repo.notes.*` nested-namespace dispatcher. `guard()` is the
 * lifecycle gate (typically the disposed/closed check from `openRepository`);
 * it is invoked before every method forwards to its underlying command.
 *
 * The returned object is frozen — callers cannot monkey-patch methods onto
 * the namespace at runtime.
 */
export const bindNotesNamespace = (ctx: Context, guard: () => void): NotesNamespace => {
  const ns: NotesNamespace = {
    add: (input) => {
      guard();
      return notesAdd(ctx, input);
    },
    read: (input) => {
      guard();
      return notesRead(ctx, input);
    },
    list: (input) => {
      guard();
      return notesList(ctx, input);
    },
    remove: (input) => {
      guard();
      return notesRemove(ctx, input);
    },
  };
  return Object.freeze(ns);
};
