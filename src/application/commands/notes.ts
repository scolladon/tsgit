/**
 * `notes` command family — add / read / list / remove note blobs attached to
 * git objects. Each verb is a Context-aware function; the namespace binder
 * lives in `internal/notes-namespace.ts`.
 *
 * Faithfulness: commit messages, reflog entries, and the empty-tree oid are
 * pinned byte-for-byte against real `git notes`. Note content is stored
 * verbatim — no trailing-newline insertion. Structured data only, no
 * pre-rendered strings.
 */
import { notesAlreadyExist, notesObjectHasNone } from '../../domain/commands/error.js';
import { insert, lookup, remove } from '../../domain/notes/mutate.js';
import { FILE_MODE } from '../../domain/objects/file-mode.js';
import type { RefName } from '../../domain/objects/object-id.js';
import { ObjectId } from '../../domain/objects/object-id.js';
import type { Context } from '../../ports/context.js';
import { loadNotesTree } from '../primitives/load-notes-tree.js';
import { readBlob } from '../primitives/read-blob.js';
import { resolveNotesRef } from '../primitives/resolve-notes-ref.js';
import { resolveRef } from '../primitives/resolve-ref.js';
import { updateRef } from '../primitives/update-ref.js';
import { walkTree } from '../primitives/walk-tree.js';
import { writeNotesTree } from '../primitives/write-notes-tree.js';
import { writeObject } from '../primitives/write-object.js';
import { resolveCurrentIdentity } from './internal/current-identity.js';
import { assertOperationalRepository } from './internal/repo-state.js';

/** Matches a full-length annotated-object oid (SHA-1 or SHA-256). */
const FULL_HEX = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Matches a SHA-1 oid (40 hex) for object resolution, as tagCreate does. */
const OID_RE = /^[0-9a-f]{40}$/;

// Commit messages match git byte-for-byte: git appends \n to notes commit bodies.
const NOTES_ADD_MESSAGE = "Notes added by 'git notes add'\n";
const NOTES_REMOVE_MESSAGE = "Notes removed by 'git notes remove'\n";
// Reflog messages do NOT carry the trailing \n (the reflog writer adds its own).
const NOTES_ADD_REFLOG = "notes: Notes added by 'git notes add'";
const NOTES_REMOVE_REFLOG = "notes: Notes removed by 'git notes remove'";

// ─── Input / Result shapes ────────────────────────────────────────────────────

export interface NotesAddInput {
  /** Commit-ish or full oid to annotate. */
  readonly object: string;
  /** Note bytes stored verbatim — no normalisation applied by the library. */
  readonly content: Uint8Array;
  /** Overwrite an existing note; without this, an existing note refuses. */
  readonly force?: boolean;
  /** Notes-ref override; selection rule: explicit → GIT_NOTES_REF → core.notesRef → default. */
  readonly ref?: string;
}

export interface NotesAddResult {
  readonly notesCommit: ObjectId;
  readonly note: ObjectId;
}

export interface NotesReadInput {
  readonly object: string;
  readonly ref?: string;
}

export type NotesReadResult = {
  readonly object: ObjectId;
  readonly note: ObjectId;
  readonly content: Uint8Array;
} | null;

export interface NotesListInput {
  readonly ref?: string;
}

export type NotesListResult = ReadonlyArray<{ readonly object: ObjectId; readonly note: ObjectId }>;

export interface NotesRemoveInput {
  readonly object: string;
  readonly ref?: string;
}

export interface NotesRemoveResult {
  readonly notesCommit: ObjectId;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Resolves a string (full oid or ref name) to an ObjectId. */
const resolveObject = async (ctx: Context, object: string): Promise<ObjectId> =>
  OID_RE.test(object) ? (object as ObjectId) : resolveRef(ctx, object as RefName);

// ─── Verbs ────────────────────────────────────────────────────────────────────

/**
 * Writes (or, with `force`, overwrites) a note for an object. Commits the new
 * notes tree and moves the notes ref, creating it if absent.
 */
export const notesAdd = async (ctx: Context, input: NotesAddInput): Promise<NotesAddResult> => {
  await assertOperationalRepository(ctx);

  const objectOid = await resolveObject(ctx, input.object);
  const ref = await resolveNotesRef(ctx, input.ref);
  const { trie, read, notesCommitOid } = await loadNotesTree(ctx, ref);

  const existing = await lookup(trie, objectOid, read);
  if (existing !== undefined && input.force !== true) {
    throw notesAlreadyExist(objectOid);
  }

  const note = await writeObject(ctx, { type: 'blob', id: '' as ObjectId, content: input.content });
  const newTrie = await insert(trie, objectOid, note, read);

  const author = await resolveCurrentIdentity(ctx);
  const notesCommit = await writeNotesTree(ctx, {
    trie: newTrie,
    read,
    prevCommitOid: notesCommitOid,
    message: NOTES_ADD_MESSAGE,
    author,
  });

  await updateRef(ctx, ref, notesCommit, { reflogMessage: NOTES_ADD_REFLOG });

  return { notesCommit, note };
};

/**
 * Returns the note recorded for an object, or `null` when the note or ref is
 * absent. Never throws for absence — callers distinguish "no note" from errors.
 */
export const notesRead = async (ctx: Context, input: NotesReadInput): Promise<NotesReadResult> => {
  await assertOperationalRepository(ctx);

  const objectOid = await resolveObject(ctx, input.object);
  const ref = await resolveNotesRef(ctx, input.ref);
  const { trie, read } = await loadNotesTree(ctx, ref);

  const noteOid = await lookup(trie, objectOid, read);
  if (noteOid === undefined) return null;

  const blob = await readBlob(ctx, noteOid);
  return { object: objectOid, note: noteOid, content: blob.content };
};

/**
 * Enumerates every `(annotated-object, note-blob)` pair in the notes ref by
 * walking the real notes tree, recursing through every fanout level. Returns an
 * empty array when the ref is absent. Skips non-note entries (directories and
 * any leaf whose de-slashed path is not a full-hex oid). Sorted by
 * annotated-object oid ascending (git tree order).
 */
export const notesList = async (ctx: Context, input?: NotesListInput): Promise<NotesListResult> => {
  await assertOperationalRepository(ctx);

  const ref = await resolveNotesRef(ctx, input?.ref);
  const { notesTreeOid } = await loadNotesTree(ctx, ref);
  if (notesTreeOid === undefined) return [];

  const notes: { object: ObjectId; note: ObjectId }[] = [];
  for await (const entry of walkTree(ctx, notesTreeOid)) {
    if (entry.mode !== FILE_MODE.REGULAR) continue;
    const flatOid = entry.path.split('/').join('');
    if (!FULL_HEX.test(flatOid)) continue;
    notes.push({ object: ObjectId.from(flatOid), note: entry.id });
  }

  return notes.sort((a, b) => (a.object < b.object ? -1 : 1));
};

/**
 * Removes the note for an object. Commits the smaller (or empty) tree and
 * moves the notes ref. The ref is never deleted, even when the last note is
 * removed — an empty tree commit is stored instead.
 */
export const notesRemove = async (
  ctx: Context,
  input: NotesRemoveInput,
): Promise<NotesRemoveResult> => {
  await assertOperationalRepository(ctx);

  const objectOid = await resolveObject(ctx, input.object);
  const ref = await resolveNotesRef(ctx, input.ref);
  const { trie, read, notesCommitOid } = await loadNotesTree(ctx, ref);

  if (notesCommitOid === undefined) throw notesObjectHasNone(objectOid);

  const existing = await lookup(trie, objectOid, read);
  if (existing === undefined) throw notesObjectHasNone(objectOid);

  const newTrie = await remove(trie, objectOid, read);

  const author = await resolveCurrentIdentity(ctx);
  const notesCommit = await writeNotesTree(ctx, {
    trie: newTrie,
    read,
    prevCommitOid: notesCommitOid,
    message: NOTES_REMOVE_MESSAGE,
    author,
  });

  await updateRef(ctx, ref, notesCommit, { reflogMessage: NOTES_REMOVE_REFLOG });

  return { notesCommit };
};
