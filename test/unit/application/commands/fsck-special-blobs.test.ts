/**
 * git checks a `.gitmodules`/`.gitattributes` blob's content only once a tree
 * naming it has been checked: a blob met earlier is queued and checked at the
 * end, outside any pack, so the order fsck meets the copies decides the exit
 * bit — 4 for a pack entry checked in place, 1 for a queued one.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { type FsckFinding, fsck } from '../../../../src/application/commands/fsck.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import {
  FILE_MODE,
  type ObjectId,
  serializeTreeContent,
} from '../../../../src/domain/objects/index.js';
import { treeEntry } from '../../../../src/domain/objects/tree.js';
import type { Context } from '../../../../src/ports/context.js';
import { writeSyntheticPack } from '../primitives/pack-fixture.js';

const enc = new TextEncoder();
const EXIT_CONTENT = 1;
const EXIT_PACK = 4;
const OLDER = Date.UTC(2020, 0, 1);
const NEWER = Date.UTC(2021, 0, 1);
const EVIL_GITMODULES = enc.encode('[submodule "x"]\n\tpath = x\n\turl = --upload-pack=evil\n');

const initCtx = async (): Promise<Context> => {
  const ctx = createMemoryContext();
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
  return ctx;
};

const blobIdOf = async (ctx: Context, content: Uint8Array): Promise<ObjectId> => {
  const header = enc.encode(`blob ${content.length}\0`);
  return (await ctx.hash.hashHex(new Uint8Array([...header, ...content]))) as ObjectId;
};

const blobSpec = { kind: 'base' as const, type: 'blob' as const, content: EVIL_GITMODULES };

const treeSpec = (ctx: Context, blobId: ObjectId) => ({
  kind: 'base' as const,
  type: 'tree' as const,
  content: serializeTreeContent(
    {
      type: 'tree',
      id: '' as ObjectId,
      entries: [treeEntry(FILE_MODE.REGULAR, '.gitmodules', blobId)],
    },
    ctx.hashConfig,
  ),
});

const urlFindings = (findings: ReadonlyArray<FsckFinding>, id: ObjectId) =>
  findings.filter(
    (finding) =>
      finding.type === 'bad-object' && finding.msgId === 'gitmodulesUrl' && finding.id === id,
  );

const writePackAt = async (
  ctx: Context,
  at: number,
  name: string,
  entries: Parameters<typeof writeSyntheticPack>[2],
) => {
  vi.setSystemTime(at);
  await writeSyntheticPack(ctx, name, entries);
};

afterEach(() => {
  vi.useRealTimers();
});

describe('Given one pack holding the .gitmodules blob before the tree naming it', () => {
  describe('When fsck runs', () => {
    it('Then the blob is checked once at the end with bit 1, never bit 4', async () => {
      // Arrange
      const ctx = await initCtx();
      const blobId = await blobIdOf(ctx, EVIL_GITMODULES);
      await writeSyntheticPack(ctx, 'single', [blobSpec, treeSpec(ctx, blobId)]);
      const sut = fsck;

      // Act
      const result = await sut(ctx);

      // Assert
      expect(urlFindings(result.findings, blobId)).toHaveLength(1);
      expect(result.exitCode).toBe(EXIT_CONTENT);
    });
  });
});

describe('Given one pack holding the tree before the .gitmodules blob it names', () => {
  describe('When fsck runs', () => {
    it('Then the blob is checked in place with bit 4', async () => {
      // Arrange
      const ctx = await initCtx();
      const blobId = await blobIdOf(ctx, EVIL_GITMODULES);
      await writeSyntheticPack(ctx, 'single', [treeSpec(ctx, blobId), blobSpec]);
      const sut = fsck;

      // Act
      const result = await sut(ctx);

      // Assert
      expect(urlFindings(result.findings, blobId)).toHaveLength(1);
      expect(result.exitCode).toBe(EXIT_PACK);
    });
  });
});

describe('Given the .gitmodules blob and its tree in two packs', () => {
  describe('When the tree pack is newer, so git verifies it first', () => {
    it('Then the blob pack reports the blob with bit 4', async () => {
      // Arrange
      vi.useFakeTimers({ toFake: ['Date'] });
      const ctx = await initCtx();
      const blobId = await blobIdOf(ctx, EVIL_GITMODULES);
      await writePackAt(ctx, OLDER, 'a-blob', [blobSpec]);
      await writePackAt(ctx, NEWER, 'b-tree', [treeSpec(ctx, blobId)]);
      const sut = fsck;

      // Act
      const result = await sut(ctx);

      // Assert
      expect(urlFindings(result.findings, blobId)).toHaveLength(1);
      expect(result.exitCode).toBe(EXIT_PACK);
    });
  });

  describe('When the blob pack is newer, so git verifies it first', () => {
    it('Then the blob is checked once at the end with bit 1', async () => {
      // Arrange
      vi.useFakeTimers({ toFake: ['Date'] });
      const ctx = await initCtx();
      const blobId = await blobIdOf(ctx, EVIL_GITMODULES);
      await writePackAt(ctx, NEWER, 'a-blob', [blobSpec]);
      await writePackAt(ctx, OLDER, 'b-tree', [treeSpec(ctx, blobId)]);
      const sut = fsck;

      // Act
      const result = await sut(ctx);

      // Assert
      expect(urlFindings(result.findings, blobId)).toHaveLength(1);
      expect(result.exitCode).toBe(EXIT_CONTENT);
    });
  });
});

describe('Given a loose tree naming a .gitmodules blob only a pack holds', () => {
  describe('When fsck runs with --no-full, verifying no pack', () => {
    it('Then the queued blob is still read from the pack and checked with bit 1', async () => {
      // Arrange
      const ctx = await initCtx();
      const blobId = await blobIdOf(ctx, EVIL_GITMODULES);
      await writeSyntheticPack(ctx, 'blob-only', [blobSpec]);
      await writeObject(ctx, {
        type: 'tree',
        id: '' as ObjectId,
        entries: [treeEntry(FILE_MODE.REGULAR, '.gitmodules', blobId)],
      });
      const sut = fsck;

      // Act
      const result = await sut(ctx, { full: false });

      // Assert
      expect(urlFindings(result.findings, blobId)).toHaveLength(1);
      expect(result.exitCode).toBe(EXIT_CONTENT);
    });
  });
});

describe('Given a tree naming a .gitmodules blob no store holds', () => {
  describe('When fsck runs', () => {
    it('Then the queued blob reports gitmodulesMissing with bit 1', async () => {
      // Arrange
      const ctx = await initCtx();
      const blobId = await blobIdOf(ctx, EVIL_GITMODULES);
      await writeObject(ctx, {
        type: 'tree',
        id: '' as ObjectId,
        entries: [treeEntry(FILE_MODE.REGULAR, '.gitmodules', blobId)],
      });
      const sut = fsck;

      // Act
      const result = await sut(ctx);

      // Assert
      expect(result.findings).toContainEqual({
        type: 'bad-object',
        id: blobId,
        objectType: 'blob',
        msgId: 'gitmodulesMissing',
        severity: 'error',
      });
      expect(result.exitCode).toBe(EXIT_CONTENT);
    });
  });

  describe('When fsck runs with --connectivity-only', () => {
    it('Then no queued check runs and the exit code stays clean', async () => {
      // Arrange
      const ctx = await initCtx();
      const blobId = await blobIdOf(ctx, EVIL_GITMODULES);
      await writeObject(ctx, {
        type: 'tree',
        id: '' as ObjectId,
        entries: [treeEntry(FILE_MODE.REGULAR, '.gitmodules', blobId)],
      });
      const sut = fsck;

      // Act
      const result = await sut(ctx, { connectivityOnly: true });

      // Assert
      expect(result.findings.filter((finding) => finding.type === 'bad-object')).toEqual([]);
      expect(result.exitCode).toBe(0);
    });
  });
});

describe('Given a tree naming a tree object under .gitattributes', () => {
  describe('When fsck runs', () => {
    it('Then the queued object reports gitattributesBlob on its own type with bit 1', async () => {
      // Arrange
      const ctx = await initCtx();
      const emptyTreeId = await writeObject(ctx, { type: 'tree', id: '' as ObjectId, entries: [] });
      await writeObject(ctx, {
        type: 'tree',
        id: '' as ObjectId,
        entries: [treeEntry(FILE_MODE.REGULAR, '.gitattributes', emptyTreeId)],
      });
      const sut = fsck;

      // Act
      const result = await sut(ctx);

      // Assert
      expect(result.findings).toContainEqual({
        type: 'bad-object',
        id: emptyTreeId,
        objectType: 'tree',
        msgId: 'gitattributesBlob',
        severity: 'error',
      });
      expect(result.exitCode & EXIT_CONTENT).toBe(EXIT_CONTENT);
    });
  });
});

describe('Given fsck.skipList names a queued .gitmodules blob no store holds', () => {
  describe('When fsck runs', () => {
    it('Then the queued blob reports nothing', async () => {
      // Arrange
      const ctx = await initCtx();
      const blobId = await blobIdOf(ctx, EVIL_GITMODULES);
      await writeObject(ctx, {
        type: 'tree',
        id: '' as ObjectId,
        entries: [treeEntry(FILE_MODE.REGULAR, '.gitmodules', blobId)],
      });
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/skip`, `${blobId}\n`);
      await ctx.fs.writeUtf8(
        `${ctx.layout.gitDir}/config`,
        `[fsck]\n\tskipList = ${ctx.layout.gitDir}/skip\n`,
      );
      const sut = fsck;

      // Act
      const result = await sut(ctx);

      // Assert
      expect(result.findings.filter((finding) => finding.type === 'bad-object')).toEqual([]);
      expect(result.exitCode).toBe(0);
    });
  });
});

const BOTH_NAMES_CONTENT = enc.encode(
  `[submodule "x"]\n\tpath = x\n\turl = --upload-pack=evil\n# ${'a'.repeat(3000)}\n`,
);

/** Two loose trees naming `blobId`, one as `.gitmodules`, one as `.gitattributes`. */
const writeTreesNamingBoth = async (ctx: Context, blobId: ObjectId): Promise<void> => {
  for (const name of ['.gitmodules', '.gitattributes']) {
    await writeObject(ctx, {
      type: 'tree',
      id: '' as ObjectId,
      entries: [treeEntry(FILE_MODE.REGULAR, name, blobId)],
    });
  }
};

const specialMsgIds = (findings: ReadonlyArray<FsckFinding>, id: ObjectId) =>
  findings.flatMap((finding) =>
    finding.type === 'bad-object' && finding.id === id ? [finding.msgId] : [],
  );

const namingTreeSpec = (ctx: Context, name: string, blobId: ObjectId) => ({
  kind: 'base' as const,
  type: 'tree' as const,
  content: serializeTreeContent(
    { type: 'tree', id: '' as ObjectId, entries: [treeEntry(FILE_MODE.REGULAR, name, blobId)] },
    ctx.hashConfig,
  ),
});

describe('Given a pack holding a .gitmodules tree, a .gitattributes tree, then the blob both name', () => {
  describe('When fsck runs', () => {
    it('Then the blob is checked in place under both names, .gitmodules first', async () => {
      // Arrange
      const ctx = await initCtx();
      const blobId = await blobIdOf(ctx, BOTH_NAMES_CONTENT);
      await writeSyntheticPack(ctx, 'both-after', [
        namingTreeSpec(ctx, '.gitattributes', blobId),
        namingTreeSpec(ctx, '.gitmodules', blobId),
        { kind: 'base', type: 'blob', content: BOTH_NAMES_CONTENT },
      ]);
      const sut = fsck;

      // Act
      const result = await sut(ctx);

      // Assert
      expect(specialMsgIds(result.findings, blobId)).toEqual([
        'gitmodulesUrl',
        'gitattributesLineLength',
      ]);
      expect(result.exitCode).toBe(EXIT_PACK);
    });
  });
});

describe('Given a pack holding a .gitattributes tree, the blob, then a .gitmodules tree naming it', () => {
  describe('When fsck runs', () => {
    it('Then git rechecks the blob under every name it is queued under once .gitmodules is deferred', async () => {
      // Arrange
      const ctx = await initCtx();
      const blobId = await blobIdOf(ctx, BOTH_NAMES_CONTENT);
      await writeSyntheticPack(ctx, 'blob-between', [
        namingTreeSpec(ctx, '.gitattributes', blobId),
        { kind: 'base', type: 'blob', content: BOTH_NAMES_CONTENT },
        namingTreeSpec(ctx, '.gitmodules', blobId),
      ]);
      const sut = fsck;

      // Act
      const result = await sut(ctx);

      // Assert
      expect(specialMsgIds(result.findings, blobId)).toEqual([
        'gitattributesLineLength',
        'gitmodulesUrl',
        'gitattributesLineLength',
      ]);
    });
  });
});

describe('Given an absent blob one tree names .gitmodules and another .gitattributes', () => {
  describe('When fsck runs', () => {
    it('Then it is reported missing under each name', async () => {
      // Arrange
      const ctx = await initCtx();
      const blobId = await blobIdOf(ctx, BOTH_NAMES_CONTENT);
      await writeTreesNamingBoth(ctx, blobId);
      const sut = fsck;

      // Act
      const result = await sut(ctx);

      // Assert
      expect(specialMsgIds(result.findings, blobId)).toEqual([
        'gitmodulesMissing',
        'gitattributesMissing',
      ]);
    });
  });
});

const EMPTY_TREE_HEADER = enc.encode('tree 0\0');

describe('Given a pack holding a tree naming a tree object under .gitattributes, then that tree', () => {
  describe('When fsck runs', () => {
    it('Then the tree met in place stays queued and reports gitattributesBlob at the end', async () => {
      // Arrange
      const ctx = await initCtx();
      const emptyTreeId = (await ctx.hash.hashHex(EMPTY_TREE_HEADER)) as ObjectId;
      await writeSyntheticPack(ctx, 'tree-after', [
        namingTreeSpec(ctx, '.gitattributes', emptyTreeId),
        { kind: 'base', type: 'tree', content: new Uint8Array() },
      ]);
      const sut = fsck;

      // Act
      const result = await sut(ctx);

      // Assert
      expect(result.findings).toContainEqual({
        type: 'bad-object',
        id: emptyTreeId,
        objectType: 'tree',
        msgId: 'gitattributesBlob',
        severity: 'error',
      });
    });
  });
});

describe('Given a blob whose bytes read like a tree naming .gitmodules', () => {
  describe('When fsck runs', () => {
    it('Then nothing is queued, as only a checked tree queues special blobs', async () => {
      // Arrange
      const ctx = await initCtx();
      const absentId = await blobIdOf(ctx, EVIL_GITMODULES);
      const treeLikeBytes = serializeTreeContent(
        {
          type: 'tree',
          id: '' as ObjectId,
          entries: [treeEntry(FILE_MODE.REGULAR, '.gitmodules', absentId)],
        },
        ctx.hashConfig,
      );
      await writeObject(ctx, { type: 'blob', id: '' as ObjectId, content: treeLikeBytes });
      const sut = fsck;

      // Act
      const result = await sut(ctx);

      // Assert
      expect(result.findings.filter((finding) => finding.type === 'bad-object')).toEqual([]);
      expect(result.exitCode).toBe(0);
    });
  });
});

describe('Given a queued .gitmodules blob no store holds and fsck.gitmodulesMissing=warn', () => {
  describe('When fsck runs', () => {
    it('Then the finding is a warning and sets no exit bit', async () => {
      // Arrange
      const ctx = await initCtx();
      const blobId = await blobIdOf(ctx, EVIL_GITMODULES);
      await writeObject(ctx, {
        type: 'tree',
        id: '' as ObjectId,
        entries: [treeEntry(FILE_MODE.REGULAR, '.gitmodules', blobId)],
      });
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[fsck]\n\tgitmodulesMissing = warn\n');
      const sut = fsck;

      // Act
      const result = await sut(ctx);

      // Assert
      expect(result.findings).toContainEqual({
        type: 'bad-object',
        id: blobId,
        objectType: 'blob',
        msgId: 'gitmodulesMissing',
        severity: 'warning',
      });
      expect(result.exitCode).toBe(0);
    });
  });
});

describe('Given a queued .gitmodules blob whose pack cannot be read for a reason no object error names', () => {
  describe('When fsck runs with --no-full', () => {
    it('Then the fault propagates instead of reporting the blob missing', async () => {
      // Arrange
      const ctx = await initCtx();
      const blobId = await blobIdOf(ctx, EVIL_GITMODULES);
      await writeSyntheticPack(ctx, 'blob-only', [blobSpec]);
      await writeObject(ctx, {
        type: 'tree',
        id: '' as ObjectId,
        entries: [treeEntry(FILE_MODE.REGULAR, '.gitmodules', blobId)],
      });
      const fault = new Error('disk fault');
      const open = ctx.fs.openWithNoFollow;
      vi.spyOn(ctx.fs, 'openWithNoFollow').mockImplementation((path, mode) =>
        path.endsWith('.pack') ? Promise.reject(fault) : open(path, mode),
      );
      const sut = fsck;

      // Act
      const result = sut(ctx, { full: false });

      // Assert
      await expect(result).rejects.toBe(fault);
    });
  });
});
