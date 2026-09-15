import { afterEach, describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import { tagCreate, tagDelete, tagList } from '../../../../src/application/commands/tag.js';
import {
  __resetConfigCacheForTests,
  invalidateConfigCache,
} from '../../../../src/application/primitives/config-read.js';
import { readObject } from '../../../../src/application/primitives/read-object.js';
import { getRefStore, refExists } from '../../../../src/application/primitives/ref-store.js';
import { readReflog } from '../../../../src/application/primitives/reflog-store.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { writeSymbolicRef } from '../../../../src/application/primitives/write-symbolic-ref.js';
import { writeTree } from '../../../../src/application/primitives/write-tree.js';
import { TsgitError } from '../../../../src/domain/index.js';
import { FILE_MODE } from '../../../../src/domain/objects/file-mode.js';
import type {
  AuthorIdentity,
  ObjectId,
  RefName,
  TagData,
} from '../../../../src/domain/objects/index.js';
import { treeEntry } from '../../../../src/domain/objects/tree.js';
import type { Context } from '../../../../src/ports/context.js';
import { stubCommandRunner } from '../primitives/helpers/stub-command-runner.js';

const author: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

const seedWithCommit = async () => {
  const ctx = createMemoryContext();
  await init(ctx);
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
  await add(ctx, ['a.txt']);
  const c = await commit(ctx, { message: 'first', author });
  return { ctx, commitId: c.id };
};

/** A repository with a commit AND a configured `[user]` — the tagger source for annotated tags. */
const seedWithConfiguredUser = async () => {
  const seeded = await seedWithCommit();
  await seeded.ctx.fs.writeUtf8(
    `${seeded.ctx.layout.gitDir}/config`,
    '[user]\n  name = Grace\n  email = grace@example.com\n',
  );
  __resetConfigCacheForTests();
  return seeded;
};

describe('tag', () => {
  describe('Given a fresh tag', () => {
    describe('When tag create', () => {
      it('Then refs/tags/<name> exists', async () => {
        // Arrange
        const { ctx, commitId } = await seedWithCommit();

        // Act
        const result = await tagCreate(ctx, { name: 'v1.0' });

        // Assert
        expect(result.id).toBe(commitId);
      });
    });
  });

  describe('Given a SHA-256 repository and an explicit target (64-hex oid)', () => {
    describe('When tag create', () => {
      it('Then the new tag points at that oid, taken verbatim', async () => {
        // Arrange
        const ctx = createMemoryContext({ algorithm: 'sha256' });
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
        await add(ctx, ['a.txt']);
        const { id: commitId } = await commit(ctx, { message: 'first', author });
        expect(commitId).toHaveLength(64);

        // Act
        const result = await tagCreate(ctx, { name: 'v1.0', target: commitId });

        // Assert
        expect(result.id).toBe(commitId);
      });
    });
  });

  describe('Given an existing tag', () => {
    describe('When tag create without force', () => {
      it('Then throws TAG_EXISTS', async () => {
        // Arrange
        const { ctx } = await seedWithCommit();
        await tagCreate(ctx, { name: 'v1.0' });

        // Act
        let caught: unknown;
        try {
          await tagCreate(ctx, { name: 'v1.0' });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('TAG_EXISTS');
      });
    });

    describe('When tag create without force, and the (new) target is a missing full oid', () => {
      it('Then it still throws TAG_EXISTS — the name is reported before the target', async () => {
        // Arrange — this is the row that would fail without the explicit
        // pre-check: `updateRef` now verifies its target before its own
        // compare-and-swap, so a missing target would otherwise surface
        // OBJECT_NOT_FOUND instead of TAG_EXISTS.
        const { ctx } = await seedWithCommit();
        await tagCreate(ctx, { name: 'v1.0' });
        const missing = 'f'.repeat(40) as ObjectId;

        // Act
        let caught: unknown;
        try {
          await tagCreate(ctx, { name: 'v1.0', target: missing });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('TAG_EXISTS');
      });
    });

    describe('When tag create --annotate without force, and the target is a missing full oid', () => {
      it('Then it still throws TAG_EXISTS', async () => {
        // Arrange
        const { ctx } = await seedWithConfiguredUser();
        await tagCreate(ctx, { name: 'v1.0' });
        const missing = 'f'.repeat(40) as ObjectId;

        // Act
        let caught: unknown;
        try {
          await tagCreate(ctx, { name: 'v1.0', target: missing, message: 'x' });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('TAG_EXISTS');
      });
    });
  });

  describe('Given refs/tags/dx is a symbolic ref to an absent refs/tags/nope', () => {
    describe('When a lightweight tag dx is created without force', () => {
      it('Then the tag is written through the dangling symref, which stays symbolic', async () => {
        // Arrange
        const { ctx, commitId } = await seedWithCommit();
        await writeSymbolicRef(ctx, 'refs/tags/dx' as RefName, 'refs/tags/nope' as RefName);
        const sut = tagCreate;

        // Act
        const result = await sut(ctx, { name: 'dx' });

        // Assert
        const store = getRefStore(ctx);
        expect(result).toEqual({ name: 'refs/tags/dx', id: commitId });
        expect(await store.resolveDirect('refs/tags/dx' as RefName)).toEqual({
          kind: 'symbolic',
          target: 'refs/tags/nope',
        });
        expect(await store.resolveDirect('refs/tags/nope' as RefName)).toEqual({
          kind: 'direct',
          id: commitId,
        });
      });
    });

    describe('When an annotated tag dx is created without force', () => {
      it('Then the tag object id is written through the dangling symref', async () => {
        // Arrange
        const { ctx } = await seedWithConfiguredUser();
        await writeSymbolicRef(ctx, 'refs/tags/dx' as RefName, 'refs/tags/nope' as RefName);
        const sut = tagCreate;

        // Act
        const result = await sut(ctx, { name: 'dx', message: 'm' });

        // Assert
        const store = getRefStore(ctx);
        expect((await readObject(ctx, result.id)).type).toBe('tag');
        expect(await store.resolveDirect('refs/tags/dx' as RefName)).toEqual({
          kind: 'symbolic',
          target: 'refs/tags/nope',
        });
        expect(await store.resolveDirect('refs/tags/nope' as RefName)).toEqual({
          kind: 'direct',
          id: result.id,
        });
      });
    });
  });

  describe('Given refs/tags/sz is a symbolic ref to an existing refs/tags/dz', () => {
    describe('When a tag sz is created without force', () => {
      it('Then it refuses TAG_EXISTS naming sz and leaves both refs unchanged', async () => {
        // Arrange
        const { ctx, commitId } = await seedWithCommit();
        await tagCreate(ctx, { name: 'dz' });
        await writeSymbolicRef(ctx, 'refs/tags/sz' as RefName, 'refs/tags/dz' as RefName);
        const sut = tagCreate;

        // Act
        let caught: unknown;
        try {
          await sut(ctx, { name: 'sz' });
        } catch (err) {
          caught = err;
        }

        // Assert
        const store = getRefStore(ctx);
        expect((caught as TsgitError).data).toEqual({ code: 'TAG_EXISTS', name: 'refs/tags/sz' });
        expect(await store.resolveDirect('refs/tags/sz' as RefName)).toEqual({
          kind: 'symbolic',
          target: 'refs/tags/dz',
        });
        expect(await store.resolveDirect('refs/tags/dz' as RefName)).toEqual({
          kind: 'direct',
          id: commitId,
        });
      });
    });
  });

  describe('Given a missing full-oid target', () => {
    describe('When tag create', () => {
      it('Then it throws OBJECT_NOT_FOUND and writes no ref', async () => {
        // Arrange
        const { ctx } = await seedWithCommit();
        const missing = 'f'.repeat(40) as ObjectId;

        // Act
        let caught: unknown;
        try {
          await tagCreate(ctx, { name: 'v1.0', target: missing });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data;
        expect(data.code).toBe('OBJECT_NOT_FOUND');
        if (data.code === 'OBJECT_NOT_FOUND') expect(data.id).toBe(missing);
        expect(await refExists(ctx, 'refs/tags/v1.0' as RefName)).toBe(false);
      });
    });
  });

  describe('Given a tree, a blob and an annotated tag object as targets', () => {
    describe('When tag create runs for each', () => {
      it('Then every existing type is written', async () => {
        // Arrange
        const { ctx, commitId } = await seedWithCommit();
        const blobId = await writeObject(ctx, {
          type: 'blob',
          content: new TextEncoder().encode('blob content'),
          id: '' as ObjectId,
        });
        const treeId = await writeTree(ctx, [treeEntry(FILE_MODE.REGULAR, 'f.txt', blobId)]);
        const tagData: TagData = {
          object: commitId,
          objectType: 'commit',
          tagName: 'inner',
          tagger: author,
          message: 'inner\n',
          extraHeaders: [],
        };
        const tagObjectId = await writeObject(ctx, {
          type: 'tag',
          id: '' as ObjectId,
          data: tagData,
        });

        // Act
        const tree = await tagCreate(ctx, { name: 'to-tree', target: treeId });
        const blob = await tagCreate(ctx, { name: 'to-blob', target: blobId });
        const tagObj = await tagCreate(ctx, { name: 'to-tag', target: tagObjectId });

        // Assert
        expect(tree.id).toBe(treeId);
        expect(blob.id).toBe(blobId);
        expect(tagObj.id).toBe(tagObjectId);
      });
    });
  });

  describe('Given a tag', () => {
    describe('When tag delete', () => {
      it('Then ref is removed', async () => {
        // Arrange
        const { ctx } = await seedWithCommit();
        await tagCreate(ctx, { name: 'v1.0' });

        // Act
        await tagDelete(ctx, { name: 'v1.0' });

        // Assert
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/refs/tags/v1.0`)).toBe(false);
      });
    });
  });

  describe('Given a symbolic tag name pointing at another tag', () => {
    describe('When tag delete runs', () => {
      it('Then the symbolic ref itself is deleted and its target is kept, --no-deref', async () => {
        // Arrange
        const { ctx } = await seedWithCommit();
        await tagCreate(ctx, { name: 'tt' });
        await writeSymbolicRef(ctx, 'refs/tags/ts' as RefName, 'refs/tags/tt' as RefName);

        // Act
        const result = await tagDelete(ctx, { name: 'ts' });

        // Assert
        expect(result).toEqual({ name: 'refs/tags/ts' });
        expect(await getRefStore(ctx).resolveDirect('refs/tags/ts' as RefName)).toEqual({
          kind: 'missing',
        });
        expect(await refExists(ctx, 'refs/tags/tt' as RefName)).toBe(true);
      });
    });
  });

  describe('Given a non-existent tag', () => {
    describe('When tag delete', () => {
      it('Then throws TAG_NOT_FOUND', async () => {
        // Arrange
        const { ctx } = await seedWithCommit();

        // Act
        let caught: unknown;
        try {
          await tagDelete(ctx, { name: 'ghost' });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('TAG_NOT_FOUND');
      });
    });
  });

  describe('Given a malformed core.maxTreeDepth', () => {
    describe('When tag create targets an unresolvable name', () => {
      it('Then it throws REF_NOT_FOUND — the target reports before the class', async () => {
        // Arrange
        const { ctx } = await seedWithCommit();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[core]\n\tmaxTreeDepth = 2.5\n');
        invalidateConfigCache(ctx);

        // Act
        let caught: unknown;
        try {
          await tagCreate(ctx, { name: 'v2', target: 'nope-unresolved' });
        } catch (err) {
          caught = err;
        }

        // Assert — the unresolvable target reports FIRST, without the class,
        // and names the target that failed rather than the tag being created.
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data as {
          readonly code: string;
          readonly name: string;
        };
        expect(data.code).toBe('REF_NOT_FOUND');
        expect(data.name).toBe('nope-unresolved');
      });
    });

    describe('When tag create targets a resolvable object', () => {
      it('Then it throws CONFIG_BAD_NUMERIC_VALUE once the target types', async () => {
        // Arrange
        const { ctx, commitId } = await seedWithCommit();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[core]\n\tmaxTreeDepth = 2.5\n');
        invalidateConfigCache(ctx);

        // Act
        let caught: unknown;
        try {
          await tagCreate(ctx, { name: 'v2', target: commitId });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('CONFIG_BAD_NUMERIC_VALUE');
      });
    });

    describe('When tag delete runs on a nonexistent tag', () => {
      it('Then it throws TAG_NOT_FOUND, not the class — "not found" reports first', async () => {
        // Arrange
        const { ctx } = await seedWithCommit();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[core]\n\tmaxTreeDepth = 2.5\n');
        invalidateConfigCache(ctx);

        // Act
        let caught: unknown;
        try {
          await tagDelete(ctx, { name: 'ghost' });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('TAG_NOT_FOUND');
      });
    });

    describe('When tag delete runs on an existing tag', () => {
      it('Then it throws CONFIG_BAD_NUMERIC_VALUE, after the refExists check', async () => {
        // Arrange
        const { ctx } = await seedWithCommit();
        await tagCreate(ctx, { name: 'v1.0' });
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[core]\n\tmaxTreeDepth = 2.5\n');
        invalidateConfigCache(ctx);

        // Act
        let caught: unknown;
        try {
          await tagDelete(ctx, { name: 'v1.0' });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('CONFIG_BAD_NUMERIC_VALUE');
      });
    });

    describe('When tag list runs', () => {
      it('Then it still runs — git lists tags without parsing an object', async () => {
        // Arrange
        const { ctx } = await seedWithCommit();
        await tagCreate(ctx, { name: 'v1.0' });
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[core]\n\tmaxTreeDepth = 2.5\n');
        invalidateConfigCache(ctx);

        // Act
        const result = await tagList(ctx);

        // Assert
        expect(result.tags.map((t) => t.name)).toContain('refs/tags/v1.0');
      });
    });
  });

  describe('Given an explicit target oid', () => {
    describe('When tag create', () => {
      it('Then the tag points at that oid (not HEAD)', async () => {
        // Arrange
        const { ctx, commitId } = await seedWithCommit();

        // Act
        const result = await tagCreate(ctx, { name: 'pin', target: commitId });

        // Assert
        expect(result.id).toBe(commitId);
      });
    });
  });

  describe('Given an explicit target as a ref name', () => {
    describe('When tag create', () => {
      it('Then resolves it via resolveRef', async () => {
        // Arrange
        const { ctx, commitId } = await seedWithCommit();

        // Act
        const result = await tagCreate(ctx, { name: 'pin', target: 'refs/heads/main' });

        // Assert
        expect(result.id).toBe(commitId);
      });
    });
  });

  describe('Given force=true on an existing tag', () => {
    describe('When tag create', () => {
      it('Then the second create overwrites the ref (commit oid is unchanged)', async () => {
        // Arrange — seed a commit and tag it once.
        const { ctx } = await seedWithCommit();
        const first = await tagCreate(ctx, { name: 'v1.0' });

        // Act — second create with force MUST NOT throw and MUST end pointing
        // at the same commit oid (no rewrite of the underlying ref target).
        const result = await tagCreate(ctx, { name: 'v1.0', force: true });

        // Assert — the fields that prove the ref was rewritten in place
        // (full name + same oid).
        expect(result.name).toBe('refs/tags/v1.0');
        expect(result.id).toBe(first.id);
      });
    });

    describe('When tag create with force=true, and the (new) target is a missing full oid', () => {
      it('Then it throws OBJECT_NOT_FOUND — force bypasses the exists check, not verification', async () => {
        // Arrange
        const { ctx } = await seedWithCommit();
        await tagCreate(ctx, { name: 'v1.0' });
        const missing = 'f'.repeat(40) as ObjectId;

        // Act
        let caught: unknown;
        try {
          await tagCreate(ctx, { name: 'v1.0', target: missing, force: true });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data;
        expect(data.code).toBe('OBJECT_NOT_FOUND');
        if (data.code === 'OBJECT_NOT_FOUND') expect(data.id).toBe(missing);
      });
    });
  });

  describe('Given a repo with tags to list', () => {
    describe('When tag list runs', () => {
      // Each row isolates one facet of listing: basic sort, the empty case, a
      // directory entry sharing the refs/tags namespace, and — with 3 unsorted
      // tags — a comparator boundary that 2 tags cannot rule out (an
      // always-(-1)/always-(1) comparator could still pass with only 2 items).
      it.each([
        {
          label: 'two tags created out of insertion order are returned sorted',
          build: async (): Promise<Context> => {
            const { ctx } = await seedWithCommit();
            await tagCreate(ctx, { name: 'v2.0' });
            await tagCreate(ctx, { name: 'v1.0' });
            return ctx;
          },
          expectedNames: ['refs/tags/v1.0', 'refs/tags/v2.0'],
        },
        {
          label: 'a fresh repo with no tags returns an empty array',
          build: async (): Promise<Context> => {
            const ctx = createMemoryContext();
            await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
            return ctx;
          },
          expectedNames: [],
        },
        {
          label: 'a directory entry inside refs/tags is skipped, not resolved as a ref',
          build: async (): Promise<Context> => {
            const { ctx } = await seedWithCommit();
            await tagCreate(ctx, { name: 'v1.0' });
            await ctx.fs.mkdir(`${ctx.layout.gitDir}/refs/tags/group`);
            return ctx;
          },
          expectedNames: ['refs/tags/v1.0'],
        },
        {
          label: 'a packed-only tag appears alongside a loose one',
          build: async (): Promise<Context> => {
            const { ctx, commitId } = await seedWithCommit();
            await tagCreate(ctx, { name: 'v1.0' });
            await ctx.fs.writeUtf8(
              `${ctx.layout.gitDir}/packed-refs`,
              `# pack-refs with: peeled fully-peeled sorted\n${commitId} refs/tags/packed\n`,
            );
            return ctx;
          },
          expectedNames: ['refs/tags/packed', 'refs/tags/v1.0'],
        },
        {
          label: 'three tags created out of order are returned in strict ascending order',
          build: async (): Promise<Context> => {
            const { ctx } = await seedWithCommit();
            await tagCreate(ctx, { name: 'v3.0' });
            await tagCreate(ctx, { name: 'v1.0' });
            await tagCreate(ctx, { name: 'v2.0' });
            return ctx;
          },
          expectedNames: ['refs/tags/v1.0', 'refs/tags/v2.0', 'refs/tags/v3.0'],
        },
      ])('Then $label', async ({ build, expectedNames }) => {
        // Arrange
        const ctx = await build();

        // Act
        const result = await tagList(ctx);

        // Assert
        expect(result.tags.map((t) => t.name)).toEqual(expectedNames);
      });
    });
  });

  describe('Given a target ending in 40 hex but prefixed by a non-hex char', () => {
    describe('When tag create', () => {
      it('Then treated as a ref name and throws REF_NOT_FOUND', async () => {
        // Arrange — 'z' + 40 hex: NOT a full-oid (anchored regex requires ^), so it
        // must be resolved as a ref name and fail because no such ref exists.
        const { ctx } = await seedWithCommit();
        const target = `z${'a'.repeat(40)}`;

        // Act
        let caught: unknown;
        try {
          await tagCreate(ctx, { name: 'pin', target });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('REF_NOT_FOUND');
      });
    });
  });

  describe('Given a target starting with 40 hex but with a trailing extra char', () => {
    describe('When tag create', () => {
      it('Then treated as a ref name and throws REF_NOT_FOUND', async () => {
        // Arrange — 40 hex + 'z': NOT a full-oid (anchored regex requires $), so it
        // must be resolved as a ref name and fail because no such ref exists.
        const { ctx } = await seedWithCommit();
        const target = `${'a'.repeat(40)}z`;

        // Act
        let caught: unknown;
        try {
          await tagCreate(ctx, { name: 'pin', target });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('REF_NOT_FOUND');
      });
    });
  });

  describe('Given updateRef throws a non-conflict TsgitError', () => {
    describe('When tag create', () => {
      it('Then that error propagates unchanged (not converted to TAG_EXISTS)', async () => {
        // Arrange — a stale lock file makes the exclusive ref write throw REF_LOCKED.
        const { ctx } = await seedWithCommit();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/tags/locked.lock`, 'stale');

        // Act
        let caught: unknown;
        try {
          await tagCreate(ctx, { name: 'locked' });
        } catch (err) {
          caught = err;
        }

        // Assert — only REF_UPDATE_CONFLICT becomes TAG_EXISTS; REF_LOCKED is rethrown verbatim.
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('REF_LOCKED');
      });
    });
  });

  describe('Given core.logAllRefUpdates=always', () => {
    describe('When tag create', () => {
      it('Then the reflog entry message is "tag: <name>"', async () => {
        // Arrange — `always` makes even tag refs loggable, exposing the reflog
        // message tag writes. The message must name the tag, not be empty.
        const { ctx } = await seedWithCommit();
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/config`,
          '[core]\n  logallrefupdates = always\n',
        );
        __resetConfigCacheForTests();

        // Act
        await tagCreate(ctx, { name: 'v1.0' });

        // Assert
        const entries = await readReflog(ctx, 'refs/tags/v1.0' as RefName);
        expect(entries.map((e) => e.message)).toEqual(['tag: v1.0']);
        __resetConfigCacheForTests();
      });
    });
  });

  describe('Given updateRef throws a non-TsgitError', () => {
    describe('When tag create', () => {
      it('Then that error propagates unchanged', async () => {
        // Arrange — wrap fs so the ref rename throws a plain Error inside updateRef.
        const { ctx } = await seedWithCommit();
        const renameFailure = new Error('rename exploded');
        const failingCtx = {
          ...ctx,
          fs: {
            ...ctx.fs,
            rename: async (): Promise<void> => {
              throw renameFailure;
            },
          },
        };

        // Act
        let caught: unknown;
        try {
          await tagCreate(failingCtx, { name: 'v9.9' });
        } catch (err) {
          caught = err;
        }

        // Assert — the plain Error is rethrown as-is, never dereferenced for `.data.code`.
        expect(caught).toBe(renameFailure);
      });
    });
  });

  describe('Given a configured user, annotate true, and a message', () => {
    describe('When tag create', () => {
      it('Then refs/tags/<name> points at a written tag object, not the commit', async () => {
        // Arrange
        const { ctx, commitId } = await seedWithConfiguredUser();

        // Act
        const result = await tagCreate(ctx, { name: 'v1.0', annotate: true, message: 'v1' });

        // Assert
        expect(result.id).not.toBe(commitId);
        const obj = await readObject(ctx, result.id);
        expect(obj.type).toBe('tag');
      });
    });
  });

  describe('Given a configured user and a message, with annotate left unset', () => {
    describe('When tag create', () => {
      it('Then it is annotated — message implies -a', async () => {
        // Arrange
        const { ctx, commitId } = await seedWithConfiguredUser();

        // Act
        const result = await tagCreate(ctx, { name: 'v1.0', message: 'v1' });

        // Assert
        expect(result.id).not.toBe(commitId);
        const obj = await readObject(ctx, result.id);
        expect(obj.type).toBe('tag');
      });
    });
  });

  describe('Given a configured user, annotate true, but neither message nor sign', () => {
    describe('When tag create', () => {
      it('Then it writes an annotated tag object carrying an empty message', async () => {
        // Arrange
        const { ctx, commitId } = await seedWithConfiguredUser();

        // Act
        const result = await tagCreate(ctx, { name: 'v1.0', annotate: true });

        // Assert — annotate alone (no message, no sign) must still peel off a tag
        // object, and its message must be empty rather than any placeholder text.
        expect(result.id).not.toBe(commitId);
        const obj = await readObject(ctx, result.id);
        expect(obj.type).toBe('tag');
        if (obj.type !== 'tag') throw new Error('expected a tag object');
        expect(obj.data.message).toBe('');
      });
    });
  });

  describe('Given neither annotate nor message', () => {
    describe('When tag create', () => {
      it('Then it stays lightweight — the ref points at the target OID with no tag object written', async () => {
        // Arrange
        const { ctx, commitId } = await seedWithCommit();

        // Act
        const result = await tagCreate(ctx, { name: 'v1.0' });

        // Assert
        expect(result.id).toBe(commitId);
        const obj = await readObject(ctx, result.id);
        expect(obj.type).toBe('commit');
      });
    });
  });

  describe('Given annotate true but no configured user', () => {
    describe('When tag create', () => {
      it('Then it throws the author-unconfigured refusal', async () => {
        // Arrange
        const { ctx } = await seedWithCommit();

        // Act
        let caught: unknown;
        try {
          await tagCreate(ctx, { name: 'v1.0', annotate: true, message: 'v1' });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('AUTHOR_UNCONFIGURED');
      });
    });
  });

  describe('Given an existing tag and a configured user', () => {
    describe('When annotated tag create without force', () => {
      it('Then it throws TAG_EXISTS', async () => {
        // Arrange
        const { ctx } = await seedWithConfiguredUser();
        await tagCreate(ctx, { name: 'v1.0' });

        // Act
        let caught: unknown;
        try {
          await tagCreate(ctx, { name: 'v1.0', annotate: true, message: 'v1' });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('TAG_EXISTS');
      });
    });
  });
});

describe('tag — signing', () => {
  const armor = () =>
    '-----BEGIN PGP SIGNATURE-----\n\nZmFrZXNpZw==\n-----END PGP SIGNATURE-----\n';

  /** A repository with a commit and a configured `[user]` (the tagger source), plus optional extra config. */
  const seedSigning = async (
    command?: ReturnType<typeof stubCommandRunner>,
    configText?: string,
  ): Promise<Context> => {
    const ctx = createMemoryContext(command !== undefined ? { command } : {});
    await init(ctx);
    await ctx.fs.writeUtf8(
      `${ctx.layout.gitDir}/config`,
      `[user]\n  name = Grace\n  email = grace@example.com\n${configText ?? ''}`,
    );
    __resetConfigCacheForTests();
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
    await add(ctx, ['a.txt']);
    await commit(ctx, { message: 'first', author });
    return ctx;
  };

  const tagRefPath = (ctx: Context, name: string): string =>
    `${ctx.layout.gitDir}/refs/tags/${name}`;

  afterEach(() => __resetConfigCacheForTests());

  describe('Given opts.sign is true and the signer succeeds', () => {
    describe('When tag create with a message', () => {
      it('Then the tag body ends with the returned armor unmodified — no trailing-newline trim (unlike commits)', async () => {
        // Arrange
        const runner = stubCommandRunner({ stdout: new TextEncoder().encode(armor()) });
        const ctx = await seedSigning(runner);

        // Act
        const result = await tagCreate(ctx, { name: 'v1.0', message: 'v1', sign: true });

        // Assert
        const stored = await readObject(ctx, result.id);
        if (stored.type !== 'tag') throw new Error('expected a tag object');
        expect(stored.data.gpgSignature).toBe(armor());
      });
    });
  });

  describe('Given opts.sign is true with no message or annotate', () => {
    describe('When tag create', () => {
      it('Then it still creates a signed annotated tag object — sign implies annotate', async () => {
        // Arrange
        const runner = stubCommandRunner({ stdout: new TextEncoder().encode(armor()) });
        const ctx = await seedSigning(runner);

        // Act
        const result = await tagCreate(ctx, { name: 'v1.0', sign: true });

        // Assert
        const stored = await readObject(ctx, result.id);
        expect(stored.type).toBe('tag');
        if (stored.type !== 'tag') throw new Error('expected a tag object');
        expect(stored.data.gpgSignature).toBe(armor());
      });
    });
  });

  describe('Given opts.sign is true', () => {
    describe('When tag create signs', () => {
      it('Then the signer receives the unsigned tag payload on stdin with no gpgsig header', async () => {
        // Arrange
        const runner = stubCommandRunner({ stdout: new TextEncoder().encode(armor()) });
        const ctx = await seedSigning(runner);

        // Act
        await tagCreate(ctx, { name: 'v1.0', message: 'payload check', sign: true });

        // Assert
        expect(runner.calls).toHaveLength(1);
        const stdin = new TextDecoder().decode(runner.calls[0]?.stdin);
        expect(stdin).toContain('payload check');
        expect(stdin).not.toContain('gpgsig');
      });
    });
  });

  describe('Given tag.gpgSign=true in config and opts.sign is undefined', () => {
    describe('When tag create with a message', () => {
      it('Then it signs — the config default applies', async () => {
        // Arrange
        const runner = stubCommandRunner({ stdout: new TextEncoder().encode(armor()) });
        const ctx = await seedSigning(runner, '[tag]\n  gpgSign = true\n');

        // Act
        const result = await tagCreate(ctx, { name: 'v1.0', message: 'v1' });

        // Assert
        const stored = await readObject(ctx, result.id);
        if (stored.type !== 'tag') throw new Error('expected a tag object');
        expect(stored.data.gpgSignature).toBe(armor());
      });
    });
  });

  describe('Given tag.gpgSign=true in config and opts.sign is explicitly false', () => {
    describe('When tag create with a message', () => {
      it('Then it does not sign — the explicit false overrides the config default', async () => {
        // Arrange
        const runner = stubCommandRunner({ stdout: new TextEncoder().encode(armor()) });
        const ctx = await seedSigning(runner, '[tag]\n  gpgSign = true\n');

        // Act
        const result = await tagCreate(ctx, { name: 'v1.0', message: 'v1', sign: false });

        // Assert
        expect(runner.calls).toHaveLength(0);
        const stored = await readObject(ctx, result.id);
        if (stored.type !== 'tag') throw new Error('expected a tag object');
        expect(stored.data.gpgSignature).toBeUndefined();
      });
    });
  });

  describe('Given tag.gpgSign=true in config but neither annotate, message, nor sign is requested', () => {
    describe('When tag create', () => {
      it('Then the tag stays lightweight and unsigned — tag.gpgSign only signs an already-annotated tag', async () => {
        // Arrange
        const runner = stubCommandRunner({ stdout: new TextEncoder().encode(armor()) });
        const ctx = await seedSigning(runner, '[tag]\n  gpgSign = true\n');

        // Act
        const result = await tagCreate(ctx, { name: 'v1.0' });

        // Assert
        expect(runner.calls).toHaveLength(0);
        const stored = await readObject(ctx, result.id);
        expect(stored.type).toBe('commit');
      });
    });
  });

  describe('Given tag.gpgSign holds a value git refuses', () => {
    describe('When tag create is called for a LIGHTWEIGHT tag (no annotate/message/sign)', () => {
      it('Then it still throws CONFIG_BAD_BOOLEAN_VALUE — git reads tag.gpgsign for lightweight tags too', async () => {
        // Arrange
        const ctx = await seedSigning(undefined, '[tag]\n  gpgSign = maybe\n');

        // Act
        let caught: unknown;
        try {
          await tagCreate(ctx, { name: 'v1.0' });
        } catch (err) {
          caught = err;
        }

        // Assert — each field individually (mutation-resistant)
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data as {
          code: string;
          key: string;
          value: string;
          source: string;
        };
        expect(data.code).toBe('CONFIG_BAD_BOOLEAN_VALUE');
        expect(data.key).toBe('tag.gpgsign');
        expect(data.value).toBe('maybe');
        expect(data.source).toMatch(/\/config$/);
        expect(await ctx.fs.exists(tagRefPath(ctx, 'v1.0'))).toBe(false);
      });
    });

    describe('When tag create is called for an ANNOTATED tag', () => {
      it('Then it throws CONFIG_BAD_BOOLEAN_VALUE and writes no tag object or ref', async () => {
        // Arrange
        const ctx = await seedSigning(undefined, '[tag]\n  gpgSign = maybe\n');

        // Act
        let caught: unknown;
        try {
          await tagCreate(ctx, { name: 'v1.0', message: 'v1' });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('CONFIG_BAD_BOOLEAN_VALUE');
        expect(await ctx.fs.exists(tagRefPath(ctx, 'v1.0'))).toBe(false);
      });
    });

    describe('When tag create targets a ref that does not exist', () => {
      it('Then the boolean refusal precedes the ref error — git dies before resolving the target', async () => {
        // Arrange
        const ctx = await seedSigning(undefined, '[tag]\n  gpgSign = maybe\n');

        // Act
        let caught: unknown;
        try {
          await tagCreate(ctx, { name: 'v1.0', target: 'refs/heads/missing' });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data as { code: string; key: string };
        expect(data.code).toBe('CONFIG_BAD_BOOLEAN_VALUE');
        expect(data.key).toBe('tag.gpgsign');
      });
    });
  });

  describe('Given tag.gpgSign=yes (word form) in config', () => {
    describe('When tag create with a message', () => {
      it('Then it signs — the guard no-ops on an accepted value', async () => {
        // Arrange
        const runner = stubCommandRunner({ stdout: new TextEncoder().encode(armor()) });
        const ctx = await seedSigning(runner, '[tag]\n  gpgSign = yes\n');

        // Act
        const result = await tagCreate(ctx, { name: 'v1.0', message: 'v1' });

        // Assert
        const stored = await readObject(ctx, result.id);
        if (stored.type !== 'tag') throw new Error('expected a tag object');
        expect(stored.data.gpgSignature).toBe(armor());
      });
    });
  });

  describe('Given opts.signKey overrides a configured user.signingKey', () => {
    describe('When tag create signs', () => {
      it('Then the signer invocation uses the override key, not the configured one', async () => {
        // Arrange
        const runner = stubCommandRunner({ stdout: new TextEncoder().encode(armor()) });
        const ctx = await seedSigning(runner, '[user]\n  signingKey = DEFAULTKEY\n');

        // Act
        await tagCreate(ctx, { name: 'v1.0', message: 'v1', sign: true, signKey: 'OVERRIDEKEY' });

        // Assert
        const invoked = runner.calls[0]?.command ?? '';
        expect(invoked).toContain('OVERRIDEKEY');
        expect(invoked).not.toContain('DEFAULTKEY');
      });
    });
  });

  describe('Given the signer exits non-zero', () => {
    describe('When tag create is called with sign: true', () => {
      it('Then it throws SIGNING_FAILED with reason signer-failed and writes no ref', async () => {
        // Arrange
        const runner = stubCommandRunner({ exitCode: 1 });
        const ctx = await seedSigning(runner);

        // Act
        let caught: unknown;
        try {
          await tagCreate(ctx, { name: 'v1.0', message: 'v1', sign: true });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const error = caught as TsgitError;
        expect(error.data).toEqual({
          code: 'SIGNING_FAILED',
          reason: 'signer-failed',
          format: 'openpgp',
        });
        expect(await ctx.fs.exists(tagRefPath(ctx, 'v1.0'))).toBe(false);
      });
    });
  });

  describe('Given a context with no CommandRunner (off-node)', () => {
    describe('When tag create is called with sign: true', () => {
      it('Then it throws SIGNING_FAILED with reason off-node and writes no ref', async () => {
        // Arrange
        const ctx = await seedSigning(undefined);

        // Act
        let caught: unknown;
        try {
          await tagCreate(ctx, { name: 'v1.0', message: 'v1', sign: true });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const error = caught as TsgitError;
        expect(error.data).toEqual({ code: 'SIGNING_FAILED', reason: 'off-node' });
        expect(await ctx.fs.exists(tagRefPath(ctx, 'v1.0'))).toBe(false);
      });
    });
  });
});
