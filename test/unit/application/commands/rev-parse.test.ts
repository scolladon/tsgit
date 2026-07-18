import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { revParse } from '../../../../src/application/commands/rev-parse.js';
import { writeReflog } from '../../../../src/application/primitives/reflog-store.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import type { GitIndex, IndexEntry } from '../../../../src/domain/git-index/index.js';
import { STAGE0_FLAGS, serializeIndex } from '../../../../src/domain/git-index/index.js';
import { TsgitError } from '../../../../src/domain/index.js';
import { hexToBytes } from '../../../../src/domain/objects/encoding.js';
import { FILE_MODE } from '../../../../src/domain/objects/file-mode.js';
import type { AuthorIdentity, CommitData, ObjectId } from '../../../../src/domain/objects/index.js';
import { ZERO_OID } from '../../../../src/domain/objects/index.js';
import type { FilePath, RefName } from '../../../../src/domain/objects/object-id.js';
import type { ReflogEntry } from '../../../../src/domain/reflog/index.js';
import type { Context } from '../../../../src/ports/context.js';
import { seedRepo } from './fixtures.js';

const TREE_OID = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

const AUTHOR = {
  name: 'Test',
  email: 'test@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
} as const;

const writeBlob = (ctx: Context, text: string): Promise<ObjectId> =>
  writeObject(ctx, {
    type: 'blob',
    id: '' as ObjectId,
    content: new TextEncoder().encode(text),
  });

const writeCommit = (
  ctx: Context,
  tree: ObjectId,
  parents: ReadonlyArray<ObjectId>,
): Promise<ObjectId> => {
  const data: CommitData = {
    tree,
    parents: [...parents],
    author: AUTHOR,
    committer: AUTHOR,
    message: 'c',
    extraHeaders: [],
  };
  return writeObject(ctx, { type: 'commit', id: '' as ObjectId, data });
};

const writeTag = (
  ctx: Context,
  target: ObjectId,
  targetType: 'commit' | 'tag',
): Promise<ObjectId> =>
  writeObject(ctx, {
    type: 'tag',
    id: '' as ObjectId,
    data: {
      object: target,
      objectType: targetType,
      tagName: 'v1',
      message: 'tag',
      extraHeaders: [],
    },
  });

/** Write a fully-framed `.git/index` (body + hash trailer) with the given entries. */
const writeIndexFile = async (
  ctx: Context,
  entries: ReadonlyArray<{ path: string; id: ObjectId; stage: 0 | 1 | 2 | 3 }>,
): Promise<void> => {
  const fullEntries: IndexEntry[] = entries.map((e) => ({
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
    id: e.id,
    flags: { ...STAGE0_FLAGS, stage: e.stage },
    path: e.path as FilePath,
  }));
  const index: GitIndex = {
    version: 2,
    entries: fullEntries,
    extensions: [],
    trailerSha: new Uint8Array(0),
  };
  const body = serializeIndex(index);
  const trailer = hexToBytes(await ctx.hash.hashHex(body));
  const framed = new Uint8Array(body.length + trailer.length);
  framed.set(body);
  framed.set(trailer, body.length);
  await ctx.fs.write(`${ctx.layout.gitDir}/index`, framed);
};

describe('revParse', () => {
  describe('Given a non-repo ctx', () => {
    describe('When revParse(HEAD)', () => {
      it('Then throws NOT_A_REPOSITORY', async () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        let caught: unknown;
        try {
          await revParse(ctx, 'HEAD');
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('NOT_A_REPOSITORY');
      });
    });
  });

  describe('Given a repo with HEAD pointing to a commit ref', () => {
    describe('When revParse(HEAD)', () => {
      it('Then returns the commit oid', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const { commitIds } = await seedRepo(ctx, {
          commits: [{ tree: TREE_OID, message: 'first' }],
        });
        const commitId = commitIds[0] as string;
        await seedRepo(ctx, { refs: { 'refs/heads/main': commitId } });

        // Act
        const sut = await revParse(ctx, 'HEAD');

        // Assert
        expect(sut).toBe(commitId);
      });
    });
  });

  describe('Given a 40-hex oid', () => {
    describe('When revParse', () => {
      it('Then returns it directly (no lookup)', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedRepo(ctx, {});
        const oid = '0123456789abcdef0123456789abcdef01234567';

        // Act
        const sut = await revParse(ctx, oid);

        // Assert
        expect(sut).toBe(oid);
      });
    });
  });

  describe('Given a 40-hex oid that also names a branch ref', () => {
    describe('When revParse', () => {
      it('Then returns the literal oid, not the ref target', async () => {
        // Arrange — git resolves a full 40-hex as the object itself; a colliding
        // ref is only a warning. The oid fast path must return the literal oid and
        // never fall through to resolve refs/heads/<oid> to a different commit.
        const ctx = createMemoryContext();
        const other = await writeCommit(ctx, TREE_OID as ObjectId, []);
        const oid = '0123456789abcdef0123456789abcdef01234567';
        await seedRepo(ctx, { refs: { [`refs/heads/${oid}`]: other } });

        // Act
        const sut = await revParse(ctx, oid);

        // Assert — the literal oid, not `other`.
        expect(sut).toBe(oid);
      });
    });
  });

  describe('Given an abbreviated oid matching a unique object', () => {
    describe('When revParse', () => {
      it('Then resolves it to the full object id', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedRepo(ctx, {});
        const oid = await writeBlob(ctx, 'abbrev-target');

        // Act
        const sut = await revParse(ctx, oid.slice(0, 7));

        // Assert
        expect(sut).toBe(oid);
      });
    });
  });

  describe('Given an abbreviated oid matching two objects', () => {
    describe('When revParse', () => {
      it('Then throws AMBIGUOUS_OID_PREFIX', async () => {
        // Arrange — two loose objects sharing prefix 'abcdef'
        const ctx = createMemoryContext();
        await seedRepo(ctx, {});
        for (const tail of ['0'.repeat(34), '1'.repeat(34)]) {
          await ctx.fs.write(`${ctx.layout.gitDir}/objects/ab/cdef${tail}`, new Uint8Array([1]));
        }

        // Act
        let caught: unknown;
        try {
          await revParse(ctx, 'abcdef');
        } catch (err) {
          caught = err;
        }

        // Assert
        expect((caught as TsgitError).data.code).toBe('AMBIGUOUS_OID_PREFIX');
      });
    });
  });

  describe('Given a 41-char string of 40 hex plus a trailing extra char', () => {
    describe('When revParse', () => {
      it('Then the hex regex rejects it (anchored end)', async () => {
        // Arrange — kills Regex `$`-drop: without `$`, /^[0-9a-f]{40}/ would match
        // the leading 40 hex and route into ObjectId.from (INVALID_OBJECT_ID).
        const ctx = createMemoryContext();
        await seedRepo(ctx, {});

        // Act
        let caught: unknown;
        try {
          await revParse(ctx, `${'0'.repeat(40)}a`);
        } catch (err) {
          caught = err;
        }

        // Assert — anchored regex misses, so it is treated as a ref name.
        expect((caught as TsgitError).data.code).toBe('OBJECT_NOT_FOUND');
      });
    });
  });

  describe('Given a 41-char string of a non-hex char plus 40 hex', () => {
    describe('When revParse', () => {
      it('Then the hex regex rejects it (anchored start)', async () => {
        // Arrange — kills Regex `^`-drop: without `^`, /[0-9a-f]{40}$/ would match
        // the trailing 40 hex and route into ObjectId.from (INVALID_OBJECT_ID).
        const ctx = createMemoryContext();
        await seedRepo(ctx, {});

        // Act
        let caught: unknown;
        try {
          await revParse(ctx, `g${'0'.repeat(40)}`);
        } catch (err) {
          caught = err;
        }

        // Assert — anchored regex misses, so it is treated as a ref name.
        expect((caught as TsgitError).data.code).toBe('OBJECT_NOT_FOUND');
      });
    });
  });

  describe('Given a malformed expression', () => {
    describe('When revParse', () => {
      it('Then throws REVPARSE_UNRESOLVED', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedRepo(ctx, {});

        // Act
        let caught: unknown;
        try {
          await revParse(ctx, 'HEAD~~');
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('REVPARSE_UNRESOLVED');
      });
    });
  });

  describe('Given a base resolvable only via refs/tags/', () => {
    describe('When revParse', () => {
      it('Then the tags candidate resolves it', async () => {
        // Arrange — kills the ArrayDeclaration mutant: an empty candidate list
        // would never try `refs/tags/release`.
        const ctx = createMemoryContext();
        const commit = await writeCommit(ctx, TREE_OID as ObjectId, []);
        await seedRepo(ctx, { refs: { 'refs/tags/release': commit } });

        // Act
        const sut = await revParse(ctx, 'release');

        // Assert
        expect(sut).toBe(commit);
      });
    });
  });

  describe('Given a base resolvable only via refs/remotes/', () => {
    describe('When revParse', () => {
      it('Then the remotes candidate resolves it', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const commit = await writeCommit(ctx, TREE_OID as ObjectId, []);
        await seedRepo(ctx, { refs: { 'refs/remotes/origin/main': commit } });

        // Act
        const sut = await revParse(ctx, 'origin/main');

        // Assert
        expect(sut).toBe(commit);
      });
    });
  });

  describe('Given a fully-qualified ref name', () => {
    describe('When revParse', () => {
      it('Then the verbatim candidate resolves it', async () => {
        // Arrange — exercises the first (verbatim `base`) candidate slot.
        const ctx = createMemoryContext();
        const commit = await writeCommit(ctx, TREE_OID as ObjectId, []);
        await seedRepo(ctx, { refs: { 'refs/heads/feature': commit } });

        // Act
        const sut = await revParse(ctx, 'refs/heads/feature');

        // Assert
        expect(sut).toBe(commit);
      });
    });
  });

  describe('Given an unresolvable base', () => {
    describe('When revParse', () => {
      it('Then throws OBJECT_NOT_FOUND with that base as id', async () => {
        // Arrange — every candidate fails; the final throw must carry the base.
        const ctx = createMemoryContext();
        await seedRepo(ctx, {});

        // Act
        let caught: unknown;
        try {
          await revParse(ctx, 'no-such-thing');
        } catch (err) {
          caught = err;
        }

        // Assert
        const data = (caught as TsgitError).data as { code: string; id: string };
        expect(data.code).toBe('OBJECT_NOT_FOUND');
        expect(data.id).toBe('no-such-thing');
      });
    });
  });

  describe('Given HEAD with one parent op', () => {
    describe('When revParse(HEAD^)', () => {
      it('Then returns the first parent', async () => {
        // Arrange — exercises the operations loop and getNthParent (n-1 indexing).
        const ctx = createMemoryContext();
        const parent = await writeCommit(ctx, TREE_OID as ObjectId, []);
        const child = await writeCommit(ctx, TREE_OID as ObjectId, [parent]);
        await seedRepo(ctx, { refs: { 'refs/heads/main': child } });

        // Act
        const sut = await revParse(ctx, 'HEAD^');

        // Assert
        expect(sut).toBe(parent);
      });
    });
  });

  describe('Given a merge commit with two parents', () => {
    describe('When revParse(HEAD^2)', () => {
      it('Then returns the second parent', async () => {
        // Arrange — kills the `n - 1` ArithmeticOperator mutant: `n + 1` would
        // index parents[3] (undefined) for ^2.
        const ctx = createMemoryContext();
        const p1 = await writeCommit(ctx, TREE_OID as ObjectId, []);
        const p2 = await writeCommit(ctx, TREE_OID as ObjectId, [p1]);
        const merge = await writeCommit(ctx, TREE_OID as ObjectId, [p1, p2]);
        await seedRepo(ctx, { refs: { 'refs/heads/main': merge } });

        // Act
        const sut = await revParse(ctx, 'HEAD^2');

        // Assert
        expect(sut).toBe(p2);
      });
    });
  });

  describe('Given a merge commit', () => {
    describe('When revParse(HEAD^1)', () => {
      it('Then returns the first parent (not the second)', async () => {
        // Arrange — pins `n - 1` so `^1` selects parents[0].
        const ctx = createMemoryContext();
        const p1 = await writeCommit(ctx, TREE_OID as ObjectId, []);
        const p2 = await writeCommit(ctx, TREE_OID as ObjectId, [p1]);
        const merge = await writeCommit(ctx, TREE_OID as ObjectId, [p1, p2]);
        await seedRepo(ctx, { refs: { 'refs/heads/main': merge } });

        // Act
        const sut = await revParse(ctx, 'HEAD^1');

        // Assert
        expect(sut).toBe(p1);
      });
    });
  });

  describe('Given a tree-ish with a path (<rev>:<path>)', () => {
    const seedTree = async (
      ctx: Context,
    ): Promise<{ blobA: ObjectId; blobB: ObjectId; sub: ObjectId; root: ObjectId }> => {
      const blobA = await writeBlob(ctx, 'hello\n');
      const blobB = await writeBlob(ctx, 'nested\n');
      const sub = await writeObject(ctx, {
        type: 'tree',
        id: '' as ObjectId,
        entries: [{ name: 'b.txt', id: blobB, mode: FILE_MODE.REGULAR }],
      });
      const root = await writeObject(ctx, {
        type: 'tree',
        id: '' as ObjectId,
        entries: [
          { name: 'a.txt', id: blobA, mode: FILE_MODE.REGULAR },
          { name: 'sub', id: sub, mode: FILE_MODE.DIRECTORY },
        ],
      });
      const commit = await writeCommit(ctx, root, []);
      await seedRepo(ctx, { refs: { 'refs/heads/main': commit } });
      return { blobA, blobB, sub, root };
    };

    describe('When revParse(main:a.txt)', () => {
      it('Then returns the blob at that path', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const { blobA } = await seedTree(ctx);

        // Act
        const sut = await revParse(ctx, 'main:a.txt');

        // Assert
        expect(sut).toBe(blobA);
      });
    });

    describe('When revParse(main:sub/b.txt)', () => {
      it('Then descends sub-trees to the nested blob', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const { blobB } = await seedTree(ctx);

        // Act
        const sut = await revParse(ctx, 'main:sub/b.txt');

        // Assert
        expect(sut).toBe(blobB);
      });
    });

    describe('When revParse(main:) with an empty path', () => {
      it('Then returns the commit tree itself', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const { root } = await seedTree(ctx);

        // Act
        const sut = await revParse(ctx, 'main:');

        // Assert
        expect(sut).toBe(root);
      });
    });

    describe('When revParse(main:sub) names a sub-tree', () => {
      it('Then returns the sub-tree id', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const { sub } = await seedTree(ctx);

        // Act
        const sut = await revParse(ctx, 'main:sub');

        // Assert
        expect(sut).toBe(sub);
      });
    });

    describe('When the path component is absent', () => {
      it('Then throws PATH_NOT_IN_TREE carrying rev and path', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedTree(ctx);
        let caught: unknown;

        // Act
        try {
          await revParse(ctx, 'main:nope');
        } catch (err) {
          caught = err;
        }

        // Assert
        const data = (caught as TsgitError).data as { code: string; rev: string; path: string };
        expect(data.code).toBe('PATH_NOT_IN_TREE');
        expect(data.rev).toBe('main');
        expect(data.path).toBe('nope');
      });
    });

    describe('When a component descends into a blob', () => {
      it('Then throws PATH_NOT_IN_TREE on the non-tree component', async () => {
        // Arrange — `a.txt` is a blob, so descending into `a.txt/x` cannot resolve.
        const ctx = createMemoryContext();
        await seedTree(ctx);
        let caught: unknown;

        // Act
        try {
          await revParse(ctx, 'main:a.txt/x');
        } catch (err) {
          caught = err;
        }

        // Assert
        const data = (caught as TsgitError).data as { code: string };
        expect(data.code).toBe('PATH_NOT_IN_TREE');
      });
    });
  });

  describe('Given a non-commit object', () => {
    describe('When revParse(<blob>^)', () => {
      it('Then throws OBJECT_NOT_FOUND on the blob id', async () => {
        // Arrange — kills the `obj.type !== 'commit'` guard in getNthParent.
        const ctx = createMemoryContext();
        await seedRepo(ctx, {});
        const blob = await writeBlob(ctx, 'plain');

        // Act
        let caught: unknown;
        try {
          await revParse(ctx, `${blob}^`);
        } catch (err) {
          caught = err;
        }

        // Assert
        const data = (caught as TsgitError).data as { code: string; id: string };
        expect(data.code).toBe('OBJECT_NOT_FOUND');
        expect(data.id).toBe(blob);
      });
    });
  });

  describe('Given a root commit', () => {
    describe('When revParse(HEAD^)', () => {
      it('Then throws OBJECT_NOT_FOUND (no first parent)', async () => {
        // Arrange — kills the `parent === undefined` guard in getNthParent.
        const ctx = createMemoryContext();
        const root = await writeCommit(ctx, TREE_OID as ObjectId, []);
        await seedRepo(ctx, { refs: { 'refs/heads/main': root } });

        // Act
        let caught: unknown;
        try {
          await revParse(ctx, 'HEAD^');
        } catch (err) {
          caught = err;
        }

        // Assert
        const data = (caught as TsgitError).data as { code: string; id: string };
        expect(data.code).toBe('OBJECT_NOT_FOUND');
        expect(data.id).toBe(root);
      });
    });
  });

  describe('Given a three-commit chain', () => {
    describe('When revParse(HEAD~2)', () => {
      it('Then walks first-parent twice to the grandparent', async () => {
        // Arrange — kills the ancestor loop `i < op.n` / `i += 1` mutants:
        // ~2 must land exactly on the grandparent, not the parent or root-fail.
        const ctx = createMemoryContext();
        const gp = await writeCommit(ctx, TREE_OID as ObjectId, []);
        const parent = await writeCommit(ctx, TREE_OID as ObjectId, [gp]);
        const head = await writeCommit(ctx, TREE_OID as ObjectId, [parent]);
        await seedRepo(ctx, { refs: { 'refs/heads/main': head } });

        // Act
        const sut = await revParse(ctx, 'HEAD~2');

        // Assert
        expect(sut).toBe(gp);
      });
    });
  });

  describe('Given a two-commit chain', () => {
    describe('When revParse(HEAD~1)', () => {
      it('Then walks first-parent once to the parent', async () => {
        // Arrange — pins the ancestor loop lower bound: ~1 runs exactly one step.
        const ctx = createMemoryContext();
        const parent = await writeCommit(ctx, TREE_OID as ObjectId, []);
        const head = await writeCommit(ctx, TREE_OID as ObjectId, [parent]);
        await seedRepo(ctx, { refs: { 'refs/heads/main': head } });

        // Act
        const sut = await revParse(ctx, 'HEAD~1');

        // Assert
        expect(sut).toBe(parent);
      });
    });
  });

  describe('Given HEAD~0', () => {
    describe('When revParse', () => {
      it('Then the ancestor loop runs zero times and returns HEAD itself', async () => {
        // Arrange — kills the ancestor loop upper-bound mutants (`i <= op.n` would
        // run one iteration for n=0 and fail on the root commit).
        const ctx = createMemoryContext();
        const head = await writeCommit(ctx, TREE_OID as ObjectId, []);
        await seedRepo(ctx, { refs: { 'refs/heads/main': head } });

        // Act
        const sut = await revParse(ctx, 'HEAD~0');

        // Assert
        expect(sut).toBe(head);
      });
    });
  });

  describe('Given a commit', () => {
    describe('When revParse(HEAD^{tree})', () => {
      it('Then peels the commit to its tree', async () => {
        // Arrange — kills the `target === 'tree' && obj.type === 'commit'` branch.
        const ctx = createMemoryContext();
        const tree = await writeObject(ctx, { type: 'tree', id: '' as ObjectId, entries: [] });
        const commit = await writeCommit(ctx, tree, []);
        await seedRepo(ctx, { refs: { 'refs/heads/main': commit } });

        // Act
        const sut = await revParse(ctx, 'HEAD^{tree}');

        // Assert
        expect(sut).toBe(tree);
      });
    });
    describe('When revParse(HEAD^{commit})', () => {
      it('Then the peel target matches immediately and returns the commit', async () => {
        // Arrange — kills the `obj.type === target` match in peel.
        const ctx = createMemoryContext();
        const commit = await writeCommit(ctx, TREE_OID as ObjectId, []);
        await seedRepo(ctx, { refs: { 'refs/heads/main': commit } });

        // Act
        const sut = await revParse(ctx, 'HEAD^{commit}');

        // Assert
        expect(sut).toBe(commit);
      });
    });
  });

  describe('Given a tag pointing at a commit', () => {
    describe('When revParse(<tag>^{commit})', () => {
      it('Then peels through the tag to the commit', async () => {
        // Arrange — kills the `obj.type === 'tag'` follow-through branch.
        const ctx = createMemoryContext();
        const commit = await writeCommit(ctx, TREE_OID as ObjectId, []);
        const tag = await writeTag(ctx, commit, 'commit');
        await seedRepo(ctx, { refs: { 'refs/heads/main': commit, 'refs/tags/v1': tag } });

        // Act
        const sut = await revParse(ctx, 'v1^{commit}');

        // Assert
        expect(sut).toBe(commit);
      });
    });
  });

  describe('Given nested tags peeling to a commit', () => {
    describe('When revParse', () => {
      it('Then the peel loop iterates within its five-step budget', async () => {
        // Arrange — three stacked tags + commit = four reads; kills the `i < 5`
        // loop-bound mutants that would either stop short or never iterate.
        const ctx = createMemoryContext();
        const commit = await writeCommit(ctx, TREE_OID as ObjectId, []);
        const t1 = await writeTag(ctx, commit, 'commit');
        const t2 = await writeTag(ctx, t1, 'tag');
        const t3 = await writeTag(ctx, t2, 'tag');
        await seedRepo(ctx, { refs: { 'refs/heads/main': commit, 'refs/tags/v1': t3 } });

        // Act
        const sut = await revParse(ctx, 'v1^{commit}');

        // Assert
        expect(sut).toBe(commit);
      });
    });
  });

  describe('Given five stacked tags wrapping a commit', () => {
    describe('When revParse(<tag>^{commit})', () => {
      it('Then peel exhausts its five-step budget and rejects with OBJECT_NOT_FOUND', async () => {
        // Arrange — peel reads exactly five tags (i=0..4) then exits at `i < 5`,
        // throwing on the unreached commit. `i <= 5` would do a sixth read and
        // succeed; `i -= 1` never hits the bound and also succeeds — both mutants
        // turn this failure into the commit oid.
        const ctx = createMemoryContext();
        const commit = await writeCommit(ctx, TREE_OID as ObjectId, []);
        const t1 = await writeTag(ctx, commit, 'commit');
        const t2 = await writeTag(ctx, t1, 'tag');
        const t3 = await writeTag(ctx, t2, 'tag');
        const t4 = await writeTag(ctx, t3, 'tag');
        const t5 = await writeTag(ctx, t4, 'tag');
        await seedRepo(ctx, { refs: { 'refs/heads/main': commit, 'refs/tags/v1': t5 } });

        // Act
        let caught: unknown;
        try {
          await revParse(ctx, 'v1^{commit}');
        } catch (err) {
          caught = err;
        }

        // Assert
        const data = (caught as TsgitError).data as { code: string; id: string };
        expect(data.code).toBe('OBJECT_NOT_FOUND');
        expect(data.id).toBe(commit);
      });
    });
  });

  describe('Given a blob', () => {
    describe('When revParse(<blob>^{commit})', () => {
      it('Then peel rejects with OBJECT_NOT_FOUND', async () => {
        // Arrange — exercises the `throw objectNotFound(current)` fallthrough in peel.
        const ctx = createMemoryContext();
        await seedRepo(ctx, {});
        const blob = await writeBlob(ctx, 'data');

        // Act
        let caught: unknown;
        try {
          await revParse(ctx, `${blob}^{commit}`);
        } catch (err) {
          caught = err;
        }

        // Assert
        const data = (caught as TsgitError).data as { code: string; id: string };
        expect(data.code).toBe('OBJECT_NOT_FOUND');
        expect(data.id).toBe(blob);
      });
    });
  });

  describe('Given a commit', () => {
    describe('When revParse(HEAD^{blob})', () => {
      it('Then peel cannot reach a blob and rejects with OBJECT_NOT_FOUND', async () => {
        // Arrange — a commit is not a blob and `target !== 'tree'`, so peel hits
        // the throw; pins the `target === 'tree'` guard's false branch.
        const ctx = createMemoryContext();
        const commit = await writeCommit(ctx, TREE_OID as ObjectId, []);
        await seedRepo(ctx, { refs: { 'refs/heads/main': commit } });

        // Act
        let caught: unknown;
        try {
          await revParse(ctx, 'HEAD^{blob}');
        } catch (err) {
          caught = err;
        }

        // Assert
        const data = (caught as TsgitError).data as { code: string; id: string };
        expect(data.code).toBe('OBJECT_NOT_FOUND');
        expect(data.id).toBe(commit);
      });
    });
  });

  describe('Given an index entry at stage 0 for a path', () => {
    describe('When revParse(:0:<path>)', () => {
      it('Then returns that entry id', async () => {
        // Arrange — exercises resolveIndexStage's loop and happy-path return.
        const ctx = createMemoryContext();
        await seedRepo(ctx, {});
        const blob = await writeBlob(ctx, 'content');
        await writeIndexFile(ctx, [{ path: 'a.txt', id: blob, stage: 0 }]);

        // Act
        const sut = await revParse(ctx, ':0:a.txt');

        // Assert
        expect(sut).toBe(blob);
      });
    });
  });

  describe('Given an entry whose path matches but whose stage differs', () => {
    describe('When revParse(:0:<path>)', () => {
      it('Then the stage operand of the guard rejects it', async () => {
        // Arrange — kills the `entry.flags.stage === expr.stage` operand and the
        // `||` logical mutant: path matches, stage does not.
        const ctx = createMemoryContext();
        await seedRepo(ctx, {});
        const blob = await writeBlob(ctx, 'ours');
        await writeIndexFile(ctx, [{ path: 'a.txt', id: blob, stage: 2 }]);

        // Act
        let caught: unknown;
        try {
          await revParse(ctx, ':0:a.txt');
        } catch (err) {
          caught = err;
        }

        // Assert
        const data = (caught as TsgitError).data as { code: string; id: string };
        expect(data.code).toBe('OBJECT_NOT_FOUND');
        expect(data.id).toBe('0:a.txt');
      });
    });
  });

  describe('Given an entry whose stage matches but whose path differs', () => {
    describe('When revParse(:0:<path>)', () => {
      it('Then the path operand of the guard rejects it', async () => {
        // Arrange — kills the `entry.path === expr.path` operand: stage matches,
        // path does not.
        const ctx = createMemoryContext();
        await seedRepo(ctx, {});
        const blob = await writeBlob(ctx, 'other');
        await writeIndexFile(ctx, [{ path: 'other.txt', id: blob, stage: 0 }]);

        // Act
        let caught: unknown;
        try {
          await revParse(ctx, ':0:a.txt');
        } catch (err) {
          caught = err;
        }

        // Assert
        const data = (caught as TsgitError).data as { code: string; id: string };
        expect(data.code).toBe('OBJECT_NOT_FOUND');
        expect(data.id).toBe('0:a.txt');
      });
    });
  });

  describe('Given two same-path entries at stages 2 and 3', () => {
    describe('When revParse(:3:<path>)', () => {
      it('Then returns exactly the stage-3 entry', async () => {
        // Arrange — both operands must hold simultaneously; the matching entry is
        // not the first in the index, exercising the loop past entry one.
        const ctx = createMemoryContext();
        await seedRepo(ctx, {});
        const ours = await writeBlob(ctx, 'ours');
        const theirs = await writeBlob(ctx, 'theirs');
        await writeIndexFile(ctx, [
          { path: 'conflict.txt', id: ours, stage: 2 },
          { path: 'conflict.txt', id: theirs, stage: 3 },
        ]);

        // Act
        const sut = await revParse(ctx, ':3:conflict.txt');

        // Assert
        expect(sut).toBe(theirs);
      });
    });
  });

  describe('Given an empty index', () => {
    describe('When revParse(:0:<path>)', () => {
      it('Then throws OBJECT_NOT_FOUND for stage:path', async () => {
        // Arrange — no entries: the loop body never runs and the throw fires.
        const ctx = createMemoryContext();
        await seedRepo(ctx, {});

        // Act
        let caught: unknown;
        try {
          await revParse(ctx, ':0:missing.txt');
        } catch (err) {
          caught = err;
        }

        // Assert
        const data = (caught as TsgitError).data as { code: string; id: string };
        expect(data.code).toBe('OBJECT_NOT_FOUND');
        expect(data.id).toBe('0:missing.txt');
      });
    });
  });

  describe('reflog selectors', () => {
    const HEAD_REF = 'HEAD' as RefName;
    const MAIN_REF = 'refs/heads/main' as RefName;

    const identityAt = (timestamp: number): AuthorIdentity => ({
      name: 'Test',
      email: 'test@example.com',
      timestamp,
      timezoneOffset: '+0000',
    });

    const reflogEntry = (oldId: ObjectId, newId: ObjectId, timestamp: number): ReflogEntry => ({
      oldId,
      newId,
      identity: identityAt(timestamp),
      message: 'move',
    });

    describe('Given a HEAD reflog with two moves', () => {
      describe('When revParse(HEAD@{1})', () => {
        it('Then it returns the second-newest newId', async () => {
          // Arrange — oldest-first file; @{1} is the second-newest entry's newId.
          const ctx = createMemoryContext();
          const c1 = await writeCommit(ctx, TREE_OID as ObjectId, []);
          const c2 = await writeCommit(ctx, TREE_OID as ObjectId, [c1]);
          await seedRepo(ctx, { refs: { 'refs/heads/main': c2 } });
          await writeReflog(ctx, HEAD_REF, [
            reflogEntry(ZERO_OID, c1, 1_000),
            reflogEntry(c1, c2, 2_000),
          ]);

          // Act
          const sut = await revParse(ctx, 'HEAD@{1}');

          // Assert
          expect(sut).toBe(c1);
        });
      });
    });

    describe('Given a HEAD reflog', () => {
      describe('When revParse(HEAD@{0})', () => {
        it('Then it returns the newest entry newId', async () => {
          // Arrange
          const ctx = createMemoryContext();
          const c1 = await writeCommit(ctx, TREE_OID as ObjectId, []);
          const c2 = await writeCommit(ctx, TREE_OID as ObjectId, [c1]);
          await seedRepo(ctx, { refs: { 'refs/heads/main': c2 } });
          await writeReflog(ctx, HEAD_REF, [
            reflogEntry(ZERO_OID, c1, 1_000),
            reflogEntry(c1, c2, 2_000),
          ]);

          // Act
          const sut = await revParse(ctx, 'HEAD@{0}');

          // Assert
          expect(sut).toBe(c2);
        });
      });
    });

    describe('Given a branch reflog', () => {
      describe('When revParse(main@{0})', () => {
        it('Then the branch log resolves the newest tip', async () => {
          // Arrange — kills a mutant that hard-codes the base to HEAD.
          const ctx = createMemoryContext();
          const tip = await writeCommit(ctx, TREE_OID as ObjectId, []);
          await seedRepo(ctx, { refs: { 'refs/heads/main': tip } });
          await writeReflog(ctx, MAIN_REF, [reflogEntry(ZERO_OID, tip, 1_000)]);

          // Act
          const sut = await revParse(ctx, 'main@{0}');

          // Assert
          expect(sut).toBe(tip);
        });
      });
    });

    describe('Given a bare @{N} selector and HEAD on a branch', () => {
      describe('When revParse(@{0})', () => {
        it('Then it resolves against that branch reflog', async () => {
          // Arrange — bare `@{N}` reads the checked-out branch's log, not HEAD's.
          const ctx = createMemoryContext();
          const tip = await writeCommit(ctx, TREE_OID as ObjectId, []);
          await seedRepo(ctx, { refs: { 'refs/heads/main': tip } });
          await writeReflog(ctx, MAIN_REF, [reflogEntry(ZERO_OID, tip, 1_000)]);

          // Act
          const sut = await revParse(ctx, '@{0}');

          // Assert
          expect(sut).toBe(tip);
        });
      });
    });

    describe('Given a detached HEAD and a bare @{N} selector', () => {
      describe('When revParse(@{0})', () => {
        it('Then it falls back to the HEAD reflog', async () => {
          // Arrange — detached HEAD has no branch target, so `@{N}` reads HEAD's log.
          const ctx = createMemoryContext();
          const c1 = await writeCommit(ctx, TREE_OID as ObjectId, []);
          await seedRepo(ctx, { head: c1, refs: { 'refs/heads/main': c1 } });
          await writeReflog(ctx, HEAD_REF, [reflogEntry(ZERO_OID, c1, 1_000)]);

          // Act
          const sut = await revParse(ctx, '@{0}');

          // Assert
          expect(sut).toBe(c1);
        });
      });
    });

    describe('Given HEAD@{1} chained with a parent op', () => {
      describe('When revParse(HEAD@{1}^)', () => {
        it('Then the reflog id flows through the ~/^ ops', async () => {
          // Arrange — @{1} resolves to c2 (which has parent c1); `^` peels to c1.
          const ctx = createMemoryContext();
          const c1 = await writeCommit(ctx, TREE_OID as ObjectId, []);
          const c2 = await writeCommit(ctx, TREE_OID as ObjectId, [c1]);
          const c3 = await writeCommit(ctx, TREE_OID as ObjectId, [c2]);
          await seedRepo(ctx, { refs: { 'refs/heads/main': c3 } });
          await writeReflog(ctx, HEAD_REF, [
            reflogEntry(ZERO_OID, c1, 1_000),
            reflogEntry(c1, c2, 2_000),
            reflogEntry(c2, c3, 3_000),
          ]);

          // Act
          const sut = await revParse(ctx, 'HEAD@{1}^');

          // Assert
          expect(sut).toBe(c1);
        });
      });
    });

    describe('Given an index past the newest entry', () => {
      describe('When revParse(HEAD@{5})', () => {
        it('Then throws REFLOG_ENTRY_OUT_OF_RANGE with requested and available', async () => {
          // Arrange — two entries, index 5 is out of range.
          const ctx = createMemoryContext();
          const c1 = await writeCommit(ctx, TREE_OID as ObjectId, []);
          await seedRepo(ctx, { refs: { 'refs/heads/main': c1 } });
          await writeReflog(ctx, HEAD_REF, [
            reflogEntry(ZERO_OID, c1, 1_000),
            reflogEntry(c1, c1, 2_000),
          ]);

          // Act
          let caught: unknown;
          try {
            await revParse(ctx, 'HEAD@{5}');
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as TsgitError).data).toEqual({
            code: 'REFLOG_ENTRY_OUT_OF_RANGE',
            ref: 'HEAD',
            requested: 5,
            available: 2,
          });
        });
      });
    });

    describe('Given a ref with an empty reflog file', () => {
      describe('When revParse(HEAD@{0})', () => {
        it('Then throws REVPARSE_UNRESOLVED', async () => {
          // Arrange — the file exists but has no entries.
          const ctx = createMemoryContext();
          const c1 = await writeCommit(ctx, TREE_OID as ObjectId, []);
          await seedRepo(ctx, { refs: { 'refs/heads/main': c1 } });
          await writeReflog(ctx, HEAD_REF, []);

          // Act
          let caught: unknown;
          try {
            await revParse(ctx, 'HEAD@{0}');
          } catch (err) {
            caught = err;
          }

          // Assert
          expect((caught as TsgitError).data).toEqual({
            code: 'REVPARSE_UNRESOLVED',
            expression: 'HEAD@{0}',
          });
        });
      });
    });

    describe('Given a base with no reflog file at all', () => {
      describe('When revParse(missing@{0})', () => {
        it('Then throws REVPARSE_UNRESOLVED', async () => {
          // Arrange — the candidate ladder finds no reflog file for the base.
          const ctx = createMemoryContext();
          await seedRepo(ctx, {});

          // Act
          let caught: unknown;
          try {
            await revParse(ctx, 'missing@{0}');
          } catch (err) {
            caught = err;
          }

          // Assert
          expect((caught as TsgitError).data).toEqual({
            code: 'REVPARSE_UNRESOLVED',
            expression: 'missing@{0}',
          });
        });
      });
    });

    describe('Given a date after the newest entry', () => {
      describe('When revParse(HEAD@{<date>})', () => {
        it('Then it returns the newest entry newId', async () => {
          // Arrange — a target newer than every entry resolves to the newest move.
          const ctx = createMemoryContext();
          const c1 = await writeCommit(ctx, TREE_OID as ObjectId, []);
          const c2 = await writeCommit(ctx, TREE_OID as ObjectId, [c1]);
          await seedRepo(ctx, { refs: { 'refs/heads/main': c2 } });
          await writeReflog(ctx, HEAD_REF, [
            reflogEntry(ZERO_OID, c1, 1_000),
            reflogEntry(c1, c2, 2_000),
          ]);

          // Act — `now` is the reference for `2.days.ago`; both entries (ts 1000,
          // 2000, i.e. 1970) predate it, so the newest entry is selected.
          const sut = await revParse(ctx, 'HEAD@{2.days.ago}');

          // Assert
          expect(sut).toBe(c2);
        });
      });
    });

    describe('Given a date between two entries', () => {
      describe('When revParse(HEAD@{<iso>})', () => {
        it('Then it returns the newest entry at or before that date', async () => {
          // Arrange — entries at 2020-01-01 and 2024-01-01; a 2022 target picks the
          // 2020 entry (the newest whose timestamp is <= target).
          const ctx = createMemoryContext();
          const c1 = await writeCommit(ctx, TREE_OID as ObjectId, []);
          const c2 = await writeCommit(ctx, TREE_OID as ObjectId, [c1]);
          await seedRepo(ctx, { refs: { 'refs/heads/main': c2 } });
          const ts2020 = Math.floor(Date.UTC(2020, 0, 1) / 1000);
          const ts2024 = Math.floor(Date.UTC(2024, 0, 1) / 1000);
          await writeReflog(ctx, HEAD_REF, [
            reflogEntry(ZERO_OID, c1, ts2020),
            reflogEntry(c1, c2, ts2024),
          ]);

          // Act
          const sut = await revParse(ctx, 'HEAD@{2022-01-01}');

          // Assert
          expect(sut).toBe(c1);
        });
      });
    });

    describe('Given a date before the oldest entry', () => {
      describe('When revParse(HEAD@{<iso>})', () => {
        it('Then it returns the oldest entry oldId', async () => {
          // Arrange — git: a target before the log starts yields the ref's value
          // before the first recorded move, i.e. the oldest entry's oldId.
          const ctx = createMemoryContext();
          const c1 = await writeCommit(ctx, TREE_OID as ObjectId, []);
          await seedRepo(ctx, { refs: { 'refs/heads/main': c1 } });
          const ts2024 = Math.floor(Date.UTC(2024, 0, 1) / 1000);
          await writeReflog(ctx, HEAD_REF, [reflogEntry(c1, c1, ts2024)]);

          // Act
          const sut = await revParse(ctx, 'HEAD@{2020-01-01}');

          // Assert
          expect(sut).toBe(c1);
        });
      });
    });

    describe('Given an unparseable date selector', () => {
      describe('When revParse(HEAD@{<garbage>})', () => {
        it('Then throws REVPARSE_UNRESOLVED', async () => {
          // Arrange
          const ctx = createMemoryContext();
          const c1 = await writeCommit(ctx, TREE_OID as ObjectId, []);
          await seedRepo(ctx, { refs: { 'refs/heads/main': c1 } });
          await writeReflog(ctx, HEAD_REF, [reflogEntry(ZERO_OID, c1, 1_000)]);

          // Act
          let caught: unknown;
          try {
            await revParse(ctx, 'HEAD@{not-a-date}');
          } catch (err) {
            caught = err;
          }

          // Assert
          expect((caught as TsgitError).data.code).toBe('REVPARSE_UNRESOLVED');
        });
      });
    });

    describe('Given a base resolvable as a ref but with a reflog only under refs/heads/', () => {
      describe('When revParse(main@{0})', () => {
        it('Then the candidate ladder finds the branch log', async () => {
          // Arrange — the reflog file lives at refs/heads/main; the short base
          // `main` must be canonicalized to it.
          const ctx = createMemoryContext();
          const tip = await writeCommit(ctx, TREE_OID as ObjectId, []);
          await seedRepo(ctx, { refs: { 'refs/heads/main': tip } });
          await writeReflog(ctx, MAIN_REF, [reflogEntry(ZERO_OID, tip, 1_000)]);

          // Act
          const sut = await revParse(ctx, 'main@{0}');

          // Assert
          expect(sut).toBe(tip);
        });
      });
    });

    describe('Given an invalid base with no reflog and no resolving ref', () => {
      describe('When revParse(<invalid>@{0})', () => {
        it('Then throws REVPARSE_UNRESOLVED with the base', async () => {
          // Arrange — a base containing `..` has no reflog and resolves as no ref;
          // canonicalizeRef must reject it rather than return an invalid RefName.
          const ctx = createMemoryContext();
          await seedRepo(ctx, {});

          // Act
          let caught: unknown;
          try {
            await revParse(ctx, '../../etc/passwd@{0}');
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as TsgitError).data).toEqual({
            code: 'REVPARSE_UNRESOLVED',
            expression: '../../etc/passwd',
          });
        });
      });
    });

    describe('Given a date exactly equal to an entry timestamp', () => {
      describe('When revParse(HEAD@{<date>})', () => {
        it('Then that entry newId is returned', async () => {
          // Arrange — pins the `<=` boundary: a target equal to an entry's
          // timestamp must select that entry, not skip past it. The entry timestamp
          // is built from the SAME local-calendar construction parseApproxidate
          // uses for an ISO date, so the equality holds on any host timezone.
          const ctx = createMemoryContext();
          const c1 = await writeCommit(ctx, TREE_OID as ObjectId, []);
          const c2 = await writeCommit(ctx, TREE_OID as ObjectId, [c1]);
          await seedRepo(ctx, { refs: { 'refs/heads/main': c2 } });
          const ts2020 = Math.floor(new Date(2020, 0, 1, 0, 0, 0).getTime() / 1000);
          const ts2024 = Math.floor(new Date(2024, 0, 1, 0, 0, 0).getTime() / 1000);
          await writeReflog(ctx, HEAD_REF, [
            reflogEntry(ZERO_OID, c1, ts2020),
            reflogEntry(c1, c2, ts2024),
          ]);

          // Act — target equals the older entry's exact timestamp.
          const sut = await revParse(ctx, 'HEAD@{2020-01-01}');

          // Assert — the equal-timestamp entry (c1) is selected, not the prior oldId.
          expect(sut).toBe(c1);
        });
      });
    });

    describe('Given a relative date selector', () => {
      describe('When revParse(HEAD@{N.days.ago})', () => {
        it('Then the cutoff is anchored to the current wall-clock seconds', async () => {
          // Arrange — `now` must be `Date.now()` in SECONDS. Two entries straddle
          // `now - 5.days`: one 10 days old (<= cutoff), one 1 day old (> cutoff).
          // With a seconds-anchored `now` the 10-day entry is the newest at-or-
          // before the cutoff; a mis-scaled `now` (e.g. milliseconds) pushes the
          // cutoff far into the future and wrongly selects the 1-day entry.
          const nowSeconds = Math.floor(Date.now() / 1000);
          const DAY = 86_400;
          const ctx = createMemoryContext();
          const tenDayCommit = await writeCommit(ctx, TREE_OID as ObjectId, []);
          const oneDayCommit = await writeCommit(ctx, TREE_OID as ObjectId, [tenDayCommit]);
          await seedRepo(ctx, { refs: { 'refs/heads/main': oneDayCommit } });
          await writeReflog(ctx, HEAD_REF, [
            reflogEntry(ZERO_OID, tenDayCommit, nowSeconds - 10 * DAY),
            reflogEntry(tenDayCommit, oneDayCommit, nowSeconds - 1 * DAY),
          ]);

          // Act
          const sut = await revParse(ctx, 'HEAD@{5.days.ago}');

          // Assert — the 10-day-old entry is the newest at or before `now - 5.days`.
          expect(sut).toBe(tenDayCommit);
        });
      });
    });

    describe('Given a base whose reflog lives on a later candidate than the resolving ref', () => {
      describe('When revParse(<base>@{0})', () => {
        it('Then the reflog-file candidate wins', async () => {
          // Arrange — base `v1`: the candidate ladder is [v1, refs/v1,
          // refs/tags/v1, refs/heads/v1, refs/remotes/v1, refs/remotes/v1/HEAD].
          // A branch resolves at refs/heads/v1, but the only reflog FILE is at
          // refs/tags/v1. canonicalizeRef's first loop
          // (reflog-file search) must win over the second loop (ref resolution),
          // otherwise the empty refs/heads/v1 log throws REVPARSE_UNRESOLVED.
          const ctx = createMemoryContext();
          const branchTip = await writeCommit(ctx, TREE_OID as ObjectId, []);
          const taggedTip = await writeCommit(ctx, TREE_OID as ObjectId, [branchTip]);
          await seedRepo(ctx, { refs: { 'refs/heads/v1': branchTip } });
          await writeReflog(ctx, 'refs/tags/v1' as RefName, [
            reflogEntry(ZERO_OID, taggedTip, 1_000),
          ]);

          // Act
          const sut = await revParse(ctx, 'v1@{0}');

          // Assert — resolved through the refs/tags/v1 reflog, not the branch.
          expect(sut).toBe(taggedTip);
        });
      });
    });
  });
});
