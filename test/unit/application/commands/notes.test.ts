import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import {
  notesAdd,
  notesList,
  notesRead,
  notesRemove,
} from '../../../../src/application/commands/notes.js';
import { __resetConfigCacheForTests } from '../../../../src/application/primitives/config-read.js';
import { createCommit } from '../../../../src/application/primitives/create-commit.js';
import { readObject } from '../../../../src/application/primitives/read-object.js';
import { readReflog } from '../../../../src/application/primitives/reflog-store.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { writeTree } from '../../../../src/application/primitives/write-tree.js';
import { TsgitError } from '../../../../src/domain/index.js';
import type { AuthorIdentity, RefName, TreeEntry } from '../../../../src/domain/objects/index.js';
import { FILE_MODE, ObjectId } from '../../../../src/domain/objects/index.js';

const encoder = new TextEncoder();

const author: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

const USER_CONFIG = '[user]\n  name = Grace\n  email = grace@example.com\n';

const seedWithCommit = async () => {
  const ctx = createMemoryContext();
  await init(ctx);
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, USER_CONFIG);
  __resetConfigCacheForTests();
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
  await add(ctx, ['a.txt']);
  const c = await commit(ctx, { message: 'first', author });
  return { ctx, commitId: c.id };
};

const seedWithTwoCommits = async () => {
  const ctx = createMemoryContext();
  await init(ctx);
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, USER_CONFIG);
  __resetConfigCacheForTests();
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
  await add(ctx, ['a.txt']);
  const c1 = await commit(ctx, { message: 'first', author });
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/b.txt`, 'b');
  await add(ctx, ['b.txt']);
  const c2 = await commit(ctx, { message: 'second', author });
  return { ctx, commitId1: c1.id, commitId2: c2.id };
};

const FANNED_LEAF = '0'.repeat(38);

/**
 * Builds an on-disk notes tree whose root has all 16 nibble slots populated as
 * fanout subtrees (`XX/` → 38-hex leaf) — a genuinely fanned tree the WRITE
 * walker would leave as opaque directory placeholders. Seeds refs/notes/commits
 * to a notes commit over it; returns the annotated oids it encodes.
 */
const seedFannedNotesRef = async (
  ctx: ReturnType<typeof createMemoryContext>,
): Promise<ReadonlyArray<ObjectId>> => {
  const noteBlob = await writeObject(ctx, {
    type: 'blob',
    id: '' as ObjectId,
    content: encoder.encode('fanned'),
  });
  const rootEntries: TreeEntry[] = [];
  const oids: ObjectId[] = [];
  for (let nibble = 0; nibble < 16; nibble += 1) {
    const dir = `${nibble.toString(16)}0`;
    const subtreeOid = await writeTree(ctx, [
      { id: noteBlob, mode: FILE_MODE.REGULAR, name: FANNED_LEAF },
    ]);
    rootEntries.push({ id: subtreeOid, mode: FILE_MODE.DIRECTORY, name: dir });
    oids.push(ObjectId.from(`${dir}${FANNED_LEAF}`));
  }
  const rootTreeOid = await writeTree(ctx, rootEntries);
  const commitOid = await createCommit(ctx, {
    tree: rootTreeOid,
    parents: [],
    author,
    committer: author,
    message: "Notes added by 'git notes add'",
  });
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/notes/commits`, `${commitOid}\n`);
  return oids;
};

describe('notes', () => {
  beforeEach(() => {
    __resetConfigCacheForTests();
  });

  describe('Given a commit and user config', () => {
    describe('When notesAdd with object and content', () => {
      it('Then returns notesCommit and note oids', async () => {
        // Arrange
        const { ctx, commitId } = await seedWithCommit();
        const content = encoder.encode('hello note');

        // Act
        const sut = notesAdd;
        const result = await sut(ctx, { object: commitId, content });

        // Assert
        expect(typeof result.notesCommit).toBe('string');
        expect(result.notesCommit).toHaveLength(40);
        expect(typeof result.note).toBe('string');
        expect(result.note).toHaveLength(40);
      });
    });

    describe('When notesAdd then notesRead same object', () => {
      it('Then returns the note with verbatim content', async () => {
        // Arrange
        const { ctx, commitId } = await seedWithCommit();
        const content = encoder.encode('verbatim content');
        await notesAdd(ctx, { object: commitId, content });

        // Act
        const sut = notesRead;
        const result = await sut(ctx, { object: commitId });

        // Assert
        expect(result).not.toBeNull();
        expect(result?.object).toBe(commitId);
        expect(result?.content).toEqual(content);
      });
    });

    describe('When notesAdd produces the right commit message', () => {
      it('Then commit message is "Notes added by \'git notes add\'"', async () => {
        // Arrange
        const { ctx, commitId } = await seedWithCommit();
        const content = encoder.encode('hello');

        // Act
        const result = await notesAdd(ctx, { object: commitId, content });

        // Assert
        const obj = await readObject(ctx, result.notesCommit);
        expect(obj.type).toBe('commit');
        if (obj.type === 'commit') {
          expect(obj.data.message).toBe("Notes added by 'git notes add'\n");
        }
      });
    });

    describe('When notesAdd is called', () => {
      it('Then reflog for refs/notes/commits is written with correct message', async () => {
        // Arrange
        const { ctx, commitId } = await seedWithCommit();

        // Act
        await notesAdd(ctx, { object: commitId, content: encoder.encode('x') });

        // Assert
        const log = await readReflog(ctx, 'refs/notes/commits' as RefName);
        expect(log).toHaveLength(1);
        expect(log[0]?.message).toBe("notes: Notes added by 'git notes add'");
      });
    });

    describe('When notesAdd creates default ref', () => {
      it('Then refs/notes/commits exists', async () => {
        // Arrange
        const { ctx, commitId } = await seedWithCommit();

        // Act
        await notesAdd(ctx, { object: commitId, content: encoder.encode('x') });

        // Assert
        const exists = await ctx.fs.exists(`${ctx.layout.gitDir}/refs/notes/commits`);
        expect(exists).toBe(true);
      });
    });
  });

  describe('Given a note already exists for an object', () => {
    describe('When notesAdd without force', () => {
      it('Then throws NOTES_ALREADY_EXIST with the correct object oid', async () => {
        // Arrange
        const { ctx, commitId } = await seedWithCommit();
        await notesAdd(ctx, { object: commitId, content: encoder.encode('first') });

        // Act
        let caught: unknown;
        try {
          await notesAdd(ctx, { object: commitId, content: encoder.encode('second') });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data as { code: string; object: ObjectId };
        expect(data.code).toBe('NOTES_ALREADY_EXIST');
        expect(data.object).toBe(commitId);
      });
    });

    describe('When notesAdd with force=true', () => {
      it('Then overwrites the note and returns new note oid', async () => {
        // Arrange
        const { ctx, commitId } = await seedWithCommit();
        const first = await notesAdd(ctx, { object: commitId, content: encoder.encode('first') });

        // Act
        const sut = notesAdd;
        const result = await sut(ctx, {
          object: commitId,
          content: encoder.encode('overwritten'),
          force: true,
        });

        // Assert
        expect(result.notesCommit).not.toBe(first.notesCommit);
        const note = await notesRead(ctx, { object: commitId });
        expect(new TextDecoder().decode(note?.content)).toBe('overwritten');
      });
    });

    describe('When notesAdd with force=true produces commit message', () => {
      it('Then message is still "Notes added by \'git notes add\'"', async () => {
        // Arrange
        const { ctx, commitId } = await seedWithCommit();
        await notesAdd(ctx, { object: commitId, content: encoder.encode('first') });

        // Act
        const result = await notesAdd(ctx, {
          object: commitId,
          content: encoder.encode('second'),
          force: true,
        });

        // Assert
        const obj = await readObject(ctx, result.notesCommit);
        if (obj.type === 'commit') {
          expect(obj.data.message).toBe("Notes added by 'git notes add'\n");
        }
      });
    });
  });

  describe('Given a first note is added', () => {
    describe('When a second notesAdd for a different object', () => {
      it('Then second notes commit has first as parent', async () => {
        // Arrange
        const { ctx, commitId1, commitId2 } = await seedWithTwoCommits();
        const first = await notesAdd(ctx, {
          object: commitId1,
          content: encoder.encode('note1'),
        });

        // Act
        const second = await notesAdd(ctx, {
          object: commitId2,
          content: encoder.encode('note2'),
        });

        // Assert
        const obj = await readObject(ctx, second.notesCommit);
        if (obj.type === 'commit') {
          expect(obj.data.parents).toEqual([first.notesCommit]);
        }
      });
    });
  });

  describe('Given no prior notes', () => {
    describe('When notesAdd with first note', () => {
      it('Then the notes commit has no parents (root commit)', async () => {
        // Arrange
        const { ctx, commitId } = await seedWithCommit();

        // Act
        const result = await notesAdd(ctx, { object: commitId, content: encoder.encode('x') });

        // Assert
        const obj = await readObject(ctx, result.notesCommit);
        if (obj.type === 'commit') {
          expect(obj.data.parents).toEqual([]);
        }
      });
    });
  });

  describe('Given a custom ref is specified', () => {
    describe('When notesAdd with ref option', () => {
      it('Then the custom ref is created instead of the default', async () => {
        // Arrange
        const { ctx, commitId } = await seedWithCommit();

        // Act
        await notesAdd(ctx, {
          object: commitId,
          content: encoder.encode('x'),
          ref: 'refs/notes/custom',
        });

        // Assert
        const customExists = await ctx.fs.exists(`${ctx.layout.gitDir}/refs/notes/custom`);
        const defaultExists = await ctx.fs.exists(`${ctx.layout.gitDir}/refs/notes/commits`);
        expect(customExists).toBe(true);
        expect(defaultExists).toBe(false);
      });
    });
  });

  describe('Given a note exists', () => {
    describe('When notesRead for the same object', () => {
      it('Then returns the note with object oid, note oid, and content', async () => {
        // Arrange
        const { ctx, commitId } = await seedWithCommit();
        const content = encoder.encode('the note');
        const added = await notesAdd(ctx, { object: commitId, content });

        // Act
        const sut = notesRead;
        const result = await sut(ctx, { object: commitId });

        // Assert
        expect(result).not.toBeNull();
        expect(result?.object).toBe(commitId);
        expect(result?.note).toBe(added.note);
        expect(result?.content).toEqual(content);
      });
    });
  });

  describe('Given no note for a specific object', () => {
    describe('When notesRead for that object', () => {
      it('Then returns null', async () => {
        // Arrange
        const { ctx, commitId1, commitId2 } = await seedWithTwoCommits();
        await notesAdd(ctx, { object: commitId1, content: encoder.encode('only for c1') });

        // Act
        const sut = notesRead;
        const result = await sut(ctx, { object: commitId2 });

        // Assert
        expect(result).toBeNull();
      });
    });
  });

  describe('Given no notes ref exists', () => {
    describe('When notesRead', () => {
      it('Then returns null', async () => {
        // Arrange
        const { ctx, commitId } = await seedWithCommit();

        // Act
        const sut = notesRead;
        const result = await sut(ctx, { object: commitId });

        // Assert
        expect(result).toBeNull();
      });
    });

    describe('When notesList', () => {
      it('Then returns empty array', async () => {
        // Arrange
        const { ctx } = await seedWithCommit();

        // Act
        const sut = notesList;
        const result = await sut(ctx);

        // Assert
        expect(result).toEqual([]);
      });
    });
  });

  describe('Given two notes added for different objects', () => {
    describe('When notesList', () => {
      it('Then returns both entries sorted by annotated-object oid ascending', async () => {
        // Arrange
        const { ctx, commitId1, commitId2 } = await seedWithTwoCommits();
        await notesAdd(ctx, { object: commitId1, content: encoder.encode('n1') });
        await notesAdd(ctx, { object: commitId2, content: encoder.encode('n2') });

        // Act
        const sut = notesList;
        const result = await sut(ctx);

        // Assert
        expect(result).toHaveLength(2);
        const oids = result.map((e) => e.object);
        // Ascending oid order, against an order computed independently of the SUT's comparator
        const [smaller, larger] =
          commitId1 < commitId2 ? [commitId1, commitId2] : [commitId2, commitId1];
        expect(oids).toEqual([smaller, larger]);
      });
    });
  });

  describe('Given one note exists', () => {
    describe('When notesList with optional input undefined', () => {
      it('Then returns the one note', async () => {
        // Arrange
        const { ctx, commitId } = await seedWithCommit();
        const added = await notesAdd(ctx, { object: commitId, content: encoder.encode('x') });

        // Act
        const sut = notesList;
        const result = await sut(ctx);

        // Assert
        expect(result).toHaveLength(1);
        expect(result[0]?.object).toBe(commitId);
        expect(result[0]?.note).toBe(added.note);
      });
    });
  });

  describe('Given a note exists', () => {
    describe('When notesRemove', () => {
      it('Then returns notesCommit and the note is no longer readable', async () => {
        // Arrange
        const { ctx, commitId } = await seedWithCommit();
        await notesAdd(ctx, { object: commitId, content: encoder.encode('to remove') });

        // Act
        const sut = notesRemove;
        const result = await sut(ctx, { object: commitId });

        // Assert
        expect(typeof result.notesCommit).toBe('string');
        expect(result.notesCommit).toHaveLength(40);
        const note = await notesRead(ctx, { object: commitId });
        expect(note).toBeNull();
      });
    });

    describe('When notesRemove produces the right commit message', () => {
      it('Then commit message is "Notes removed by \'git notes remove\'"', async () => {
        // Arrange
        const { ctx, commitId } = await seedWithCommit();
        await notesAdd(ctx, { object: commitId, content: encoder.encode('x') });

        // Act
        const result = await notesRemove(ctx, { object: commitId });

        // Assert
        const obj = await readObject(ctx, result.notesCommit);
        if (obj.type === 'commit') {
          expect(obj.data.message).toBe("Notes removed by 'git notes remove'\n");
        }
      });
    });

    describe('When notesRemove is called', () => {
      it('Then reflog for refs/notes/commits is appended with remove message', async () => {
        // Arrange
        const { ctx, commitId } = await seedWithCommit();
        await notesAdd(ctx, { object: commitId, content: encoder.encode('x') });

        // Act
        await notesRemove(ctx, { object: commitId });

        // Assert
        const log = await readReflog(ctx, 'refs/notes/commits' as RefName);
        expect(log).toHaveLength(2);
        expect(log[1]?.message).toBe("notes: Notes removed by 'git notes remove'");
      });
    });
  });

  describe('Given the last note is removed', () => {
    describe('When notesRemove', () => {
      it('Then the list becomes empty', async () => {
        // Arrange
        const sut = notesRemove;
        const { ctx, commitId } = await seedWithCommit();
        await notesAdd(ctx, { object: commitId, content: encoder.encode('x') });

        // Act
        await sut(ctx, { object: commitId });

        // Assert
        const list = await notesList(ctx);
        expect(list).toEqual([]);
      });

      it('Then the notes ref still exists', async () => {
        // Arrange
        const sut = notesRemove;
        const { ctx, commitId } = await seedWithCommit();
        await notesAdd(ctx, { object: commitId, content: encoder.encode('x') });

        // Act
        await sut(ctx, { object: commitId });

        // Assert
        const refExists = await ctx.fs.exists(`${ctx.layout.gitDir}/refs/notes/commits`);
        expect(refExists).toBe(true);
      });
    });
  });

  describe('Given no notes ref exists', () => {
    describe('When notesRemove', () => {
      it('Then throws NOTES_OBJECT_HAS_NONE with the correct oid', async () => {
        // Arrange
        const { ctx, commitId } = await seedWithCommit();

        // Act
        let caught: unknown;
        try {
          await notesRemove(ctx, { object: commitId });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data as { code: string; object: ObjectId };
        expect(data.code).toBe('NOTES_OBJECT_HAS_NONE');
        expect(data.object).toBe(commitId);
      });
    });
  });

  describe('Given a notes ref exists but the object has no note', () => {
    describe('When notesRemove', () => {
      it('Then throws NOTES_OBJECT_HAS_NONE with the correct oid', async () => {
        // Arrange
        const { ctx, commitId1, commitId2 } = await seedWithTwoCommits();
        await notesAdd(ctx, { object: commitId1, content: encoder.encode('n1') });

        // Act
        let caught: unknown;
        try {
          await notesRemove(ctx, { object: commitId2 });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data as { code: string; object: ObjectId };
        expect(data.code).toBe('NOTES_OBJECT_HAS_NONE');
        expect(data.object).toBe(commitId2);
      });
    });
  });

  describe('Given a note exists under no note for object', () => {
    describe('When notesAdd with no existing note (force=false is irrelevant)', () => {
      it('Then does NOT throw NOTES_ALREADY_EXIST', async () => {
        // Arrange — one note for commitId1, none for commitId2
        const { ctx, commitId1, commitId2 } = await seedWithTwoCommits();
        await notesAdd(ctx, { object: commitId1, content: encoder.encode('n1') });

        // Act/Assert — must not throw
        await expect(
          notesAdd(ctx, { object: commitId2, content: encoder.encode('n2') }),
        ).resolves.toBeDefined();
      });
    });
  });

  describe('Given a custom ref is used for notesRead and notesList', () => {
    describe('When notes are in refs/notes/custom', () => {
      it('Then notesRead and notesList with the same ref return the note', async () => {
        // Arrange
        const { ctx, commitId } = await seedWithCommit();
        const customRef = 'refs/notes/custom';
        await notesAdd(ctx, {
          object: commitId,
          content: encoder.encode('custom ref note'),
          ref: customRef,
        });

        // Act
        const readResult = await notesRead(ctx, { object: commitId, ref: customRef });
        const listResult = await notesList(ctx, { ref: customRef });

        // Assert
        expect(readResult).not.toBeNull();
        expect(new TextDecoder().decode(readResult?.content)).toBe('custom ref note');
        expect(listResult).toHaveLength(1);
        expect(listResult[0]?.object).toBe(commitId);
      });
    });
  });

  describe('Given a fanned notes tree (all 16 root slots are subtrees)', () => {
    describe('When notesList', () => {
      it('Then returns every fanned note, not an empty list', async () => {
        // Arrange
        const { ctx } = await seedWithCommit();
        const expected = await seedFannedNotesRef(ctx);
        const sut = notesList;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result).toHaveLength(16);
        const oids = result.map((entry) => entry.object);
        for (const oid of expected) {
          expect(oids).toContain(oid);
        }
      });
    });
  });

  describe('Given a notes tree with a non-note entry alongside a note', () => {
    describe('When notesList', () => {
      it('Then the non-note entry is skipped', async () => {
        // Arrange
        const { ctx } = await seedWithCommit();
        const noteBlob = await writeObject(ctx, {
          type: 'blob',
          id: '' as ObjectId,
          content: encoder.encode('note'),
        });
        const noteName = 'a'.repeat(40);
        const rootTree = await writeTree(ctx, [
          { id: noteBlob, mode: FILE_MODE.REGULAR, name: 'README' },
          { id: noteBlob, mode: FILE_MODE.REGULAR, name: noteName },
        ]);
        const notesCommit = await createCommit(ctx, {
          tree: rootTree,
          parents: [],
          author,
          committer: author,
          message: "Notes added by 'git notes add'",
        });
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/notes/commits`, `${notesCommit}\n`);
        const sut = notesList;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result).toHaveLength(1);
        expect(result[0]?.object).toBe(noteName);
      });
    });
  });

  describe('Given the object is a ref name rather than a full oid', () => {
    describe('When notesAdd with object "HEAD"', () => {
      it('Then it resolves HEAD to its commit and annotates it', async () => {
        // Arrange
        const { ctx, commitId } = await seedWithCommit();

        // Act
        const sut = notesAdd;
        await sut(ctx, { object: 'HEAD', content: encoder.encode('on head') });

        // Assert
        const note = await notesRead(ctx, { object: commitId });
        expect(note).not.toBeNull();
        expect(note?.object).toBe(commitId);
        expect(new TextDecoder().decode(note?.content)).toBe('on head');
      });
    });
  });
});
