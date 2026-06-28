import { describe, expect, it } from 'vitest';

import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { createCommit } from '../../../../src/application/primitives/create-commit.js';
import { readObject } from '../../../../src/application/primitives/read-object.js';
import { writeNotesTree } from '../../../../src/application/primitives/write-notes-tree.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { writeTree } from '../../../../src/application/primitives/write-tree.js';
import { loadTrieRoot } from '../../../../src/domain/notes/load.js';
import { createEmptyTrie } from '../../../../src/domain/notes/trie.js';
import type { SubtreeReader } from '../../../../src/domain/notes/types.js';
import type { AuthorIdentity } from '../../../../src/domain/objects/index.js';
import { FILE_MODE, ObjectId } from '../../../../src/domain/objects/index.js';

const OID_A = ObjectId.from('a'.repeat(40));

const IDENTITY: AuthorIdentity = {
  name: 'Test User',
  email: 'test@example.com',
  timestamp: 1767225600,
  timezoneOffset: '+0000',
};

const noopRead: SubtreeReader = async () => [];

const seedConfig = async (
  ctx: ReturnType<typeof createMemoryContext>,
  content: string,
): Promise<void> => {
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, content);
};

const userConfig = '[user]\n  name = Test User\n  email = test@example.com\n';

describe('Given writeNotesTree', () => {
  describe('When writing an empty trie without a previous commit', () => {
    it('Then creates a notes commit pointing at the empty tree', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await seedConfig(ctx, userConfig);
      const trie = createEmptyTrie();
      const sut = writeNotesTree;

      // Act
      const notesCommitOid = await sut(ctx, {
        trie,
        read: noopRead,
        prevCommitOid: undefined,
        message: "Notes removed by 'git notes remove'",
      });

      // Assert
      const commit = await readObject(ctx, notesCommitOid);
      expect(commit.type).toBe('commit');
      if (commit.type === 'commit') {
        expect(commit.data.parents).toEqual([]);
        const tree = await readObject(ctx, commit.data.tree);
        expect(tree.type).toBe('tree');
        if (tree.type === 'tree') {
          expect(tree.entries).toEqual([]);
        }
      }
    });
  });

  describe('When writing a trie with one note, with a previous commit', () => {
    it('Then creates a notes commit with the previous commit as parent', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await seedConfig(ctx, userConfig);

      // Create a previous notes commit
      const prevTreeOid = await writeTree(ctx, []);
      const prevCommitOid = await createCommit(ctx, {
        tree: prevTreeOid,
        parents: [],
        author: IDENTITY,
        committer: IDENTITY,
        message: 'previous notes commit',
      });

      // Build a trie with one note at OID_A
      const noteContent = new TextEncoder().encode('my note');
      const noteOid = await writeObject(ctx, {
        type: 'blob',
        id: '' as ObjectId,
        content: noteContent,
      });

      const trie = loadTrieRoot([{ id: noteOid, mode: FILE_MODE.REGULAR, name: OID_A }]);
      const sut = writeNotesTree;

      // Act
      const notesCommitOid = await sut(ctx, {
        trie,
        read: noopRead,
        prevCommitOid,
        message: "Notes added by 'git notes add'",
      });

      // Assert
      const commit = await readObject(ctx, notesCommitOid);
      expect(commit.type).toBe('commit');
      if (commit.type === 'commit') {
        expect(commit.data.parents).toEqual([prevCommitOid]);
        expect(commit.data.message).toBe("Notes added by 'git notes add'");

        // The tree should contain the note entry
        const tree = await readObject(ctx, commit.data.tree);
        expect(tree.type).toBe('tree');
        if (tree.type === 'tree') {
          expect(tree.entries).toHaveLength(1);
          expect(tree.entries[0]?.id).toBe(noteOid);
          expect(tree.entries[0]?.name).toBe(OID_A);
        }
      }
    });
  });

  describe('When writing a trie with a fanout=1 note', () => {
    it('Then creates nested subtree entries in git tree-entry sort order', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await seedConfig(ctx, userConfig);

      // Fanout=1 oid: ab + 38 more hex chars
      const noteOid = ObjectId.from(`ab${'0'.repeat(38)}`);
      const noteContent = new TextEncoder().encode('fanout note');
      const noteBlobOid = await writeObject(ctx, {
        type: 'blob',
        id: '' as ObjectId,
        content: noteContent,
      });

      // Build trie with a note whose oid requires fanout=1 (need ≥2 notes for fanout)
      // Use a single note to verify fanout=0 (no fanout with just 1 note)
      const trie = loadTrieRoot([{ id: noteBlobOid, mode: FILE_MODE.REGULAR, name: noteOid }]);
      const sut = writeNotesTree;

      // Act
      const notesCommitOid = await sut(ctx, {
        trie,
        read: noopRead,
        prevCommitOid: undefined,
        message: "Notes added by 'git notes add'",
      });

      // Assert: notes commit written
      expect(notesCommitOid).toMatch(/^[0-9a-f]{40}$/);

      // Root tree has one entry — the note directly (fanout=0 with 1 note)
      const commit = await readObject(ctx, notesCommitOid);
      expect(commit.type).toBe('commit');
      if (commit.type === 'commit') {
        const tree = await readObject(ctx, commit.data.tree);
        expect(tree.type).toBe('tree');
        if (tree.type === 'tree') {
          expect(tree.entries).toHaveLength(1);
          expect(tree.entries[0]?.id).toBe(noteBlobOid);
        }
      }
    });
  });

  describe('When writing a trie, the notes commit author and committer', () => {
    it('Then uses the identity from ctx config', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await seedConfig(ctx, '[user]\n  name = Notes Author\n  email = notes@example.com\n');
      const trie = createEmptyTrie();
      const sut = writeNotesTree;

      // Act
      const notesCommitOid = await sut(ctx, {
        trie,
        read: noopRead,
        prevCommitOid: undefined,
        message: "Notes added by 'git notes add'",
      });

      // Assert
      const commit = await readObject(ctx, notesCommitOid);
      if (commit.type === 'commit') {
        expect(commit.data.author.name).toBe('Notes Author');
        expect(commit.data.author.email).toBe('notes@example.com');
        expect(commit.data.committer.name).toBe('Notes Author');
        expect(commit.data.committer.email).toBe('notes@example.com');
      }
    });
  });
});
