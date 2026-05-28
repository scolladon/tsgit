import { describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import {
  materialiseOne,
  materialisePatchFiles,
} from '../../../../../src/application/commands/internal/materialise-patch-files.js';
import { writeObject } from '../../../../../src/application/primitives/write-object.js';
import type {
  AddChange,
  DeleteChange,
  ModifyChange,
  RenameChange,
  TypeChangeChange,
} from '../../../../../src/domain/diff/index.js';
import type { FilePath, ObjectId } from '../../../../../src/domain/objects/index.js';
import { FILE_MODE } from '../../../../../src/domain/objects/index.js';

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
            id: renameOid,
            mode: FILE_MODE.REGULAR,
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
      it('Then it loads the blob exactly once and aliases both sides to the same bytes', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const oid = await writeBlob(ctx, 'echo hi\n');
        const spy = vi.spyOn(ctx.fs, 'read');
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

        // Assert — single readFile call (the short-circuit branch) + the two
        // content fields point at the same payload.
        expect(spy).toHaveBeenCalledTimes(1);
        expect(sut.oldContent).toEqual(utf8.encode('echo hi\n'));
        expect(sut.newContent).toEqual(utf8.encode('echo hi\n'));
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
});
