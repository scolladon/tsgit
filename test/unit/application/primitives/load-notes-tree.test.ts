import { describe, expect, it } from 'vitest';

import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { createCommit } from '../../../../src/application/primitives/create-commit.js';
import { loadNotesTree } from '../../../../src/application/primitives/load-notes-tree.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { writeTree } from '../../../../src/application/primitives/write-tree.js';
import { createEmptyTrie } from '../../../../src/domain/notes/trie.js';
import type { NotesTrie } from '../../../../src/domain/notes/types.js';
import type { AuthorIdentity } from '../../../../src/domain/objects/index.js';
import { FILE_MODE, ObjectId } from '../../../../src/domain/objects/index.js';
import type { RefName } from '../../../../src/domain/objects/object-id.js';

const NOTES_REF = 'refs/notes/commits' as RefName;
const OID_A = ObjectId.from('a'.repeat(40));

const IDENTITY: AuthorIdentity = {
  name: 'Test User',
  email: 'test@example.com',
  timestamp: 1767225600,
  timezoneOffset: '+0000',
};

const seedRef = async (
  ctx: ReturnType<typeof createMemoryContext>,
  name: RefName,
  id: ObjectId,
): Promise<void> => {
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/${name}`, `${id}\n`);
};

const makeNotesCommit = async (
  ctx: ReturnType<typeof createMemoryContext>,
  treeOid: ObjectId,
  parents: ReadonlyArray<ObjectId> = [],
): Promise<ObjectId> =>
  createCommit(ctx, {
    tree: treeOid,
    parents,
    author: IDENTITY,
    committer: IDENTITY,
    message: "Notes added by 'git notes add'",
  });

describe('Given loadNotesTree', () => {
  describe('When the notes ref does not exist', () => {
    it('Then returns an empty trie with undefined commit oid', async () => {
      // Arrange
      const ctx = createMemoryContext();
      const sut = loadNotesTree;

      // Act
      const result = await sut(ctx, NOTES_REF);

      // Assert
      expect(result.notesCommitOid).toBeUndefined();
      expect(result.trie).toEqual(createEmptyTrie());
    });
  });

  describe('When the notes ref points to a commit with a flat notes tree', () => {
    it('Then returns a trie containing the note', async () => {
      // Arrange
      const ctx = createMemoryContext();

      // Write a note blob
      const noteContent = new TextEncoder().encode('hello notes');
      const noteOid = await writeObject(ctx, {
        type: 'blob',
        id: '' as ObjectId,
        content: noteContent,
      });

      // Write a notes tree with one direct note entry (fanout=0)
      const treeOid = await writeTree(ctx, [{ id: noteOid, mode: FILE_MODE.REGULAR, name: OID_A }]);

      const commitOid = await makeNotesCommit(ctx, treeOid);
      await seedRef(ctx, NOTES_REF, commitOid);

      const sut = loadNotesTree;

      // Act
      const result = await sut(ctx, NOTES_REF);

      // Assert
      expect(result.notesCommitOid).toBe(commitOid);
      // The trie should have a note slot for OID_A (first nibble is 0xa)
      const noteSlot = result.trie.slots[0xa];
      expect(noteSlot).toBeDefined();
      expect(noteSlot?.kind).toBe('note');
      if (noteSlot?.kind === 'note') {
        expect(noteSlot.val).toBe(noteOid);
        expect(noteSlot.key).toBe(OID_A);
      }
    });
  });

  describe('When the notes ref exists with an empty tree', () => {
    it('Then returns an empty trie with the commit oid set', async () => {
      // Arrange
      const ctx = createMemoryContext();

      const treeOid = await writeTree(ctx, []);
      const commitOid = await makeNotesCommit(ctx, treeOid);
      await seedRef(ctx, NOTES_REF, commitOid);

      const sut = loadNotesTree;

      // Act
      const result = await sut(ctx, NOTES_REF);

      // Assert
      expect(result.notesCommitOid).toBe(commitOid);
      expect(result.trie).toEqual(createEmptyTrie());
    });
  });

  describe('When the SubtreeReader from loadNotesTree is used', () => {
    it('Then it reads a subtree by oid returning its tree entries', async () => {
      // Arrange
      const ctx = createMemoryContext();

      // Write a note blob
      const noteContent = new TextEncoder().encode('subtree note');
      const noteOid = await writeObject(ctx, {
        type: 'blob',
        id: '' as ObjectId,
        content: noteContent,
      });

      // Build a fanout=1 structure using a concrete 40-hex oid
      const leafOid = ObjectId.from(`ab${'0'.repeat(38)}`);

      // Write the subtree — name is the leaf within the 'ab/' prefix
      const subtreeTreeOid = await writeTree(ctx, [
        { id: noteOid, mode: FILE_MODE.REGULAR, name: leafOid },
      ]);

      // Write the root notes tree referencing the subtree
      const rootTreeOid = await writeTree(ctx, [
        { id: subtreeTreeOid, mode: FILE_MODE.DIRECTORY, name: 'ab' as ObjectId },
      ]);

      const commitOid = await makeNotesCommit(ctx, rootTreeOid);
      await seedRef(ctx, NOTES_REF, commitOid);

      const sut = loadNotesTree;

      // Act
      const result = await sut(ctx, NOTES_REF);

      // Assert: the read function should resolve the subtree's entries
      const entries = await result.read(subtreeTreeOid);
      expect(entries.length).toBe(1);
      expect(entries[0]?.id).toBe(noteOid);
    });
  });
});

describe('Given loadNotesTree trie structure', () => {
  describe('When the trie is empty', () => {
    it('Then has the correct empty shape', () => {
      // Arrange + Act
      const sut: NotesTrie = createEmptyTrie();

      // Assert
      expect(sut.slots).toHaveLength(16);
      expect(sut.preserved).toEqual([]);
    });
  });
});
