/**
 * git's fsck walks every worktree's reflogs and index, not only the current
 * one's: each worktree's reflog store lists its own per-worktree logs and
 * the shared ones — so a shared log is read once per worktree — and each
 * worktree's index roots its entries, its cache-tree and its resolve-undo
 * stages.
 */
import { describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { type FsckFinding, fsck } from '../../../../src/application/commands/fsck.js';
import { deriveWorktreeContext } from '../../../../src/application/primitives/internal/worktree-context.js';
import { looseObjectPath } from '../../../../src/application/primitives/path-layout.js';
import { readObject } from '../../../../src/application/primitives/read-object.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { permissionDenied } from '../../../../src/domain/error.js';
import type { GitIndex } from '../../../../src/domain/git-index/index-entry.js';
import { STAGE0_FLAGS } from '../../../../src/domain/git-index/index-entry.js';
import { hexToBytes } from '../../../../src/domain/objects/encoding.js';
import { FILE_MODE, type ObjectId } from '../../../../src/domain/objects/index.js';
import type { FilePath } from '../../../../src/domain/objects/object-id.js';
import type { Context } from '../../../../src/ports/context.js';
import { serializeIndexFixtureAsync } from '../primitives/fixtures.js';
import { writeSyntheticPack } from '../primitives/pack-fixture.js';

vi.mock('../../../../src/application/primitives/read-object.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../../src/application/primitives/read-object.js')>();
  return { ...actual, readObject: vi.fn(actual.readObject) };
});

const ABSENT = '1111111111111111111111111111111111111111' as ObjectId;
const ZERO = '0000000000000000000000000000000000000000' as ObjectId;
const EXIT_MISSING = 2;
const EXIT_REFS_CONTENT = 8;
const EXIT_CORRUPT = 1;
const AUTHOR = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};
const enc = new TextEncoder();

const writeBlob = (ctx: Context, content: string): Promise<ObjectId> =>
  writeObject(ctx, { type: 'blob', id: '' as ObjectId, content: enc.encode(content) });

const writeCommit = async (ctx: Context): Promise<ObjectId> => {
  const tree = await writeObject(ctx, { type: 'tree', id: '' as ObjectId, entries: [] });
  return writeObject(ctx, {
    type: 'commit',
    id: '' as ObjectId,
    data: {
      tree,
      parents: [],
      author: AUTHOR,
      committer: AUTHOR,
      message: 'base',
      extraHeaders: [],
    },
  });
};

/** A main repository on `main` plus linked worktrees `wt1` and `wt2`;
 *  `seed` runs before the first store access, so a pack it places is seen. */
const repoWithWorktrees = async (
  seed: (ctx: Context) => Promise<unknown> = async () => undefined,
): Promise<Context> => {
  const ctx = createMemoryContext();
  await seed(ctx);
  const base = await writeCommit(ctx);
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${base}\n`);
  for (const id of ['wt1', 'wt2']) {
    const adminDir = `${ctx.layout.gitDir}/worktrees/${id}`;
    await ctx.fs.writeUtf8(`${adminDir}/HEAD`, `${base}\n`);
    await ctx.fs.writeUtf8(`${adminDir}/gitdir`, `/work/${id}/.git\n`);
    await ctx.fs.writeUtf8(`${adminDir}/commondir`, '../..\n');
  }
  return ctx;
};

const reflogLine = (id: ObjectId): string => `${ZERO} ${id} Ada <ada@example.com> 1 +0000\tx\n`;

const indexEntry = (id: ObjectId, path: string) => ({
  ctimeSeconds: 0,
  ctimeNanoseconds: 0,
  mtimeSeconds: 0,
  mtimeNanoseconds: 0,
  dev: 0,
  ino: 0,
  mode: FILE_MODE.REGULAR,
  uid: 0,
  gid: 0,
  fileSize: 0,
  id,
  flags: STAGE0_FLAGS,
  path: path as FilePath,
});

const writeIndexAt = async (
  ctx: Context,
  gitDir: string,
  entries: ReadonlyArray<ReturnType<typeof indexEntry>>,
  extensions: GitIndex['extensions'] = [],
): Promise<void> => {
  const index: GitIndex = { version: 2, entries, extensions, trailerSha: new Uint8Array(0) };
  await ctx.fs.write(`${gitDir}/index`, await serializeIndexFixtureAsync(index, ctx));
};

/** A `TREE` extension whose root names `id` over one entry. */
const cacheTreeNaming = (id: ObjectId) => ({
  signature: 'TREE',
  data: Uint8Array.from([...enc.encode('\u00001 0\n'), ...hexToBytes(id)]),
});

/** A `REUC` extension: one record for `f` with the given stage modes and ids. */
const resolveUndo = (stages: ReadonlyArray<readonly [string, ObjectId | undefined]>) => ({
  signature: 'REUC',
  data: Uint8Array.from([
    ...enc.encode(`f\0${stages.map(([mode]) => mode).join('\0')}\0`),
    ...stages.flatMap(([, id]) => (id === undefined ? [] : [...hexToBytes(id)])),
  ]),
});

const reflogFindings = (findings: ReadonlyArray<FsckFinding>) =>
  findings.filter((finding) => finding.type === 'invalid-reflog-entry');

const lostFindings = (findings: ReadonlyArray<FsckFinding>) =>
  findings.filter((finding) => finding.type === 'unreachable' || finding.type === 'dangling');

const pointerFindings = (findings: ReadonlyArray<FsckFinding>) =>
  findings.filter(
    (finding) =>
      finding.type === 'invalid-cache-tree-pointer' ||
      finding.type === 'invalid-resolve-undo-pointer',
  );

describe('Given a linked worktree whose own HEAD reflog names an absent object', () => {
  describe('When fsck runs from the main worktree', () => {
    it('Then it reports the entry under worktrees/<id>/HEAD with bit 2', async () => {
      // Arrange
      const ctx = await repoWithWorktrees();
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/worktrees/wt1/logs/HEAD`, reflogLine(ABSENT));
      const sut = fsck;

      // Act
      const result = await sut(ctx);

      // Assert
      expect(reflogFindings(result.findings)).toEqual([
        { type: 'invalid-reflog-entry', ref: 'worktrees/wt1/HEAD', id: ABSENT },
      ]);
      expect(result.exitCode).toBe(EXIT_MISSING);
    });
  });
});

describe('Given the main HEAD reflog naming an absent object', () => {
  describe('When fsck runs from a linked worktree', () => {
    it('Then it reports the entry under main-worktree/HEAD', async () => {
      // Arrange
      const ctx = await repoWithWorktrees();
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/logs/HEAD`, reflogLine(ABSENT));
      const sut = fsck;

      // Act
      const result = await sut(deriveWorktreeContext(ctx, 'wt1', '/work/wt1'));

      // Assert
      expect(reflogFindings(result.findings)).toEqual([
        { type: 'invalid-reflog-entry', ref: 'main-worktree/HEAD', id: ABSENT },
      ]);
    });
  });
});

describe('Given a shared branch reflog naming an absent object', () => {
  describe('When fsck runs from the main worktree', () => {
    it('Then every worktree reports it once, as each reflog store lists the shared logs', async () => {
      // Arrange
      const ctx = await repoWithWorktrees();
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/logs/refs/heads/main`, reflogLine(ABSENT));
      const sut = fsck;

      // Act
      const result = await sut(ctx);

      // Assert
      const entry = { type: 'invalid-reflog-entry', ref: 'refs/heads/main', id: ABSENT };
      expect(reflogFindings(result.findings)).toEqual([entry, entry, entry]);
    });
  });
});

describe('Given a blob only a linked worktree index names', () => {
  describe('When fsck runs from the main worktree', () => {
    it('Then the blob is reachable, never dangling', async () => {
      // Arrange
      const ctx = await repoWithWorktrees();
      const blob = await writeBlob(ctx, 'only in wt1');
      await writeIndexAt(ctx, `${ctx.layout.gitDir}/worktrees/wt1`, [indexEntry(blob, 'w')]);
      const sut = fsck;

      // Act
      const result = await sut(ctx);

      // Assert
      expect(lostFindings(result.findings)).toEqual([]);
      expect(result.exitCode).toBe(0);
    });
  });
});

describe('Given a linked worktree index whose cache-tree names an absent tree', () => {
  describe('When fsck runs from the main worktree', () => {
    it('Then it reports the invalid cache-tree pointer with bit 8', async () => {
      // Arrange
      const ctx = await repoWithWorktrees();
      const blob = await writeBlob(ctx, 'tracked');
      await writeIndexAt(
        ctx,
        `${ctx.layout.gitDir}/worktrees/wt1`,
        [indexEntry(blob, 'a')],
        [cacheTreeNaming(ABSENT)],
      );
      const sut = fsck;

      // Act
      const result = await sut(ctx);

      // Assert
      expect(pointerFindings(result.findings)).toEqual([
        {
          type: 'invalid-cache-tree-pointer',
          id: ABSENT,
          index: `${ctx.layout.gitDir}/worktrees/wt1/index`,
        },
      ]);
      expect(result.exitCode).toBe(EXIT_REFS_CONTENT);
    });
  });
});

describe('Given an index recording resolve-undo stages', () => {
  describe('When a regular stage names a blob nothing else names', () => {
    it('Then the blob is reachable, never dangling', async () => {
      // Arrange
      const ctx = await repoWithWorktrees();
      const merged = await writeBlob(ctx, 'merged');
      const ours = await writeBlob(ctx, 'ours');
      await writeIndexAt(
        ctx,
        ctx.layout.gitDir,
        [indexEntry(merged, 'f')],
        [
          resolveUndo([
            ['0', undefined],
            ['100644', ours],
            ['0', undefined],
          ]),
        ],
      );
      const sut = fsck;

      // Act
      const result = await sut(ctx);

      // Assert
      expect(lostFindings(result.findings)).toEqual([]);
      expect(result.exitCode).toBe(0);
    });
  });

  describe('When a regular stage names an absent object', () => {
    it('Then it reports the invalid resolve-undo pointer with bit 8', async () => {
      // Arrange
      const ctx = await repoWithWorktrees();
      const merged = await writeBlob(ctx, 'merged');
      await writeIndexAt(
        ctx,
        ctx.layout.gitDir,
        [indexEntry(merged, 'f')],
        [
          resolveUndo([
            ['100644', ABSENT],
            ['0', undefined],
            ['0', undefined],
          ]),
        ],
      );
      const sut = fsck;

      // Act
      const result = await sut(ctx);

      // Assert
      expect(pointerFindings(result.findings)).toEqual([
        { type: 'invalid-resolve-undo-pointer', id: ABSENT, index: `${ctx.layout.gitDir}/index` },
      ]);
      expect(result.exitCode).toBe(EXIT_REFS_CONTENT);
    });
  });

  describe('When a regular stage names a blob only a pack holds and fsck skips packs', () => {
    it('Then nothing is reported, as git still parses the packed blob', async () => {
      // Arrange
      let packed = '' as ObjectId;
      const ctx = await repoWithWorktrees(async (seeded) => {
        const ids = await writeSyntheticPack(seeded, 'reuc', [
          { kind: 'base', type: 'blob', content: enc.encode('packed stage') },
        ]);
        packed = ids[0] as ObjectId;
      });
      const merged = await writeBlob(ctx, 'merged');
      await writeIndexAt(
        ctx,
        ctx.layout.gitDir,
        [indexEntry(merged, 'f')],
        [
          resolveUndo([
            ['100644', packed],
            ['0', undefined],
            ['0', undefined],
          ]),
        ],
      );
      const sut = fsck;

      // Act
      const result = await sut(ctx, { full: false });

      // Assert
      expect(pointerFindings(result.findings)).toEqual([]);
      expect(result.exitCode).toBe(0);
    });
  });

  describe('When a regular stage names a loose blob whose bytes hash to another blob', () => {
    it('Then it reports the invalid resolve-undo pointer beside the hash mismatch', async () => {
      // Arrange
      const ctx = await repoWithWorktrees();
      const merged = await writeBlob(ctx, 'merged');
      const ours = await writeBlob(ctx, 'ours');
      const theirs = await writeBlob(ctx, 'theirs');
      const oursPath = looseObjectPath(ctx.layout.gitDir, ours);
      await ctx.fs.write(oursPath, await ctx.fs.read(looseObjectPath(ctx.layout.gitDir, theirs)));
      await writeIndexAt(
        ctx,
        ctx.layout.gitDir,
        [indexEntry(merged, 'f'), indexEntry(theirs, 'g')],
        [
          resolveUndo([
            ['100644', ours],
            ['0', undefined],
            ['0', undefined],
          ]),
        ],
      );
      const sut = fsck;

      // Act
      const result = await sut(ctx);

      // Assert
      expect(pointerFindings(result.findings)).toEqual([
        { type: 'invalid-resolve-undo-pointer', id: ours, index: `${ctx.layout.gitDir}/index` },
      ]);
      expect(result.exitCode).toBe(EXIT_CORRUPT | EXIT_REFS_CONTENT);
    });
  });

  describe('When a regular stage names a loose blob whose bytes do not inflate', () => {
    it('Then fsck refuses, as git dies on the corrupt loose object', async () => {
      // Arrange
      const ctx = await repoWithWorktrees();
      const merged = await writeBlob(ctx, 'merged');
      const ours = await writeBlob(ctx, 'ours');
      const oursPath = looseObjectPath(ctx.layout.gitDir, ours);
      await ctx.fs.write(oursPath, enc.encode('garbage'));
      await writeIndexAt(
        ctx,
        ctx.layout.gitDir,
        [indexEntry(merged, 'f')],
        [
          resolveUndo([
            ['100644', ours],
            ['0', undefined],
            ['0', undefined],
          ]),
        ],
      );
      const sut = fsck;

      // Act
      const result = await sut(ctx).then(
        () => undefined,
        (err: unknown) => err,
      );

      // Assert
      expect(result).toMatchObject({
        data: {
          code: 'INVALID_OBJECT_HEADER',
          reason: `loose object ${ours} (stored in ${oursPath}) is corrupt`,
        },
      });
    });
  });

  describe('When the hash-checked read of a regular stage fails for an I/O reason', () => {
    it('Then the fault propagates, as a check that never ran must not pass', async () => {
      // Arrange
      const ctx = await repoWithWorktrees();
      const merged = await writeBlob(ctx, 'merged');
      const ours = await writeBlob(ctx, 'ours');
      await writeIndexAt(
        ctx,
        ctx.layout.gitDir,
        [indexEntry(merged, 'f')],
        [
          resolveUndo([
            ['100644', ours],
            ['0', undefined],
            ['0', undefined],
          ]),
        ],
      );
      const fault = permissionDenied(looseObjectPath(ctx.layout.gitDir, ours));
      const actual = vi.mocked(readObject).getMockImplementation() as typeof readObject;
      vi.mocked(readObject).mockImplementation((readCtx, id, options) =>
        options?.verifyHash === true ? Promise.reject(fault) : actual(readCtx, id, options),
      );
      const sut = fsck;

      // Act
      const result = await sut(ctx).then(
        () => undefined,
        (err: unknown) => err,
      );
      vi.mocked(readObject).mockImplementation(actual);

      // Assert
      expect(result).toMatchObject({ data: fault.data });
    });
  });

  describe('When only symlink and gitlink stages name absent objects', () => {
    it('Then nothing is reported, as git checks regular stages alone', async () => {
      // Arrange
      const ctx = await repoWithWorktrees();
      const merged = await writeBlob(ctx, 'merged');
      await writeIndexAt(
        ctx,
        ctx.layout.gitDir,
        [indexEntry(merged, 'f')],
        [
          resolveUndo([
            ['120000', ABSENT],
            ['160000', ABSENT],
            ['0', undefined],
          ]),
        ],
      );
      const sut = fsck;

      // Act
      const result = await sut(ctx);

      // Assert
      expect(pointerFindings(result.findings)).toEqual([]);
      expect(result.exitCode).toBe(0);
    });
  });
});

describe('Given the main and a linked worktree index naming the same absent stage', () => {
  describe('When fsck runs from the main worktree', () => {
    it('Then each pointer finding names the index it came from', async () => {
      // Arrange
      const ctx = await repoWithWorktrees();
      const merged = await writeBlob(ctx, 'merged');
      const linkedGitDir = `${ctx.layout.gitDir}/worktrees/wt1`;
      for (const gitDir of [ctx.layout.gitDir, linkedGitDir]) {
        await writeIndexAt(
          ctx,
          gitDir,
          [indexEntry(merged, 'f')],
          [
            resolveUndo([
              ['100644', ABSENT],
              ['0', undefined],
              ['0', undefined],
            ]),
          ],
        );
      }
      const sut = fsck;

      // Act
      const result = await sut(ctx);

      // Assert
      expect(pointerFindings(result.findings)).toEqual([
        { type: 'invalid-resolve-undo-pointer', id: ABSENT, index: `${ctx.layout.gitDir}/index` },
        { type: 'invalid-resolve-undo-pointer', id: ABSENT, index: `${linkedGitDir}/index` },
      ]);
    });
  });
});

describe('Given an index whose resolve-undo extension is malformed', () => {
  describe('When fsck runs', () => {
    it('Then the extension is ignored, as git drops it', async () => {
      // Arrange
      const ctx = await repoWithWorktrees();
      const merged = await writeBlob(ctx, 'merged');
      await writeIndexAt(
        ctx,
        ctx.layout.gitDir,
        [indexEntry(merged, 'f')],
        [{ signature: 'REUC', data: enc.encode('f\0') }],
      );
      const sut = fsck;

      // Act
      const result = await sut(ctx);

      // Assert
      expect(pointerFindings(result.findings)).toEqual([]);
      expect(result.exitCode).toBe(0);
    });
  });
});
