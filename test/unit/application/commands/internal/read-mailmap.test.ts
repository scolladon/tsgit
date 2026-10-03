import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { readMailmap } from '../../../../../src/application/commands/internal/read-mailmap.js';
import { invalidateConfigCache } from '../../../../../src/application/primitives/config-read.js';
import { writeObject } from '../../../../../src/application/primitives/write-object.js';
import { writeTree } from '../../../../../src/application/primitives/write-tree.js';
import { mapUser } from '../../../../../src/domain/mailmap/index.js';
import type { ObjectId } from '../../../../../src/domain/objects/index.js';
import { treeEntry } from '../../../../../src/domain/objects/tree.js';
import type { Context } from '../../../../../src/ports/context.js';
import { asBareContext } from '../fixtures.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const IDENTITY = { name: 'A', email: 'a@example.com', timestamp: 0, timezoneOffset: '+0000' };
const REGULAR_FILE = '100644';

const mapped = async (ctx: Context, mail: string): Promise<string> => {
  const index = await readMailmap(ctx);
  return decoder.decode(
    mapUser(index, { name: encoder.encode('Old'), mail: encoder.encode(mail) }).name,
  );
};

const rule = (name: string, mail: string): string => `${name} <new@example.com> <${mail}>\n`;

/** Commits a tree holding `.mailmap`, and points `refs/heads/main` and HEAD at it. */
const commitMailmap = async (
  ctx: Context,
  text: string,
): Promise<{ readonly commit: ObjectId; readonly blob: ObjectId }> => {
  const blob = await writeObject(ctx, {
    type: 'blob',
    id: '' as ObjectId,
    content: encoder.encode(text),
  });
  const tree = await writeTree(ctx, [treeEntry(REGULAR_FILE as never, '.mailmap', blob)]);
  const commit = await writeObject(ctx, {
    type: 'commit',
    id: '' as ObjectId,
    data: {
      tree,
      parents: [],
      author: IDENTITY,
      committer: IDENTITY,
      message: 'm\n',
      extraHeaders: [],
    },
  });
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${commit}\n`);
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
  return { commit, blob };
};

const writeConfig = async (ctx: Context, text: string): Promise<void> => {
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, text);
  invalidateConfigCache(ctx);
};

/** A repository whose HEAD names a branch with no commit yet. */
const unbornRepository = async (): Promise<Context> => {
  const ctx = createMemoryContext();
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
  return ctx;
};

describe('readMailmap', () => {
  describe('Given a worktree .mailmap', () => {
    describe('When the mailmap is read', () => {
      it('Then its rules apply', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8('/repo/.mailmap', rule('Worktree', 'old@example.com'));
        const sut = mapped;

        // Act
        const result = await sut(ctx, 'old@example.com');

        // Assert
        expect(result).toBe('Worktree');
      });
    });
  });

  describe('Given a committed .mailmap and no mailmap.blob in a non-bare repository', () => {
    describe('When the mailmap is read', () => {
      it('Then the committed file is not consulted', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await commitMailmap(ctx, rule('Committed', 'old@example.com'));

        // Act
        const result = await mapped(ctx, 'old@example.com');

        // Assert
        expect(result).toBe('Old');
      });
    });
  });

  describe('Given mailmap.blob naming a committed file', () => {
    describe('When the mailmap is read', () => {
      it('Then the blob rules apply', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await commitMailmap(ctx, rule('Blob', 'old@example.com'));
        await writeConfig(ctx, '[mailmap]\n\tblob = main:.mailmap\n');

        // Act
        const result = await mapped(ctx, 'old@example.com');

        // Assert
        expect(result).toBe('Blob');
      });
    });
  });

  describe('Given mailmap.blob naming a revision that does not exist', () => {
    describe('When the mailmap is read', () => {
      it('Then nothing is mapped', async () => {
        // Arrange
        const ctx = await unbornRepository();
        await writeConfig(ctx, '[mailmap]\n\tblob = nowhere:.mailmap\n');

        // Act
        const result = await mapped(ctx, 'old@example.com');

        // Assert
        expect(result).toBe('Old');
      });
    });
  });

  describe.each([
    { label: 'a revision expression', blob: 'main~0:.mailmap' },
    { label: 'an abbreviated blob id', blob: 'abbreviated' },
    { label: 'a name past a dangling symref', blob: 'dg:.mailmap' },
  ])('Given mailmap.blob naming the committed file through $label', ({ blob }) => {
    describe('When the mailmap is read', () => {
      it('Then the blob rules apply, warning as get_oid does', async () => {
        // Arrange
        const warnings: string[] = [];
        const base = createMemoryContext();
        const ctx = { ...base, logger: { warn: (message: string) => warnings.push(message) } };
        const { commit, blob: blobId } = await commitMailmap(ctx, rule('Blob', 'old@example.com'));
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/dg`, `${commit}\n`);
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/tags/dg`, 'ref: refs/tags/nope\n');
        const named = blob === 'abbreviated' ? blobId.slice(0, 7) : blob;
        await writeConfig(ctx, `[mailmap]\n\tblob = ${named}\n`);

        // Act
        const result = await mapped(ctx, 'old@example.com');

        // Assert
        expect(result).toBe('Blob');
        expect(warnings).toEqual(
          blob === 'dg:.mailmap' ? ['ignoring dangling symref refs/tags/dg'] : [],
        );
      });
    });
  });

  describe('Given mailmap.blob naming a path the revision does not hold', () => {
    describe('When the mailmap is read', () => {
      it('Then nothing is mapped', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await commitMailmap(ctx, rule('Blob', 'old@example.com'));
        await writeConfig(ctx, '[mailmap]\n\tblob = main:absent\n');

        // Act
        const result = await mapped(ctx, 'old@example.com');

        // Assert
        expect(result).toBe('Old');
      });
    });
  });

  describe('Given mailmap.blob read under a malformed ambiguity setting', () => {
    describe('When the mailmap is read', () => {
      it('Then the refusal git dies with propagates', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await commitMailmap(ctx, rule('Blob', 'old@example.com'));
        await writeConfig(
          ctx,
          '[core]\n\twarnAmbiguousRefs = maybe\n[mailmap]\n\tblob = main:.mailmap\n',
        );
        const sut = readMailmap;

        // Act
        const result = await sut(ctx).then(
          () => undefined,
          (error: unknown) => (error as { data?: unknown }).data,
        );

        // Assert
        expect(result).toMatchObject({ code: 'CONFIG_BAD_BOOLEAN_VALUE', value: 'maybe' });
      });
    });
  });

  describe('Given mailmap.blob naming a commit rather than a blob', () => {
    describe('When the mailmap is read', () => {
      it('Then nothing is mapped and the misfit is reported as git errors it', async () => {
        // Arrange
        const errors: string[] = [];
        const base = createMemoryContext();
        const ctx = { ...base, logger: { error: (message: string) => errors.push(message) } };
        await commitMailmap(ctx, rule('Blob', 'old@example.com'));
        await writeConfig(ctx, '[mailmap]\n\tblob = main\n');

        // Act
        const result = await mapped(ctx, 'old@example.com');

        // Assert
        expect(result).toBe('Old');
        expect(errors).toEqual(['mailmap is not a blob: main']);
      });
    });
  });

  describe('Given mailmap.blob an abbreviated object id two objects share', () => {
    describe('When the mailmap is read', () => {
      it('Then the ambiguity is reported as git errors it and the blob is skipped', async () => {
        // Arrange
        const errors: string[] = [];
        const base = createMemoryContext();
        const ctx = { ...base, logger: { error: (message: string) => errors.push(message) } };
        await commitMailmap(ctx, rule('Blob', 'old@example.com'));
        for (const tail of ['0'.repeat(34), '1'.repeat(34)]) {
          await ctx.fs.write(`${ctx.layout.gitDir}/objects/ab/cdef${tail}`, new Uint8Array([1]));
        }
        await writeConfig(ctx, '[mailmap]\n\tblob = abcdef\n');
        const sut = mapped;

        // Act
        const result = await sut(ctx, 'old@example.com');

        // Assert
        expect(result).toBe('Old');
        expect(errors).toEqual(['short object ID abcdef is ambiguous']);
      });
    });
  });

  describe('Given mailmap.blob a full object id naming no object', () => {
    describe('When the mailmap is read', () => {
      it('Then the unreadable object is reported as git errors it and the blob is skipped', async () => {
        // Arrange
        const errors: string[] = [];
        const base = createMemoryContext();
        const ctx = { ...base, logger: { error: (message: string) => errors.push(message) } };
        await commitMailmap(ctx, rule('Blob', 'old@example.com'));
        const missing = '0123456789012345678901234567890123456789';
        await writeConfig(ctx, `[mailmap]\n\tblob = ${missing}\n`);
        const sut = mapped;

        // Act
        const result = await sut(ctx, 'old@example.com');

        // Assert
        expect(result).toBe('Old');
        expect(errors).toEqual([`unable to read mailmap object at ${missing}`]);
      });
    });
  });

  describe('Given a bare repository with a committed .mailmap and no mailmap.blob', () => {
    describe('When the mailmap is read', () => {
      it('Then HEAD:.mailmap applies', async () => {
        // Arrange
        const seeded = createMemoryContext();
        await commitMailmap(seeded, rule('Head', 'old@example.com'));
        const ctx = asBareContext(seeded);

        // Act
        const result = await mapped(ctx, 'old@example.com');

        // Assert
        expect(result).toBe('Head');
      });
    });
  });

  describe('Given a bare repository whose mailmap.blob names another file', () => {
    describe('When the mailmap is read', () => {
      it('Then the configured blob replaces the HEAD default', async () => {
        // Arrange
        const seeded = createMemoryContext();
        await commitMailmap(seeded, rule('Head', 'old@example.com'));
        await writeConfig(seeded, '[mailmap]\n\tblob = refs/heads/main:missing\n');
        const ctx = asBareContext(seeded);

        // Act
        const result = await mapped(ctx, 'old@example.com');

        // Assert
        expect(result).toBe('Old');
      });
    });
  });

  describe('Given a bare repository and a .mailmap file beside it', () => {
    describe('When the mailmap is read', () => {
      it('Then the worktree path is not read', async () => {
        // Arrange
        const seeded = await unbornRepository();
        await seeded.fs.writeUtf8('/repo/.mailmap', rule('Worktree', 'old@example.com'));
        const ctx = asBareContext(seeded);

        // Act
        const result = await mapped(ctx, 'old@example.com');

        // Assert
        expect(result).toBe('Old');
      });
    });
  });

  describe('Given a bare layout that still names a work directory', () => {
    const bareKeepingWorkDir = (ctx: Context): Context => ({
      ...ctx,
      layout: { ...ctx.layout, bare: true },
    });

    describe('When the mailmap is read with a committed .mailmap', () => {
      it('Then HEAD:.mailmap applies', async () => {
        // Arrange
        const seeded = createMemoryContext();
        await commitMailmap(seeded, rule('Head', 'old@example.com'));
        const ctx = bareKeepingWorkDir(seeded);

        // Act
        const result = await mapped(ctx, 'old@example.com');

        // Assert
        expect(result).toBe('Head');
      });
    });

    describe('When the mailmap is read with a .mailmap file in that directory', () => {
      it('Then the file is not read', async () => {
        // Arrange
        const seeded = await unbornRepository();
        await seeded.fs.writeUtf8('/repo/.mailmap', rule('Worktree', 'old@example.com'));
        const ctx = bareKeepingWorkDir(seeded);

        // Act
        const result = await mapped(ctx, 'old@example.com');

        // Assert
        expect(result).toBe('Old');
      });
    });
  });

  describe('Given a non-bare layout without a work directory', () => {
    describe('When the mailmap is read with a committed .mailmap', () => {
      it('Then neither the work tree nor HEAD:.mailmap is consulted', async () => {
        // Arrange
        const seeded = createMemoryContext();
        await commitMailmap(seeded, rule('Head', 'old@example.com'));
        const { workDir: _workDir, ...layout } = seeded.layout;
        const ctx: Context = { ...seeded, layout: { ...layout, bare: false } };

        // Act
        const result = await mapped(ctx, 'old@example.com');

        // Assert
        expect(result).toBe('Old');
      });
    });
  });

  describe('Given mailmap.file', () => {
    describe('When the mailmap is read', () => {
      it('Then its rules apply', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8('/repo/outside/mailmap', rule('File', 'old@example.com'));
        await writeConfig(ctx, '[mailmap]\n\tfile = /repo/outside/mailmap\n');

        // Act
        const result = await mapped(ctx, 'old@example.com');

        // Assert
        expect(result).toBe('File');
      });
    });
  });

  describe('Given the worktree file, the blob and mailmap.file mapping the same address', () => {
    describe('When the mailmap is read', () => {
      it('Then mailmap.file wins over the blob, which wins over the worktree file', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8('/repo/.mailmap', rule('Worktree', 'old@example.com'));
        await commitMailmap(ctx, rule('Blob', 'old@example.com'));
        await ctx.fs.writeUtf8('/repo/outside/mailmap', rule('File', 'old@example.com'));
        await writeConfig(
          ctx,
          '[mailmap]\n\tblob = main:.mailmap\n\tfile = /repo/outside/mailmap\n',
        );

        // Act
        const result = await mapped(ctx, 'old@example.com');
        await writeConfig(ctx, '[mailmap]\n\tblob = main:.mailmap\n');
        const withoutFile = await mapped(ctx, 'old@example.com');

        // Assert
        expect(result).toBe('File');
        expect(withoutFile).toBe('Blob');
      });
    });
  });

  describe('Given no mailmap source at all', () => {
    describe('When the mailmap is read', () => {
      it('Then the index is empty', async () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        const result = await readMailmap(ctx);

        // Assert
        expect(result.size).toBe(0);
      });
    });
  });
});
