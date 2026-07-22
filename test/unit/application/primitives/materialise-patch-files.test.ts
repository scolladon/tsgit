import { describe, expect, it, vi } from 'vitest';
// `vi` is still used by the bounded-concurrency test below.
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { createCommit } from '../../../../src/application/primitives/create-commit.js';
import {
  materialiseOne,
  materialisePatchFiles,
} from '../../../../src/application/primitives/materialise-patch-files.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { writeTree } from '../../../../src/application/primitives/write-tree.js';
import type {
  AddChange,
  CopyChange,
  DeleteChange,
  ModifyChange,
  RenameChange,
  TypeChangeChange,
} from '../../../../src/domain/diff/index.js';
import { MAX_SCORE } from '../../../../src/domain/diff/similarity.js';
import type { AuthorIdentity, FilePath, ObjectId } from '../../../../src/domain/objects/index.js';
import { FILE_MODE } from '../../../../src/domain/objects/index.js';
import type { CommandRunner } from '../../../../src/ports/command-runner.js';

const AUTHOR: AuthorIdentity = {
  name: 'a',
  email: 'a@a',
  timestamp: 0,
  timezoneOffset: '+0000',
};

const utf8 = new TextEncoder();

async function writeBlob(
  ctx: ReturnType<typeof createMemoryContext>,
  content: string,
): Promise<ObjectId> {
  return writeObject(ctx, {
    type: 'blob',
    id: '' as ObjectId,
    content: utf8.encode(content),
  });
}

/**
 * Write a real commit object (type = 'commit') so `readBlob` on its oid
 * throws `unexpectedObjectType('blob', 'commit')`.  This proves the
 * gitlink guard fires BEFORE any attempt to read blob bytes.
 */
async function writeCommitAsGitlink(
  ctx: ReturnType<typeof createMemoryContext>,
  parents: ReadonlyArray<ObjectId> = [],
): Promise<ObjectId> {
  const tree = await writeTree(ctx, []);
  return createCommit(ctx, {
    tree,
    parents: [...parents],
    author: AUTHOR,
    committer: AUTHOR,
    message: 'm',
  });
}

describe('materialisePatchFiles', () => {
  describe('Given more changes than the concurrency cap', () => {
    describe('When materialisePatchFiles is called', () => {
      it('Then in-flight reads stay bounded at 32', async () => {
        // Arrange — 80 add changes; expect peak concurrency ≤ 32.
        const ctx = createMemoryContext();
        const changes: AddChange[] = [];
        for (let i = 0; i < 80; i++) {
          const oid = await writeBlob(ctx, `body-${i}\n`);
          changes.push({
            type: 'add',
            newPath: `f${i}.txt` as FilePath,
            newId: oid,
            newMode: FILE_MODE.REGULAR,
          });
        }
        const originalRead = ctx.fs.read.bind(ctx.fs);
        let inFlight = 0;
        let peak = 0;
        vi.spyOn(ctx.fs, 'read').mockImplementation(async (path: string) => {
          inFlight++;
          peak = Math.max(peak, inFlight);
          try {
            return await originalRead(path);
          } finally {
            inFlight--;
          }
        });

        // Act
        const sut = await materialisePatchFiles(ctx, changes);

        // Assert — every result hydrated, peak in-flight obeyed the bound.
        expect(sut).toHaveLength(80);
        expect(peak).toBeGreaterThan(0);
        expect(peak).toBeLessThanOrEqual(32);
      });
    });
  });

  describe('Given a list of mixed change types', () => {
    describe('When materialisePatchFiles is called', () => {
      it('Then each entry carries the blob bytes appropriate to its kind', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const addOid = await writeBlob(ctx, 'added content\n');
        const delOid = await writeBlob(ctx, 'deleted content\n');
        const renameOid = await writeBlob(ctx, 'renamed content\n');

        const changes: ReadonlyArray<AddChange | DeleteChange | RenameChange> = [
          {
            type: 'add',
            newPath: 'a.txt' as FilePath,
            newId: addOid,
            newMode: FILE_MODE.REGULAR,
          },
          {
            type: 'delete',
            oldPath: 'b.txt' as FilePath,
            oldId: delOid,
            oldMode: FILE_MODE.REGULAR,
          },
          {
            type: 'rename',
            oldPath: 'c.txt' as FilePath,
            newPath: 'd.txt' as FilePath,
            oldId: renameOid,
            newId: renameOid,
            oldMode: FILE_MODE.REGULAR,
            newMode: FILE_MODE.REGULAR,
            similarity: { score: MAX_SCORE, maxScore: MAX_SCORE },
          },
        ];

        // Act
        const sut = await materialisePatchFiles(ctx, changes);

        // Assert
        expect(sut).toHaveLength(3);
        expect(sut[0]?.newContent).toEqual(utf8.encode('added content\n'));
        expect(sut[0]?.oldContent).toBeUndefined();
        expect(sut[1]?.oldContent).toEqual(utf8.encode('deleted content\n'));
        expect(sut[1]?.newContent).toBeUndefined();
        // Pure rename — no content is loaded for either side.
        expect(sut[2]?.oldContent).toBeUndefined();
        expect(sut[2]?.newContent).toBeUndefined();
      });
    });
  });
});

describe('materialiseOne', () => {
  describe('Given a modify change whose oldId equals newId (mode-only)', () => {
    describe('When materialiseOne is called', () => {
      it('Then both content fields alias the same Uint8Array reference', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const oid = await writeBlob(ctx, 'echo hi\n');
        const change: ModifyChange = {
          type: 'modify',
          path: 'foo.sh' as FilePath,
          oldId: oid,
          newId: oid,
          oldMode: FILE_MODE.REGULAR,
          newMode: FILE_MODE.EXECUTABLE,
        };

        // Act
        const sut = await materialiseOne(ctx, change);

        // Assert — reference identity proves the short-circuit ran without
        // coupling to a specific number of internal readBlob calls. A future
        // refactor that batches reads (e.g. via catFileBatch) keeps the
        // aliasing semantics that consumers actually depend on.
        expect(sut.oldContent).toBe(sut.newContent);
        expect(sut.oldContent).toEqual(utf8.encode('echo hi\n'));
      });
    });
  });

  describe('Given a modify change whose oldId and newId differ', () => {
    describe('When materialiseOne is called', () => {
      it('Then it loads both blobs in parallel', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const oldOid = await writeBlob(ctx, 'old\n');
        const newOid = await writeBlob(ctx, 'new\n');
        const change: ModifyChange = {
          type: 'modify',
          path: 'foo.txt' as FilePath,
          oldId: oldOid,
          newId: newOid,
          oldMode: FILE_MODE.REGULAR,
          newMode: FILE_MODE.REGULAR,
        };

        // Act
        const sut = await materialiseOne(ctx, change);

        // Assert
        expect(sut.oldContent).toEqual(utf8.encode('old\n'));
        expect(sut.newContent).toEqual(utf8.encode('new\n'));
      });
    });
  });

  describe('Given a type-change change', () => {
    describe('When materialiseOne is called', () => {
      it('Then it loads both sides via the same path as a modify', async () => {
        // Arrange — regular blob to symlink target string.
        const ctx = createMemoryContext();
        const oldOid = await writeBlob(ctx, 'plain text\n');
        const newOid = await writeBlob(ctx, '/target/path');
        const change: TypeChangeChange = {
          type: 'type-change',
          path: 'foo' as FilePath,
          oldId: oldOid,
          newId: newOid,
          oldMode: FILE_MODE.REGULAR,
          newMode: FILE_MODE.SYMLINK,
        };

        // Act
        const sut = await materialiseOne(ctx, change);

        // Assert
        expect(sut.oldContent).toEqual(utf8.encode('plain text\n'));
        expect(sut.newContent).toEqual(utf8.encode('/target/path'));
      });
    });
  });

  describe('Given a sub-100% rename change (score < MAX_SCORE)', () => {
    describe('When materialiseOne is called', () => {
      it('Then it loads both oldId and newId blobs in parallel', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const oldOid = await writeBlob(ctx, 'original content\n');
        const newOid = await writeBlob(ctx, 'modified content\n');
        const change: RenameChange = {
          type: 'rename',
          oldPath: 'src.txt' as FilePath,
          newPath: 'dst.txt' as FilePath,
          oldId: oldOid,
          newId: newOid,
          oldMode: FILE_MODE.REGULAR,
          newMode: FILE_MODE.REGULAR,
          similarity: { score: MAX_SCORE - 1, maxScore: MAX_SCORE },
        };

        // Act
        const sut = await materialiseOne(ctx, change);

        // Assert — both sides loaded
        expect(sut.oldContent).toEqual(utf8.encode('original content\n'));
        expect(sut.newContent).toEqual(utf8.encode('modified content\n'));
      });
    });
  });

  describe('Given an R100 rename change (score === MAX_SCORE)', () => {
    describe('When materialiseOne is called', () => {
      it('Then it loads neither side (oldContent and newContent are undefined)', async () => {
        // Arrange — pure rename: score === MAX_SCORE means no content needed
        const ctx = createMemoryContext();
        const oid = await writeBlob(ctx, 'same content\n');
        const change: RenameChange = {
          type: 'rename',
          oldPath: 'src.txt' as FilePath,
          newPath: 'dst.txt' as FilePath,
          oldId: oid,
          newId: oid,
          oldMode: FILE_MODE.REGULAR,
          newMode: FILE_MODE.REGULAR,
          similarity: { score: MAX_SCORE, maxScore: MAX_SCORE },
        };

        // Act
        const sut = await materialiseOne(ctx, change);

        // Assert — no blob content loaded for a pure rename
        expect(sut.oldContent).toBeUndefined();
        expect(sut.newContent).toBeUndefined();
      });
    });
  });

  describe('Given a sub-100% copy change (score < MAX_SCORE)', () => {
    describe('When materialiseOne is called', () => {
      it('Then it loads both oldId (source preimage) and newId (destination) blobs in parallel', async () => {
        // Arrange — copy at < MAX_SCORE: source preimage + destination both needed for hunk
        const ctx = createMemoryContext();
        const oldOid = await writeBlob(ctx, 'source content\n');
        const newOid = await writeBlob(ctx, 'copied content\n');
        const change: CopyChange = {
          type: 'copy',
          oldPath: 'src.txt' as FilePath,
          newPath: 'dst.txt' as FilePath,
          oldId: oldOid,
          newId: newOid,
          oldMode: FILE_MODE.REGULAR,
          newMode: FILE_MODE.REGULAR,
          similarity: { score: MAX_SCORE - 1, maxScore: MAX_SCORE },
        };

        // Act
        const sut = await materialiseOne(ctx, change);

        // Assert — both sides loaded
        expect(sut.oldContent).toEqual(utf8.encode('source content\n'));
        expect(sut.newContent).toEqual(utf8.encode('copied content\n'));
      });
    });
  });

  describe('Given an exact copy change (score === MAX_SCORE, matrix #C4)', () => {
    describe('When materialiseOne is called', () => {
      it('Then it loads neither side (oldContent and newContent are undefined)', async () => {
        // Arrange — C100: content byte-identical, no content needed for the header-only patch
        const ctx = createMemoryContext();
        const oid = await writeBlob(ctx, 'same content\n');
        const change: CopyChange = {
          type: 'copy',
          oldPath: 'src.txt' as FilePath,
          newPath: 'dst.txt' as FilePath,
          oldId: oid,
          newId: oid,
          oldMode: FILE_MODE.REGULAR,
          newMode: FILE_MODE.REGULAR,
          similarity: { score: MAX_SCORE, maxScore: MAX_SCORE },
        };

        // Act
        const sut = await materialiseOne(ctx, change);

        // Assert — no blob content loaded for an exact copy
        expect(sut.oldContent).toBeUndefined();
        expect(sut.newContent).toBeUndefined();
      });
    });
  });

  describe('Given an add change with a gitlink new side', () => {
    describe('When materialiseOne is called', () => {
      it('Then newContent is the synthesized Subproject commit line without reading a blob', async () => {
        // Arrange — gitlink oid is a real commit so readBlob would throw if called
        const ctx = createMemoryContext();
        const gitlinkOid = await writeCommitAsGitlink(ctx);
        const change: AddChange = {
          type: 'add',
          newPath: 'sub' as FilePath,
          newId: gitlinkOid,
          newMode: FILE_MODE.GITLINK,
        };

        // Act
        const sut = await materialiseOne(ctx, change);

        // Assert
        expect(sut.newContent).toEqual(utf8.encode(`Subproject commit ${gitlinkOid}\n`));
        expect(sut.oldContent).toBeUndefined();
      });
    });
  });

  describe('Given a delete change with a gitlink old side', () => {
    describe('When materialiseOne is called', () => {
      it('Then oldContent is the synthesized Subproject commit line without reading a blob', async () => {
        // Arrange — gitlink oid is a real commit so readBlob would throw if called
        const ctx = createMemoryContext();
        const gitlinkOid = await writeCommitAsGitlink(ctx);
        const change: DeleteChange = {
          type: 'delete',
          oldPath: 'sub' as FilePath,
          oldId: gitlinkOid,
          oldMode: FILE_MODE.GITLINK,
        };

        // Act
        const sut = await materialiseOne(ctx, change);

        // Assert
        expect(sut.oldContent).toEqual(utf8.encode(`Subproject commit ${gitlinkOid}\n`));
        expect(sut.newContent).toBeUndefined();
      });
    });
  });

  describe('Given a gitlink-to-gitlink modify (pointer bump, both sides gitlink, different oids)', () => {
    describe('When materialiseOne is called', () => {
      it('Then both oldContent and newContent are synthesized Subproject commit lines without reading a blob', async () => {
        // Arrange — both oids are real commits so readBlob would throw on either
        const ctx = createMemoryContext();
        const oldGitlinkOid = await writeCommitAsGitlink(ctx);
        const newGitlinkOid = await writeCommitAsGitlink(ctx, [oldGitlinkOid]);
        const change: ModifyChange = {
          type: 'modify',
          path: 'sub' as FilePath,
          oldId: oldGitlinkOid,
          newId: newGitlinkOid,
          oldMode: FILE_MODE.GITLINK,
          newMode: FILE_MODE.GITLINK,
        };

        // Act
        const sut = await materialiseOne(ctx, change);

        // Assert — oids differ so same-id short-circuit is not taken
        expect(sut.oldContent).toEqual(utf8.encode(`Subproject commit ${oldGitlinkOid}\n`));
        expect(sut.newContent).toEqual(utf8.encode(`Subproject commit ${newGitlinkOid}\n`));
      });
    });
  });

  describe('Given a type-change with gitlink on the new side (regular-to-gitlink)', () => {
    describe('When materialiseOne is called', () => {
      it('Then newContent is synthesized and oldContent is the real blob bytes', async () => {
        // Arrange — newId is a real commit; readBlob on it would throw
        const ctx = createMemoryContext();
        const oldOid = await writeBlob(ctx, 'regular content\n');
        const gitlinkOid = await writeCommitAsGitlink(ctx);
        const change: TypeChangeChange = {
          type: 'type-change',
          path: 'fg' as FilePath,
          oldId: oldOid,
          newId: gitlinkOid,
          oldMode: FILE_MODE.REGULAR,
          newMode: FILE_MODE.GITLINK,
        };

        // Act
        const sut = await materialiseOne(ctx, change);

        // Assert
        expect(sut.newContent).toEqual(utf8.encode(`Subproject commit ${gitlinkOid}\n`));
        expect(sut.oldContent).toEqual(utf8.encode('regular content\n'));
      });
    });
  });

  describe('Given a type-change with gitlink on the old side (gitlink-to-regular)', () => {
    describe('When materialiseOne is called', () => {
      it('Then oldContent is synthesized and newContent is the real blob bytes', async () => {
        // Arrange — oldId is a real commit; readBlob on it would throw
        const ctx = createMemoryContext();
        const gitlinkOid = await writeCommitAsGitlink(ctx);
        const newOid = await writeBlob(ctx, 'regular content\n');
        const change: TypeChangeChange = {
          type: 'type-change',
          path: 'gf' as FilePath,
          oldId: gitlinkOid,
          newId: newOid,
          oldMode: FILE_MODE.GITLINK,
          newMode: FILE_MODE.REGULAR,
        };

        // Act
        const sut = await materialiseOne(ctx, change);

        // Assert
        expect(sut.oldContent).toEqual(utf8.encode(`Subproject commit ${gitlinkOid}\n`));
        expect(sut.newContent).toEqual(utf8.encode('regular content\n'));
      });
    });
  });

  // --- Textconv transform cases ---

  describe('Given a modify change with textconv configured and applyTextconv opt-in (display path)', () => {
    describe('When materialisePatchFiles is called with applyTextconv: true', () => {
      it('Then both sides are transformed by the textconv command output', async () => {
        // Arrange
        const oldTransformed = utf8.encode('HELLO WORLD\n');
        const newTransformed = utf8.encode('HELLO THERE\n');
        const runner: CommandRunner = {
          run: async (req) => {
            // Token embeds side and path: old_a_x / new_a_x
            if (req.command.includes('old_a_x')) return { exitCode: 0, stdout: oldTransformed };
            return { exitCode: 0, stdout: newTransformed };
          },
        };
        const ctx = createMemoryContext({ command: runner });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitattributes`, 'a.x diff=upper\n');
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/config`,
          '[diff "upper"]\n\ttextconv = tr a-z A-Z\n',
        );
        const oldOid = await writeBlob(ctx, 'hello world\n');
        const newOid = await writeBlob(ctx, 'hello there\n');
        const change: ModifyChange = {
          type: 'modify',
          path: 'a.x' as FilePath,
          oldId: oldOid,
          newId: newOid,
          oldMode: FILE_MODE.REGULAR,
          newMode: FILE_MODE.REGULAR,
        };

        // Act
        const result = await materialisePatchFiles(ctx, [change], { applyTextconv: true });

        // Assert — both sides are textconv-transformed
        expect(result).toHaveLength(1);
        expect(result[0]?.oldContent).toEqual(oldTransformed);
        expect(result[0]?.newContent).toEqual(newTransformed);
        // OIDs on the change are untouched (R2 / T6)
        expect(result[0]?.change.type).toBe('modify');
        if (result[0]?.change.type === 'modify') {
          expect(result[0].change.oldId).toBe(oldOid);
          expect(result[0].change.newId).toBe(newOid);
        }
      });
    });
  });

  describe('Given an add change with textconv configured and applyTextconv opt-in', () => {
    describe('When materialisePatchFiles is called with applyTextconv: true', () => {
      it('Then only the new side is transformed (T-ADD)', async () => {
        // Arrange
        const newTransformed = utf8.encode('HELLO WORLD\n');
        const runner: CommandRunner = {
          run: async () => ({ exitCode: 0, stdout: newTransformed }),
        };
        const ctx = createMemoryContext({ command: runner });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitattributes`, 'a.x diff=upper\n');
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/config`,
          '[diff "upper"]\n\ttextconv = tr a-z A-Z\n',
        );
        const newOid = await writeBlob(ctx, 'hello world\n');
        const change: AddChange = {
          type: 'add',
          newPath: 'a.x' as FilePath,
          newId: newOid,
          newMode: FILE_MODE.REGULAR,
        };

        // Act
        const result = await materialisePatchFiles(ctx, [change], { applyTextconv: true });

        // Assert — new side is transformed, old side absent
        expect(result).toHaveLength(1);
        expect(result[0]?.newContent).toEqual(newTransformed);
        expect(result[0]?.oldContent).toBeUndefined();
      });
    });
  });

  describe('Given a delete change with textconv configured and applyTextconv opt-in', () => {
    describe('When materialisePatchFiles is called with applyTextconv: true', () => {
      it('Then only the old side is transformed', async () => {
        // Arrange
        const oldTransformed = utf8.encode('HELLO WORLD\n');
        const runner: CommandRunner = {
          run: async () => ({ exitCode: 0, stdout: oldTransformed }),
        };
        const ctx = createMemoryContext({ command: runner });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitattributes`, 'a.x diff=upper\n');
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/config`,
          '[diff "upper"]\n\ttextconv = tr a-z A-Z\n',
        );
        const oldOid = await writeBlob(ctx, 'hello world\n');
        const change: DeleteChange = {
          type: 'delete',
          oldPath: 'a.x' as FilePath,
          oldId: oldOid,
          oldMode: FILE_MODE.REGULAR,
        };

        // Act
        const result = await materialisePatchFiles(ctx, [change], { applyTextconv: true });

        // Assert — old side is transformed, new side absent
        expect(result).toHaveLength(1);
        expect(result[0]?.oldContent).toEqual(oldTransformed);
        expect(result[0]?.newContent).toBeUndefined();
      });
    });
  });

  describe('Given an add change with gitlink mode and textconv opt-in', () => {
    describe('When materialisePatchFiles is called with applyTextconv: true', () => {
      it('Then gitlink side is NOT transformed (synthesized Subproject commit line)', async () => {
        // Arrange
        let runnerCalled = false;
        const runner: CommandRunner = {
          run: async () => {
            runnerCalled = true;
            return { exitCode: 0, stdout: utf8.encode('SHOULD NOT HAPPEN\n') };
          },
        };
        const ctx = createMemoryContext({ command: runner });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitattributes`, 'sub diff=upper\n');
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/config`,
          '[diff "upper"]\n\ttextconv = tr a-z A-Z\n',
        );
        const gitlinkOid = await writeCommitAsGitlink(ctx);
        const change: AddChange = {
          type: 'add',
          newPath: 'sub' as FilePath,
          newId: gitlinkOid,
          newMode: FILE_MODE.GITLINK,
        };

        // Act
        const result = await materialisePatchFiles(ctx, [change], { applyTextconv: true });

        // Assert — gitlink side is synthesized, NOT transformed
        expect(result).toHaveLength(1);
        expect(result[0]?.newContent).toEqual(utf8.encode(`Subproject commit ${gitlinkOid}\n`));
        expect(runnerCalled).toBe(false);
      });
    });
  });

  describe('Given a modify change with ctx.command present but no applyTextconv opt-in', () => {
    describe('When materialiseOne is called without getProvider', () => {
      it('Then content is byte-identical raw blob bytes (textconv does not leak)', async () => {
        // Arrange — ctx.command is wired (simulates patch-id / rebase context)
        const runner: CommandRunner = {
          run: async () => ({ exitCode: 0, stdout: utf8.encode('SHOULD NOT HAPPEN\n') }),
        };
        const ctx = createMemoryContext({ command: runner });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitattributes`, 'a.x diff=upper\n');
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/config`,
          '[diff "upper"]\n\ttextconv = tr a-z A-Z\n',
        );
        const oldOid = await writeBlob(ctx, 'hello world\n');
        const newOid = await writeBlob(ctx, 'hello there\n');
        const change: ModifyChange = {
          type: 'modify',
          path: 'a.x' as FilePath,
          oldId: oldOid,
          newId: newOid,
          oldMode: FILE_MODE.REGULAR,
          newMode: FILE_MODE.REGULAR,
        };

        // Act — no applyTextconv option: raw path
        const sut = await materialiseOne(ctx, change);

        // Assert — raw bytes returned unchanged even though ctx.command is present
        expect(sut.oldContent).toEqual(utf8.encode('hello world\n'));
        expect(sut.newContent).toEqual(utf8.encode('hello there\n'));
      });
    });

    describe('When materialisePatchFiles is called without applyTextconv option', () => {
      it('Then content is byte-identical raw blob bytes (textconv does not leak)', async () => {
        // Arrange — ctx.command is wired (simulates patch-id / rebase / range-diff context)
        const runner: CommandRunner = {
          run: async () => ({ exitCode: 0, stdout: utf8.encode('SHOULD NOT HAPPEN\n') }),
        };
        const ctx = createMemoryContext({ command: runner });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitattributes`, 'a.x diff=upper\n');
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/config`,
          '[diff "upper"]\n\ttextconv = tr a-z A-Z\n',
        );
        const oldOid = await writeBlob(ctx, 'hello world\n');
        const newOid = await writeBlob(ctx, 'hello there\n');
        const change: ModifyChange = {
          type: 'modify',
          path: 'a.x' as FilePath,
          oldId: oldOid,
          newId: newOid,
          oldMode: FILE_MODE.REGULAR,
          newMode: FILE_MODE.REGULAR,
        };

        // Act — default path (no applyTextconv): raw bytes
        const result = await materialisePatchFiles(ctx, [change]);

        // Assert — raw bytes returned unchanged even though ctx.command is present
        expect(result).toHaveLength(1);
        expect(result[0]?.oldContent).toEqual(utf8.encode('hello world\n'));
        expect(result[0]?.newContent).toEqual(utf8.encode('hello there\n'));
      });
    });
  });

  describe('Given a modify change with no ctx.command (default diff path)', () => {
    describe('When materialiseOne is called', () => {
      it('Then content is byte-identical raw blob bytes (default path unchanged)', async () => {
        // Arrange
        const ctx = createMemoryContext(); // no command runner
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitattributes`, 'a.x diff=upper\n');
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/config`,
          '[diff "upper"]\n\ttextconv = tr a-z A-Z\n',
        );
        const oldOid = await writeBlob(ctx, 'hello world\n');
        const newOid = await writeBlob(ctx, 'hello there\n');
        const change: ModifyChange = {
          type: 'modify',
          path: 'a.x' as FilePath,
          oldId: oldOid,
          newId: newOid,
          oldMode: FILE_MODE.REGULAR,
          newMode: FILE_MODE.REGULAR,
        };

        // Act
        const sut = await materialiseOne(ctx, change);

        // Assert — raw bytes returned unchanged (no textconv)
        expect(sut.oldContent).toEqual(utf8.encode('hello world\n'));
        expect(sut.newContent).toEqual(utf8.encode('hello there\n'));
      });
    });
  });

  describe('Given two add changes with textconv configured and applyTextconv opt-in (concurrent)', () => {
    describe('When materialisePatchFiles is called with both changes', () => {
      it('Then each file gets its own correct textconv output with no temp-file collision', async () => {
        // Arrange — two different files with different textconv outputs;
        // concurrent execution must not clobber each other's temp files.
        const fileATransformed = utf8.encode('CONTENT A\n');
        const fileBTransformed = utf8.encode('CONTENT B\n');
        const calls: string[] = [];
        const runner: CommandRunner = {
          run: async (req) => {
            calls.push(req.command);
            // Token format: new_<sanitized-path> — a_txt vs b_txt
            if (req.command.includes('new_a_txt')) return { exitCode: 0, stdout: fileATransformed };
            if (req.command.includes('new_b_txt')) return { exitCode: 0, stdout: fileBTransformed };
            return { exitCode: 0, stdout: utf8.encode('UNEXPECTED\n') };
          },
        };
        const ctx = createMemoryContext({ command: runner });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitattributes`, '*.txt diff=upper\n');
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/config`,
          '[diff "upper"]\n\ttextconv = tr a-z A-Z\n',
        );
        const oidA = await writeBlob(ctx, 'content a\n');
        const oidB = await writeBlob(ctx, 'content b\n');
        const changeA: AddChange = {
          type: 'add',
          newPath: 'a.txt' as FilePath,
          newId: oidA,
          newMode: FILE_MODE.REGULAR,
        };
        const changeB: AddChange = {
          type: 'add',
          newPath: 'b.txt' as FilePath,
          newId: oidB,
          newMode: FILE_MODE.REGULAR,
        };

        // Act — two changes run concurrently via boundedMap
        const result = await materialisePatchFiles(ctx, [changeA, changeB], {
          applyTextconv: true,
        });

        // Assert — each file received its own correctly-transformed content
        expect(result).toHaveLength(2);
        expect(result[0]?.newContent).toEqual(fileATransformed);
        expect(result[1]?.newContent).toEqual(fileBTransformed);
        // Both calls happened (temp paths were distinct, no clobber)
        expect(calls).toHaveLength(2);
        // Temp paths differ — one embeds a_txt, the other b_txt
        const tokens = calls.map((c) => c.split(' ').pop() ?? '');
        expect(tokens[0]).not.toBe(tokens[1]);
      });
    });
  });

  // --- Binary override via diff attribute ---

  describe('Given a modify change with -diff attribute and applyTextconv opt-in (no runner — off-node path)', () => {
    describe('When materialisePatchFiles is called with applyTextconv: true on a memory context (no command)', () => {
      it('Then PatchFile has patchBinaryOverride binary and numstatBinaryOverride binary', async () => {
        // Arrange — memory context has no runner; -diff forces binary override in-process
        const ctx = createMemoryContext(); // no command runner
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitattributes`, '*.bin -diff\n');
        const oldOid = await writeBlob(ctx, 'textual old content\n');
        const newOid = await writeBlob(ctx, 'textual new content\n');
        const change: ModifyChange = {
          type: 'modify',
          path: 'file.bin' as FilePath,
          oldId: oldOid,
          newId: newOid,
          oldMode: FILE_MODE.REGULAR,
          newMode: FILE_MODE.REGULAR,
        };

        // Act
        const result = await materialisePatchFiles(ctx, [change], { applyTextconv: true });

        // Assert — -diff attribute forces binary both surfaces, even without a runner
        expect(result).toHaveLength(1);
        expect(result[0]?.patchBinaryOverride).toBe('binary');
        expect(result[0]?.numstatBinaryOverride).toBe('binary');
      });
    });
  });

  describe('Given a modify change with bare diff attribute (force text) and NUL content, applyTextconv opt-in', () => {
    describe('When materialisePatchFiles is called with applyTextconv: true on a memory context', () => {
      it('Then PatchFile has patchBinaryOverride text and numstatBinaryOverride text', async () => {
        // Arrange — bare diff forces text even over NUL content
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitattributes`, 'f diff\n');
        const NUL_CONTENT = new Uint8Array([0x68, 0x69, 0x00, 0x0a]); // "hi\0\n"
        const oldOid = await writeObject(ctx, {
          type: 'blob',
          id: '' as ObjectId,
          content: NUL_CONTENT,
        });
        const NUL_CONTENT2 = new Uint8Array([0x68, 0x6f, 0x00, 0x0a]); // "ho\0\n"
        const newOid = await writeObject(ctx, {
          type: 'blob',
          id: '' as ObjectId,
          content: NUL_CONTENT2,
        });
        const change: ModifyChange = {
          type: 'modify',
          path: 'f' as FilePath,
          oldId: oldOid,
          newId: newOid,
          oldMode: FILE_MODE.REGULAR,
          newMode: FILE_MODE.REGULAR,
        };

        // Act
        const result = await materialisePatchFiles(ctx, [change], { applyTextconv: true });

        // Assert — bare diff forces text both surfaces
        expect(result).toHaveLength(1);
        expect(result[0]?.patchBinaryOverride).toBe('text');
        expect(result[0]?.numstatBinaryOverride).toBe('text');
      });
    });
  });

  describe('Given a modify change with diff=up textconv configured and NUL-bearing raw blob but NUL-stripping textconv output', () => {
    describe('When materialisePatchFiles is called with applyTextconv: true', () => {
      it('Then patchBinaryOverride is text AND numstatBinaryOverride is binary (raw blob NUL computed before transform)', async () => {
        // Arrange — NUL-stripping textconv: raw=NUL ⇒ numstat:binary; output=clean ⇒ patch:text
        const NUL_CONTENT = new Uint8Array([0x68, 0x65, 0x6c, 0x6c, 0x6f, 0x00, 0x0a]); // "hello\0\n"
        const cleanOutput = utf8.encode('HELLO\n');
        const runner: CommandRunner = {
          run: async () => ({ exitCode: 0, stdout: cleanOutput }),
        };
        const ctx = createMemoryContext({ command: runner });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitattributes`, 'f diff=up\n');
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/config`,
          '[diff "up"]\n\ttextconv = strip-nul-and-upper\n',
        );
        const oldOid = await writeObject(ctx, {
          type: 'blob',
          id: '' as ObjectId,
          content: NUL_CONTENT,
        });
        const NUL_CONTENT2 = new Uint8Array([0x77, 0x6f, 0x72, 0x6c, 0x64, 0x00, 0x0a]); // "world\0\n"
        const newOid = await writeObject(ctx, {
          type: 'blob',
          id: '' as ObjectId,
          content: NUL_CONTENT2,
        });
        const change: ModifyChange = {
          type: 'modify',
          path: 'f' as FilePath,
          oldId: oldOid,
          newId: newOid,
          oldMode: FILE_MODE.REGULAR,
          newMode: FILE_MODE.REGULAR,
        };

        // Act
        const result = await materialisePatchFiles(ctx, [change], { applyTextconv: true });

        // Assert — patch=text (textconv output drives display), numstat=binary (raw blob has NUL)
        expect(result).toHaveLength(1);
        expect(result[0]?.patchBinaryOverride).toBe('text');
        expect(result[0]?.numstatBinaryOverride).toBe('binary');
        // Content is the transformed output (textconv ran)
        expect(result[0]?.oldContent).toEqual(cleanOutput);
        expect(result[0]?.newContent).toEqual(cleanOutput);
      });
    });
  });

  describe('Given a modify change with no applyTextconv opt-in (content-stable path)', () => {
    describe('When materialisePatchFiles is called without opt-in', () => {
      it('Then every PatchFile has patchBinaryOverride undefined and numstatBinaryOverride undefined', async () => {
        // Arrange — -diff attribute would force binary, but no opt-in ⇒ no override
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitattributes`, 'f -diff\n');
        const oldOid = await writeBlob(ctx, 'hello\n');
        const newOid = await writeBlob(ctx, 'world\n');
        const change: ModifyChange = {
          type: 'modify',
          path: 'f' as FilePath,
          oldId: oldOid,
          newId: newOid,
          oldMode: FILE_MODE.REGULAR,
          newMode: FILE_MODE.REGULAR,
        };

        // Act — no applyTextconv: content-stable callers
        const result = await materialisePatchFiles(ctx, [change]);

        // Assert — both overrides absent; content-stable boundary preserved
        expect(result).toHaveLength(1);
        expect(result[0]?.patchBinaryOverride).toBeUndefined();
        expect(result[0]?.numstatBinaryOverride).toBeUndefined();
      });
    });
  });

  describe('Given a modify change with -diff attribute and applyTextconv opt-in', () => {
    describe('When materialisePatchFiles is called', () => {
      it('Then patchBinaryOverride and numstatBinaryOverride are set from the single attribute lookup', async () => {
        // Arrange — verifies override is set (proving the provider was used correctly)
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitattributes`, 'x.f -diff\n');
        const oldOid = await writeBlob(ctx, 'old\n');
        const newOid = await writeBlob(ctx, 'new\n');
        const change: ModifyChange = {
          type: 'modify',
          path: 'x.f' as FilePath,
          oldId: oldOid,
          newId: newOid,
          oldMode: FILE_MODE.REGULAR,
          newMode: FILE_MODE.REGULAR,
        };

        // Act
        const result = await materialisePatchFiles(ctx, [change], { applyTextconv: true });

        // Assert — override was set (proving provider lookup ran)
        expect(result).toHaveLength(1);
        expect(result[0]?.patchBinaryOverride).toBe('binary');
        expect(result[0]?.numstatBinaryOverride).toBe('binary');
        // Content is the raw blob (no textconv runner)
        expect(result[0]?.oldContent).toEqual(utf8.encode('old\n'));
        expect(result[0]?.newContent).toEqual(utf8.encode('new\n'));
      });
    });
  });

  // --- Mutation-kill: resolveTextconvCommand empty-string and absent-key edge cases (L73 / L104) ---

  describe('Given a modify change with diff=empty and textconv set to empty string in git config', () => {
    describe('When materialisePatchFiles is called with applyTextconv: true', () => {
      it('Then empty textconv is treated as absent — no transform and no binary override', async () => {
        // Arrange — textconv = '' is a misconfigured entry; must resolve to undefined (no command)
        let runnerCalled = false;
        const runner: CommandRunner = {
          run: async () => {
            runnerCalled = true;
            return { exitCode: 0, stdout: utf8.encode('SHOULD NOT HAPPEN\n') };
          },
        };
        const ctx = createMemoryContext({ command: runner });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitattributes`, 'f.nc diff=empty\n');
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/config`,
          '[diff "empty"]\n\ttextconv = \n', // empty value
        );
        const oldOid = await writeBlob(ctx, 'old content\n');
        const newOid = await writeBlob(ctx, 'new content\n');
        const change: ModifyChange = {
          type: 'modify',
          path: 'f.nc' as FilePath,
          oldId: oldOid,
          newId: newOid,
          oldMode: FILE_MODE.REGULAR,
          newMode: FILE_MODE.REGULAR,
        };

        // Act
        const result = await materialisePatchFiles(ctx, [change], { applyTextconv: true });

        // Assert — empty textconv → command is undefined → no override, no runner call
        expect(result).toHaveLength(1);
        expect(result[0]?.patchBinaryOverride).toBeUndefined();
        expect(result[0]?.numstatBinaryOverride).toBeUndefined();
        expect(result[0]?.oldContent).toEqual(utf8.encode('old content\n'));
        expect(result[0]?.newContent).toEqual(utf8.encode('new content\n'));
        expect(runnerCalled).toBe(false);
      });
    });
  });

  describe('Given a modify change with diff=plain where the driver section has no textconv key (N4 shape)', () => {
    describe('When materialisePatchFiles is called with applyTextconv: true', () => {
      it('Then no binary override is set (command undefined → textconvConfigured false → EMPTY pair)', async () => {
        // Arrange — named driver exists but has no textconv key: textconvConfigured must stay false
        const ctx = createMemoryContext(); // no runner — off-node path
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitattributes`, 'a.pl diff=plain\n');
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/config`,
          '[diff "plain"]\n\tword-diff = color\n', // section present, no textconv
        );
        const oldOid = await writeBlob(ctx, 'old\n');
        const newOid = await writeBlob(ctx, 'new\n');
        const change: ModifyChange = {
          type: 'modify',
          path: 'a.pl' as FilePath,
          oldId: oldOid,
          newId: newOid,
          oldMode: FILE_MODE.REGULAR,
          newMode: FILE_MODE.REGULAR,
        };

        // Act
        const result = await materialisePatchFiles(ctx, [change], { applyTextconv: true });

        // Assert — no textconv key → resolveTextconvCommand returns undefined →
        //           textconvConfigured = false → resolveBinaryOverride returns EMPTY
        expect(result).toHaveLength(1);
        expect(result[0]?.patchBinaryOverride).toBeUndefined();
        expect(result[0]?.numstatBinaryOverride).toBeUndefined();
      });
    });
  });

  // --- Mutation-kill: withOverride key-absence when pair.numstat is undefined (L140) ---

  describe('Given a modify change with unspecified diff attribute and applyTextconv opt-in', () => {
    describe('When materialisePatchFiles is called with applyTextconv: true', () => {
      it('Then numstatBinaryOverride key is absent from the PatchFile (not present-but-undefined)', async () => {
        // Arrange — unspecified diff attr → resolveBinaryOverride returns EMPTY (no patch/numstat)
        const ctx = createMemoryContext();
        // no .gitattributes: diff attribute resolves to 'unspecified'
        const oldOid = await writeBlob(ctx, 'old\n');
        const newOid = await writeBlob(ctx, 'new\n');
        const change: ModifyChange = {
          type: 'modify',
          path: 'plain.txt' as FilePath,
          oldId: oldOid,
          newId: newOid,
          oldMode: FILE_MODE.REGULAR,
          newMode: FILE_MODE.REGULAR,
        };

        // Act
        const result = await materialisePatchFiles(ctx, [change], { applyTextconv: true });

        // Assert — key must be ABSENT, not merely undefined (pins the no-override default)
        expect(result).toHaveLength(1);
        expect('numstatBinaryOverride' in (result[0] ?? {})).toBe(false);
        expect('patchBinaryOverride' in (result[0] ?? {})).toBe(false);
      });
    });
  });

  // --- Mutation-kill: maybeTextconv gitlink guard (L130) ---

  describe('Given a type-change with gitlink on the new side, textconv configured, and applyTextconv opt-in', () => {
    describe('When materialisePatchFiles is called with applyTextconv: true', () => {
      it('Then the gitlink side is NOT passed to the textconv runner (synthesized content preserved)', async () => {
        // Arrange — new side is gitlink; runner must NOT be called for it
        let runnerCallCount = 0;
        const oldTransformed = utf8.encode('OLD TRANSFORMED\n');
        const runner: CommandRunner = {
          run: async (req) => {
            runnerCallCount++;
            // Only the old (regular) side should go through textconv
            if (req.command.includes('old_')) return { exitCode: 0, stdout: oldTransformed };
            return { exitCode: 0, stdout: utf8.encode('SHOULD NOT HAPPEN\n') };
          },
        };
        const ctx = createMemoryContext({ command: runner });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitattributes`, 'sub diff=upper\n');
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/config`,
          '[diff "upper"]\n\ttextconv = tr a-z A-Z\n',
        );
        const oldOid = await writeBlob(ctx, 'old regular content\n');
        const gitlinkOid = await writeCommitAsGitlink(ctx);
        const change: TypeChangeChange = {
          type: 'type-change',
          path: 'sub' as FilePath,
          oldId: oldOid,
          newId: gitlinkOid,
          oldMode: FILE_MODE.REGULAR,
          newMode: FILE_MODE.GITLINK,
        };

        // Act
        const result = await materialisePatchFiles(ctx, [change], { applyTextconv: true });

        // Assert — old side is textconv-transformed; new (gitlink) side is synthesized, runner not called for it
        expect(result).toHaveLength(1);
        expect(result[0]?.oldContent).toEqual(oldTransformed);
        expect(result[0]?.newContent).toEqual(utf8.encode(`Subproject commit ${gitlinkOid}\n`));
        // Runner called exactly once (for the regular old side only)
        expect(runnerCallCount).toBe(1);
      });
    });
  });

  // --- Mutation-kill: materialiseRenameOrCopy pure-rename gitlink branch (L224 NoCoverage) ---

  describe('Given an R100 rename change with gitlink mode, a configured textconv driver, and applyTextconv opt-in', () => {
    describe('When materialisePatchFiles is called with applyTextconv: true', () => {
      it('Then the gitlink rawIsBinary thunk returns false (not true) — patchBinaryOverride is text not binary/numstat', async () => {
        // Arrange — pure rename (R100) of a gitlink with a real textconv driver configured.
        //   isGitlink(newMode)=true → rawIsBinary thunk MUST return false.
        //   With textconvConfigured=true and rawIsBinary=false → FORCE_TEXT (patch: 'text', numstat: 'text').
        //   The L224 mutant (? true :) would give rawIsBinary=true → TEXTCONV_BINARY_NUMSTAT
        //   (patch: 'text', numstat: 'binary'), so numstatBinaryOverride would differ.
        const runner: CommandRunner = {
          run: async () => ({ exitCode: 0, stdout: utf8.encode('UNUSED\n') }),
        };
        const ctx = createMemoryContext({ command: runner });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitattributes`, 'sub diff=upper\n');
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/config`,
          '[diff "upper"]\n\ttextconv = tr a-z A-Z\n',
        );
        const gitlinkOid = await writeCommitAsGitlink(ctx);
        const change: RenameChange = {
          type: 'rename',
          oldPath: 'sub' as FilePath,
          newPath: 'sub' as FilePath,
          oldId: gitlinkOid,
          newId: gitlinkOid,
          oldMode: FILE_MODE.GITLINK,
          newMode: FILE_MODE.GITLINK,
          similarity: { score: MAX_SCORE, maxScore: MAX_SCORE },
        };

        // Act — applyTextconv: true exercises the pure-rename + config path (L216–L226)
        const result = await materialisePatchFiles(ctx, [change], { applyTextconv: true });

        // Assert — gitlink rawIsBinary=false → FORCE_TEXT → numstat is 'text' (not 'binary')
        expect(result).toHaveLength(1);
        expect(result[0]?.patchBinaryOverride).toBe('text');
        expect(result[0]?.numstatBinaryOverride).toBe('text');
        // Pure rename: no content fields
        expect(result[0]?.oldContent).toBeUndefined();
        expect(result[0]?.newContent).toBeUndefined();
      });
    });
  });

  // --- Mutation-kill: materialiseRenameOrCopy sub-100% isBinary OR (L240 NoCoverage) ---

  describe('Given a sub-100% rename change with only the old side binary and textconv configured', () => {
    describe('When materialisePatchFiles is called with applyTextconv: true', () => {
      it('Then numstatBinaryOverride is binary (OR detects one-sided binary; AND would miss it)', async () => {
        // Arrange — old side has NUL (binary), new side is clean text; || must fire
        const NUL_OLD = new Uint8Array([0x68, 0x69, 0x00, 0x0a]); // "hi\0\n"
        const cleanOutput = utf8.encode('CONVERTED\n');
        const runner: CommandRunner = {
          run: async () => ({ exitCode: 0, stdout: cleanOutput }),
        };
        const ctx = createMemoryContext({ command: runner });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitattributes`, 'r.f diff=up\n');
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/config`,
          '[diff "up"]\n\ttextconv = strip-nul\n',
        );
        const oldOid = await writeObject(ctx, {
          type: 'blob',
          id: '' as ObjectId,
          content: NUL_OLD,
        });
        const newOid = await writeBlob(ctx, 'clean text\n');
        const change: RenameChange = {
          type: 'rename',
          oldPath: 'r.f' as FilePath,
          newPath: 'r.f' as FilePath,
          oldId: oldOid,
          newId: newOid,
          oldMode: FILE_MODE.REGULAR,
          newMode: FILE_MODE.REGULAR,
          similarity: { score: MAX_SCORE - 1, maxScore: MAX_SCORE },
        };

        // Act
        const result = await materialisePatchFiles(ctx, [change], { applyTextconv: true });

        // Assert — old NUL blob → raw binary → numstatBinaryOverride = 'binary' (TEXTCONV_BINARY_NUMSTAT)
        expect(result).toHaveLength(1);
        expect(result[0]?.numstatBinaryOverride).toBe('binary');
        expect(result[0]?.patchBinaryOverride).toBe('text');
        // Both sides are textconv-transformed
        expect(result[0]?.oldContent).toEqual(cleanOutput);
        expect(result[0]?.newContent).toEqual(cleanOutput);
      });
    });
  });

  // --- Mutation-kill: materialiseModifyDifferentIds isBinary OR (L302) ---

  describe('Given a modify change with different oids where only the old side is binary and textconv configured', () => {
    describe('When materialisePatchFiles is called with applyTextconv: true', () => {
      it('Then numstatBinaryOverride is binary (OR detects one-sided binary; AND would miss it)', async () => {
        // Arrange — old side has NUL (binary), new side is clean; || must fire, && would not
        const NUL_OLD = new Uint8Array([0x77, 0x6f, 0x00, 0x0a]); // "wo\0\n"
        const cleanOutput = utf8.encode('CONVERTED\n');
        const runner: CommandRunner = {
          run: async () => ({ exitCode: 0, stdout: cleanOutput }),
        };
        const ctx = createMemoryContext({ command: runner });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitattributes`, 'd.f diff=up\n');
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/config`,
          '[diff "up"]\n\ttextconv = strip-nul\n',
        );
        const oldOid = await writeObject(ctx, {
          type: 'blob',
          id: '' as ObjectId,
          content: NUL_OLD,
        });
        const newOid = await writeBlob(ctx, 'clean text\n');
        const change: ModifyChange = {
          type: 'modify',
          path: 'd.f' as FilePath,
          oldId: oldOid,
          newId: newOid,
          oldMode: FILE_MODE.REGULAR,
          newMode: FILE_MODE.REGULAR,
        };

        // Act
        const result = await materialisePatchFiles(ctx, [change], { applyTextconv: true });

        // Assert — old NUL blob → rawIsBinary=true (OR) → numstat binary; patch text (textconv ran)
        expect(result).toHaveLength(1);
        expect(result[0]?.numstatBinaryOverride).toBe('binary');
        expect(result[0]?.patchBinaryOverride).toBe('text');
        expect(result[0]?.oldContent).toEqual(cleanOutput);
        expect(result[0]?.newContent).toEqual(cleanOutput);
      });
    });
  });

  // --- Mutation-kill: sanitizePath truncates the textconv temp-file token to 64 chars (L52) ---

  describe('Given an add change whose path sanitizes to more than 64 characters and textconv configured', () => {
    describe('When materialisePatchFiles is called with applyTextconv: true', () => {
      it('Then the textconv temp-file token is truncated to the first 64 sanitized characters', async () => {
        // Arrange — 70 alnum chars + ".txt" sanitizes to 74 chars; must be sliced to 64
        let capturedCommand = '';
        const runner: CommandRunner = {
          run: async (req) => {
            capturedCommand = req.command;
            return { exitCode: 0, stdout: utf8.encode('OUT\n') };
          },
        };
        const ctx = createMemoryContext({ command: runner });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitattributes`, '*.txt diff=upper\n');
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/config`,
          '[diff "upper"]\n\ttextconv = tr a-z A-Z\n',
        );
        const longName = `${'a'.repeat(70)}.txt`;
        const newOid = await writeBlob(ctx, 'hello\n');
        const change: AddChange = {
          type: 'add',
          newPath: longName as FilePath,
          newId: newOid,
          newMode: FILE_MODE.REGULAR,
        };

        // Act
        await materialisePatchFiles(ctx, [change], { applyTextconv: true });

        // Assert — the temp-file token embeds only the first 64 sanitized chars (".txt" dropped)
        const marker = 'TEXTCONV_INPUT_new_';
        const tmpPath = capturedCommand.split(' ').pop() ?? '';
        const sanitized = tmpPath.slice(tmpPath.indexOf(marker) + marker.length);
        expect(sanitized).toBe('a'.repeat(64));
        expect(sanitized).toHaveLength(64);
        expect(sanitized.endsWith('_txt')).toBe(false);
      });
    });
  });

  // --- Mutation-kill: materialiseRenameOrCopy sub-100% rawIsBinary both-sides-clean (L247) ---

  describe('Given a sub-100% rename change with both sides clean text and textconv configured', () => {
    describe('When materialisePatchFiles is called with applyTextconv: true', () => {
      it('Then numstatBinaryOverride is text (neither side binary; forcing rawIsBinary true would flip it to binary)', async () => {
        // Arrange — both blobs are clean; rawIsBinary must be false → FORCE_TEXT
        const converted = utf8.encode('CONVERTED\n');
        const runner: CommandRunner = {
          run: async () => ({ exitCode: 0, stdout: converted }),
        };
        const ctx = createMemoryContext({ command: runner });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitattributes`, 'r.f diff=up\n');
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/config`,
          '[diff "up"]\n\ttextconv = to-upper\n',
        );
        const oldOid = await writeBlob(ctx, 'clean old\n');
        const newOid = await writeBlob(ctx, 'clean new\n');
        const change: RenameChange = {
          type: 'rename',
          oldPath: 'r.f' as FilePath,
          newPath: 'r.f' as FilePath,
          oldId: oldOid,
          newId: newOid,
          oldMode: FILE_MODE.REGULAR,
          newMode: FILE_MODE.REGULAR,
          similarity: { score: MAX_SCORE - 1, maxScore: MAX_SCORE },
        };

        // Act
        const result = await materialisePatchFiles(ctx, [change], { applyTextconv: true });

        // Assert — both sides clean → rawIsBinary false → FORCE_TEXT (numstat text, not binary)
        expect(result).toHaveLength(1);
        expect(result[0]?.numstatBinaryOverride).toBe('text');
        expect(result[0]?.patchBinaryOverride).toBe('text');
        expect(result[0]?.oldContent).toEqual(converted);
        expect(result[0]?.newContent).toEqual(converted);
      });
    });
  });
});
