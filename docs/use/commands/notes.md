# `notes`

Attach, read, list, or remove note blobs on git objects via the `repo.notes.{add,read,list,remove}` nested namespace.

## Signature

```ts
interface NotesAddInput {
  readonly object: string;
  readonly content: Uint8Array;
  readonly force?: boolean;
  readonly ref?: string;
}

interface NotesAddResult {
  readonly notesCommit: ObjectId;
  readonly note: ObjectId;
}

interface NotesReadInput {
  readonly object: string;
  readonly ref?: string;
}

type NotesReadResult = {
  readonly object: ObjectId;
  readonly note: ObjectId;
  readonly content: Uint8Array;
} | null;

interface NotesListInput {
  readonly ref?: string;
}

type NotesListResult = ReadonlyArray<{ readonly object: ObjectId; readonly note: ObjectId }>;

interface NotesRemoveInput {
  readonly object: string;
  readonly ref?: string;
}

interface NotesRemoveResult {
  readonly notesCommit: ObjectId;
}

interface NotesNamespace {
  add(input: NotesAddInput): Promise<NotesAddResult>;
  read(input: NotesReadInput): Promise<NotesReadResult>;
  list(input?: NotesListInput): Promise<NotesListResult>;
  remove(input: NotesRemoveInput): Promise<NotesRemoveResult>;
}

repo.notes: NotesNamespace;
```

## Methods

| Method | Meaning |
|---|---|
| `add({ object, content, force?, ref? })` | Attach a note blob to an object. `object` is a full oid or ref name. `force` overwrites an existing note; without it an existing note is refused. Returns the new notes-tree commit oid and the note blob oid. |
| `read({ object, ref? })` | Return the note recorded for an object (`{ object, note, content }`) or `null` when no note exists. Never throws for absence. |
| `list({ ref? }?)` | Enumerate every `(object, note)` pair in the notes ref, sorted by annotated-object oid ascending. Returns an empty array when the ref is absent. |
| `remove({ object, ref? })` | Remove the note for an object and commit the smaller (or empty) tree. Returns the new notes-tree commit oid. |

## Behaviour

Notes are stored under `refs/notes/commits` by default. A different notes ref is selected via the `ref` option (explicit override → `GIT_NOTES_REF` env var → `core.notesRef` config → default). The three sources are handled exactly as canonical git does:

- An explicit `ref` is **expanded** into the notes namespace (git's `--ref`): `build` becomes `refs/notes/build`, `notes/x` becomes `refs/notes/x`, and even `refs/heads/main` becomes `refs/notes/refs/heads/main` — an explicit value can never escape `refs/notes/`.
- `GIT_NOTES_REF` and `core.notesRef` are used **verbatim** and **refused** with `NOTES_REF_OUTSIDE` when the value is not under `refs/notes/`.

The ref is never deleted, even when the last note is removed — an empty-tree commit is written instead, matching canonical git behaviour.

Note content is stored verbatim — no trailing-newline insertion or normalisation is applied by the library. Callers supply and receive raw `Uint8Array` bytes.

## Examples

```ts
const enc = new TextEncoder();

// Attach a note
const added = await repo.notes.add({
  object: 'HEAD',
  content: enc.encode('reviewed'),
});

// Read a note back
const entry = await repo.notes.read({ object: 'HEAD' });
if (entry !== null) {
  console.log(new TextDecoder().decode(entry.content));
}

// List all notes
const entries = await repo.notes.list();

// Remove a note
await repo.notes.remove({ object: 'HEAD' });

// Use a custom notes ref
await repo.notes.add({ object: 'HEAD', content: enc.encode('ok'), ref: 'refs/notes/review' });
```

## Throws

- `NOTES_ALREADY_EXIST` — `add` on an object that already has a note and `force` is not set.
- `NOTES_OBJECT_HAS_NONE` — `remove` on an object that has no note, or when the notes ref is absent.
- `NOTES_REF_OUTSIDE` — `GIT_NOTES_REF` or `core.notesRef` names a ref outside `refs/notes/` (the data carries the offending `ref`). An explicit `ref` option is expanded into the namespace instead, so it never triggers this.
- `INVALID_REF` — the resolved notes ref (after expansion) violates git ref syntax.

## See also

- Primitives: [`resolveRef`](../primitives/resolve-ref.md), [`updateRef`](../primitives/update-ref.md), [`readBlob`](../primitives/read-blob.md)
- Related commands: [`commit`](commit.md), [`log`](log.md), [`tag`](tag.md)
- Roadmap: `git notes merge`, `git notes prune`, `git notes copy` (v2)
