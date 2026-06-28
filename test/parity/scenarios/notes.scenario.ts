/**
 * Notes parity scenario — seeds a single commit, attaches a note, reads it
 * back, lists all notes, then removes it and verifies absence.
 *
 * Notes commits embed a committer timestamp from the system clock (non-deterministic),
 * so only the decoded content, list length, and null-read-after-remove are
 * included in the expected golden — not the notes-commit oids.
 *
 * Surfaces closed: commands: notes.
 */
import { AUTHOR, FILES, MESSAGES } from '../fixtures.ts';
import type { Scenario } from './types.ts';

interface NotesScenarioResult {
  readonly contentAfterAdd: string | null;
  readonly listLenAfterAdd: number;
  readonly readAfterRemoveIsNull: boolean;
  readonly listLenAfterRemove: number;
}

const NOTE_TEXT = 'parity note';

export const notesScenario: Scenario<NotesScenarioResult> = {
  name: 'notes',
  inputs: {
    files: [FILES.helloA],
    author: AUTHOR,
    message: MESSAGES.seed,
  },
  expected: {
    contentAfterAdd: NOTE_TEXT,
    listLenAfterAdd: 1,
    readAfterRemoveIsNull: true,
    listLenAfterRemove: 0,
  },
  run: async (repo, inputs) => {
    await repo.init();

    // Configure user identity so writeNotesTree can resolve committer.
    await repo.config.set({ key: 'user.name', value: inputs.author.name, scope: 'local' });
    await repo.config.set({ key: 'user.email', value: inputs.author.email, scope: 'local' });

    await repo.add(inputs.files.map((f) => f.path));
    const commitResult = await repo.commit({ message: inputs.message, author: inputs.author });
    const object = commitResult.id;

    const content = new TextEncoder().encode(NOTE_TEXT);

    // Add a note and read it back.
    await repo.notes.add({ object, content });
    const readEntry = await repo.notes.read({ object });
    const contentAfterAdd = readEntry !== null ? new TextDecoder().decode(readEntry.content) : null;

    const listAfterAdd = await repo.notes.list();

    // Remove the note and verify absence.
    await repo.notes.remove({ object });
    const readAfterRemove = await repo.notes.read({ object });
    const listAfterRemove = await repo.notes.list();

    return {
      contentAfterAdd,
      listLenAfterAdd: listAfterAdd.length,
      readAfterRemoveIsNull: readAfterRemove === null,
      listLenAfterRemove: listAfterRemove.length,
    };
  },
};
