import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { MemoryHookRunner } from '../../../../src/adapters/memory/memory-hook-runner.js';
import { add } from '../../../../src/application/commands/add.js';
import { branchCreate } from '../../../../src/application/commands/branch.js';
import { checkout } from '../../../../src/application/commands/checkout.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import {
  asMergeDirtyError,
  buildConflictIndexEntries,
  type MergeRunInput,
  materialiseConflictBytes,
  mergeRun,
  resolveMergeAuthor,
  resolveMergeCommitter,
  writeConflictToTree,
  writeNestedTree,
  writeOutcomeToTree,
} from '../../../../src/application/commands/merge.js';
import { rm } from '../../../../src/application/commands/rm.js';
import { tagCreate, tagDelete } from '../../../../src/application/commands/tag.js';
import * as writeFileMod from '../../../../src/application/primitives/internal/write-working-tree-file.js';
import { readBlob } from '../../../../src/application/primitives/read-blob.js';
import { readIndex } from '../../../../src/application/primitives/read-index.js';
import { readObject } from '../../../../src/application/primitives/read-object.js';
import { getRefStore } from '../../../../src/application/primitives/ref-store.js';
import { readReflog } from '../../../../src/application/primitives/reflog-store.js';
import { resolveRef } from '../../../../src/application/primitives/resolve-ref.js';
import * as streamBlobMod from '../../../../src/application/primitives/stream-blob.js';
import { updateRef as seedRef } from '../../../../src/application/primitives/update-ref.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { writeSymbolicRef } from '../../../../src/application/primitives/write-symbolic-ref.js';
import * as writeTreeMod from '../../../../src/application/primitives/write-tree.js';
import { checkoutOverwriteDirty } from '../../../../src/domain/commands/error.js';
import { DEFAULT_MAX_TREE_DEPTH } from '../../../../src/domain/diff/flat-tree.js';
import { TsgitError } from '../../../../src/domain/error.js';
import { NO_PARSER_OFFSET } from '../../../../src/domain/git-index/path-validator.js';
import type { MergeConflict, MergeOutcome } from '../../../../src/domain/merge/index.js';
import type {
  AuthorIdentity,
  FilePath,
  ObjectId,
  RefName,
  Tree,
  TreeEntry,
} from '../../../../src/domain/objects/index.js';
import { FILE_MODE } from '../../../../src/domain/objects/index.js';
import { treeEntry } from '../../../../src/domain/objects/tree.js';
import type { Context } from '../../../../src/ports/context.js';
import {
  buildSeededContext,
  buildTreeChain,
  DEEP_CHAIN_LEAF_CONTENT,
  deepIndexPath,
  seedMaxTreeDepth,
} from '../primitives/fixtures.js';
import { failSourceLoad, snapshotFiles } from './fixtures.js';

const writeBlob = async (
  ctx: Awaited<ReturnType<typeof buildSeededContext>>,
  content: string,
): Promise<ObjectId> =>
  writeObject(ctx, {
    type: 'blob',
    content: new TextEncoder().encode(content),
    id: '' as ObjectId,
  });

const author: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

const FROZEN_SECONDS = 1_800_000_000;

/** Freezes the wall clock every reflog entry reads its timestamp from. */
const freezeClock = (): void => {
  vi.spyOn(Date, 'now').mockReturnValue(FROZEN_SECONDS * 1000);
};

/** `name`'s newest reflog entry, as the raw line the files backend writes. */
const lastReflogLine = async (ctx: Context, name: string): Promise<string | undefined> => {
  const last = (await readReflog(ctx, name as RefName)).at(-1);
  if (last === undefined) return undefined;
  const { oldId, newId, identity, message } = last;
  return `${oldId} ${newId} ${identity.name} <${identity.email}> ${identity.timestamp} ${identity.timezoneOffset}\t${message}`;
};

/** Points `HEAD` at `refs/heads/s`, itself a symbolic ref naming `branch`. */
const chainHeadThroughS = async (ctx: Context, branch: string): Promise<void> => {
  await writeSymbolicRef(ctx, 'refs/heads/s' as RefName, branch as RefName);
  await writeSymbolicRef(ctx, 'HEAD' as RefName, 'refs/heads/s' as RefName);
};

describe('merge walk parse', () => {
  const MISSING = `cd${'0'.repeat(38)}` as ObjectId;

  describe.each([
    ['default', {}],
    ['ff-only', { fastForward: 'only' }],
    ['no-ff', { fastForward: 'never' }],
  ] as const)('Given a commit whose parent the store lacks, merged (%s)', (_mode, options) => {
    describe('When merge walks HEAD against it', () => {
      it("Then it logs both of git's lines and is up to date, as git's reduced heads leave none", async () => {
        // Arrange
        const logged: string[] = [];
        const ctx: Context = {
          ...createMemoryContext(),
          logger: { error: (line: string) => logged.push(line) },
        };
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
        await add(ctx, ['a.txt']);
        const head = await commit(ctx, { message: 'first', author });
        const tree = (await readObject(ctx, head.id)) as { readonly data: { tree: ObjectId } };
        const broken = await writeObject(ctx, {
          type: 'commit',
          id: '' as ObjectId,
          data: {
            tree: tree.data.tree,
            parents: [MISSING],
            author,
            committer: author,
            message: 'broken\n',
            extraHeaders: [],
          },
        });
        const sut = mergeRun;

        // Act
        const result = await sut(ctx, { rev: broken, ...options });

        // Assert
        expect({ result, logged, origHead: await resolveRef(ctx, 'ORIG_HEAD' as RefName) }).toEqual(
          {
            result: { kind: 'up-to-date', id: head.id },
            logged: [`Could not read ${MISSING}`, `could not parse commit ${MISSING}`],
            origHead: head.id,
          },
        );
      });
    });
  });

  describe('Given a commit whose parent the store lacks, merged alongside another head', () => {
    describe('When merge reduces the heads', () => {
      it("Then it logs git's lines and is up to date, as git's reduce_heads leaves none", async () => {
        // Arrange
        const logged: string[] = [];
        const ctx: Context = {
          ...createMemoryContext(),
          logger: { error: (line: string) => logged.push(line) },
        };
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
        await add(ctx, ['a.txt']);
        const head = await commit(ctx, { message: 'first', author });
        const tree = (await readObject(ctx, head.id)) as { readonly data: { tree: ObjectId } };
        const data = { tree: tree.data.tree, author, committer: author, extraHeaders: [] };
        const broken = await writeObject(ctx, {
          type: 'commit',
          id: '' as ObjectId,
          data: { ...data, parents: [MISSING], message: 'broken\n' },
        });
        const side = await writeObject(ctx, {
          type: 'commit',
          id: '' as ObjectId,
          data: { ...data, parents: [head.id], message: 'side\n' },
        });
        const sut = mergeRun;

        // Act
        const result = await sut(ctx, { rev: [broken, side] });

        // Assert
        expect({ result, logged, origHead: await resolveRef(ctx, 'ORIG_HEAD' as RefName) }).toEqual(
          {
            result: { kind: 'up-to-date', id: head.id },
            logged: [`Could not read ${MISSING}`, `could not parse commit ${MISSING}`],
            origHead: head.id,
          },
        );
      });
    });
  });
});

describe('merge', () => {
  describe('Given target equals HEAD', () => {
    describe('When merge', () => {
      it('Then result.kind=up-to-date', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
        await add(ctx, ['a.txt']);
        const c = await commit(ctx, { message: 'first', author });

        // Act
        const result = await mergeRun(ctx, { rev: c.id });

        // Assert
        expect(result.kind).toBe('up-to-date');
      });
    });
  });

  describe('Given an ancestor target', () => {
    describe('When merge', () => {
      it('Then result.kind=fast-forward and branch advances', async () => {
        // Arrange — create main with 1 commit, branch feature, advance feature, switch to main, merge feature.
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
        await add(ctx, ['a.txt']);
        await commit(ctx, { message: 'first', author });
        await branchCreate(ctx, { name: 'feature' });
        await checkout(ctx, { rev: 'feature' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/b.txt`, 'b');
        await add(ctx, ['b.txt']);
        const c2 = await commit(ctx, { message: 'second', author });
        await checkout(ctx, { rev: 'main' });

        // Act
        const result = await mergeRun(ctx, { rev: 'feature' });

        // Assert
        expect(result.kind).toBe('fast-forward');
        if (result.kind === 'fast-forward') {
          expect(result.id).toBe(c2.id);
        }
      });
    });
  });

  describe('Given HEAD -> refs/heads/s -> refs/heads/x, x an ancestor of the merge target', () => {
    describe('When merge fast-forwards', () => {
      it('Then x moves to the target, s stays symbolic, and both x and HEAD log the move', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
        await add(ctx, ['a.txt']);
        const c1 = await commit(ctx, { message: 'first', author });
        await branchCreate(ctx, { name: 'x' });
        await checkout(ctx, { rev: 'x' });
        await branchCreate(ctx, { name: 'feature' });
        await checkout(ctx, { rev: 'feature' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/b.txt`, 'b');
        await add(ctx, ['b.txt']);
        const c2 = await commit(ctx, { message: 'second', author });
        await checkout(ctx, { rev: 'x' });
        await writeSymbolicRef(ctx, 'refs/heads/s' as RefName, 'refs/heads/x' as RefName);
        await writeSymbolicRef(ctx, 'HEAD' as RefName, 'refs/heads/s' as RefName);

        // Act
        const result = await mergeRun(ctx, { rev: 'feature' });

        // Assert
        expect(result.kind).toBe('fast-forward');
        const xValue = await getRefStore(ctx).resolveDirect('refs/heads/x' as RefName);
        expect(xValue).toEqual({ kind: 'direct', id: c2.id });
        const sValue = await getRefStore(ctx).resolveDirect('refs/heads/s' as RefName);
        expect(sValue).toEqual({ kind: 'symbolic', target: 'refs/heads/x' });
        const xLog = await readReflog(ctx, 'refs/heads/x' as RefName);
        expect(xLog[xLog.length - 1]?.oldId).toBe(c1.id);
        expect(xLog[xLog.length - 1]?.newId).toBe(c2.id);
        const headLog = await readReflog(ctx, 'HEAD' as RefName);
        expect(headLog[headLog.length - 1]?.oldId).toBe(c1.id);
        expect(headLog[headLog.length - 1]?.newId).toBe(c2.id);
      });
    });
  });

  describe('Given an ancestor target that adds a file', () => {
    describe('When merge fast-forwards', () => {
      it('Then the working tree and index gain the added file', async () => {
        // Arrange — base f.txt; feature +m.txt; main stays at base → fast-forward.
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/f.txt`, 'base\n');
        await add(ctx, ['f.txt']);
        await commit(ctx, { message: 'base', author });
        await branchCreate(ctx, { name: 'feature' });
        await checkout(ctx, { rev: 'feature' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/m.txt`, 'm\n');
        await add(ctx, ['m.txt']);
        await commit(ctx, { message: 'feature-add', author });
        await checkout(ctx, { rev: 'main' });

        // Act
        const result = await mergeRun(ctx, { rev: 'feature', author });

        // Assert — fast-forward materialises m.txt to working tree + index.
        expect(result.kind).toBe('fast-forward');
        const onDisk = await ctx.fs.exists(`${ctx.layout.workDir}/m.txt`);
        const indexPaths = (await readIndex(ctx)).entries.map((e) => e.path).sort();
        expect(onDisk).toBe(true);
        expect(indexPaths).toEqual(['f.txt', 'm.txt']);
      });
    });
  });

  describe("Given an ancestor target + fastForward='never'", () => {
    describe('When merge', () => {
      it('Then a real merge commit is produced', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
        await add(ctx, ['a.txt']);
        await commit(ctx, { message: 'first', author });
        await branchCreate(ctx, { name: 'feature' });
        await checkout(ctx, { rev: 'feature' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/b.txt`, 'b');
        await add(ctx, ['b.txt']);
        await commit(ctx, { message: 'second', author });
        await checkout(ctx, { rev: 'main' });

        // Act
        const result = await mergeRun(ctx, {
          rev: 'feature',
          fastForward: 'never',
          message: 'merge',
          author,
        });

        // Assert
        expect(result.kind).toBe('merge');
        if (result.kind === 'merge') {
          expect(result.parents).toHaveLength(2);
        }
      });
    });
  });

  describe("Given an ancestor target + fastForward='allow'", () => {
    describe('When merge', () => {
      it('Then it fast-forwards (no merge commit)', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
        await add(ctx, ['a.txt']);
        await commit(ctx, { message: 'first', author });
        await branchCreate(ctx, { name: 'feature' });
        await checkout(ctx, { rev: 'feature' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/b.txt`, 'b');
        await add(ctx, ['b.txt']);
        const second = await commit(ctx, { message: 'second', author });
        await checkout(ctx, { rev: 'main' });

        // Act
        const result = await mergeRun(ctx, { rev: 'feature', fastForward: 'allow' });

        // Assert
        expect(result.kind).toBe('fast-forward');
        if (result.kind === 'fast-forward') {
          expect(result.id).toBe(second.id);
        }
      });
    });
  });

  describe('Given an ancestor target + fastForward omitted', () => {
    describe('When merge', () => {
      it('Then it fast-forwards by default', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
        await add(ctx, ['a.txt']);
        await commit(ctx, { message: 'first', author });
        await branchCreate(ctx, { name: 'feature' });
        await checkout(ctx, { rev: 'feature' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/b.txt`, 'b');
        await add(ctx, ['b.txt']);
        const second = await commit(ctx, { message: 'second', author });
        await checkout(ctx, { rev: 'main' });

        // Act
        const result = await mergeRun(ctx, { rev: 'feature' });

        // Assert
        expect(result.kind).toBe('fast-forward');
        if (result.kind === 'fast-forward') {
          expect(result.id).toBe(second.id);
        }
      });
    });
  });

  describe("Given a fast-forwardable target + fastForward='only'", () => {
    describe('When merge', () => {
      it('Then it fast-forwards (does not over-refuse)', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
        await add(ctx, ['a.txt']);
        await commit(ctx, { message: 'first', author });
        await branchCreate(ctx, { name: 'feature' });
        await checkout(ctx, { rev: 'feature' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/b.txt`, 'b');
        await add(ctx, ['b.txt']);
        const second = await commit(ctx, { message: 'second', author });
        await checkout(ctx, { rev: 'main' });

        // Act
        const result = await mergeRun(ctx, { rev: 'feature', fastForward: 'only' });

        // Assert
        expect(result.kind).toBe('fast-forward');
        if (result.kind === 'fast-forward') {
          expect(result.id).toBe(second.id);
        }
      });
    });
  });

  describe('Given diverged histories with non-conflicting paths', () => {
    describe('When merge', () => {
      it('Then commit tree contains both sides files (no add required)', async () => {
        // Arrange — base has a.txt. Feature adds b.txt. Main adds c.txt.
        // After merging feature into main, the merge commit's tree must
        // contain BOTH b.txt AND c.txt (clean three-way merge result),
        // NOT just main's tree.
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
        await add(ctx, ['a.txt']);
        await commit(ctx, { message: 'base', author });
        await branchCreate(ctx, { name: 'feature' });
        await checkout(ctx, { rev: 'feature' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/b.txt`, 'b');
        await add(ctx, ['b.txt']);
        await commit(ctx, { message: 'on-feature', author });
        await checkout(ctx, { rev: 'main' });
        // Note: checkout to main reverts the working tree, so b.txt is gone here.
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/c.txt`, 'c');
        await add(ctx, ['c.txt']);
        await commit(ctx, { message: 'on-main', author });

        // Act
        const result = await mergeRun(ctx, { rev: 'feature', author });

        // Assert — the merge commit's tree contains a.txt + b.txt + c.txt.
        expect(result.kind).toBe('merge');
        if (result.kind !== 'merge') throw new Error('expected merge kind');
        const mergeCommit = await readObject(ctx, result.id);
        if (mergeCommit.type !== 'commit') throw new Error('not a commit');
        const mergedTree = (await readObject(ctx, mergeCommit.data.tree)) as Tree;
        const names = mergedTree.entries.map((e) => e.name).sort();
        expect(names).toEqual(['a.txt', 'b.txt', 'c.txt']);
      });
    });
  });

  describe('Given a clean true-merge with a theirs-only add', () => {
    describe('When merge', () => {
      it('Then the working tree and index gain the added file', async () => {
        // Arrange — base f.txt; ours +a.txt; theirs +m.txt (disjoint → clean).
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/f.txt`, 'base\n');
        await add(ctx, ['f.txt']);
        await commit(ctx, { message: 'base', author });
        await branchCreate(ctx, { name: 'theirs' });
        await checkout(ctx, { rev: 'theirs' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/m.txt`, 'm\n');
        await add(ctx, ['m.txt']);
        await commit(ctx, { message: 'theirs-add', author });
        await checkout(ctx, { rev: 'main' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a\n');
        await add(ctx, ['a.txt']);
        await commit(ctx, { message: 'ours-add', author });

        // Act
        const result = await mergeRun(ctx, { rev: 'theirs', author });

        // Assert — m.txt reaches both the working tree and the index.
        expect(result.kind).toBe('merge');
        const onDisk = await ctx.fs.exists(`${ctx.layout.workDir}/m.txt`);
        const indexPaths = (await readIndex(ctx)).entries.map((e) => e.path).sort();
        expect(onDisk).toBe(true);
        expect(indexPaths).toEqual(['a.txt', 'f.txt', 'm.txt']);
      });
    });
  });

  describe('Given a clean true-merge with a theirs-side edit', () => {
    describe('When merge', () => {
      it('Then the working file holds the merged bytes', async () => {
        // Arrange — base 3-line file; ours edits line1; theirs edits line3.
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file.txt`, 'line1\nline2\nline3\n');
        await add(ctx, ['file.txt']);
        await commit(ctx, { message: 'base', author });
        await branchCreate(ctx, { name: 'theirs' });
        await checkout(ctx, { rev: 'theirs' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file.txt`, 'line1\nline2\nTHEIRS\n');
        await add(ctx, ['file.txt']);
        await commit(ctx, { message: 'theirs-edit', author });
        await checkout(ctx, { rev: 'main' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file.txt`, 'OURS\nline2\nline3\n');
        await add(ctx, ['file.txt']);
        await commit(ctx, { message: 'ours-edit', author });

        // Act
        const result = await mergeRun(ctx, { rev: 'theirs', author });

        // Assert — the working file carries both edits.
        expect(result.kind).toBe('merge');
        const onDisk = await ctx.fs.readUtf8(`${ctx.layout.workDir}/file.txt`);
        expect(onDisk).toBe('OURS\nline2\nTHEIRS\n');
      });
    });
  });

  describe('Given a clean true-merge where theirs deletes a file', () => {
    describe('When merge', () => {
      it('Then the working file is removed and the index drops it', async () => {
        // Arrange — base a.txt + b.txt; theirs deletes a.txt; ours touches c.txt.
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a\n');
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/b.txt`, 'b\n');
        await add(ctx, ['a.txt', 'b.txt']);
        await commit(ctx, { message: 'base', author });
        await branchCreate(ctx, { name: 'theirs' });
        await checkout(ctx, { rev: 'theirs' });
        const { rm } = await import('../../../../src/application/commands/rm.js');
        await rm(ctx, ['a.txt']);
        await commit(ctx, { message: 'theirs-delete', author });
        await checkout(ctx, { rev: 'main' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/c.txt`, 'c\n');
        await add(ctx, ['c.txt']);
        await commit(ctx, { message: 'ours-add', author });

        // Act
        const result = await mergeRun(ctx, { rev: 'theirs', author });

        // Assert — a.txt is gone from disk and the index.
        expect(result.kind).toBe('merge');
        const onDisk = await ctx.fs.exists(`${ctx.layout.workDir}/a.txt`);
        const indexPaths = (await readIndex(ctx)).entries.map((e) => e.path).sort();
        expect(onDisk).toBe(false);
        expect(indexPaths).toEqual(['b.txt', 'c.txt']);
      });
    });
  });

  describe('Given a tracked file the merge would overwrite is locally modified', () => {
    describe('When merge', () => {
      it('Then it refuses with WORKING_TREE_DIRTY, leaving HEAD and the dirty file intact', async () => {
        // Arrange — base f.txt; ours +o.txt; theirs edits f.txt → clean true-merge
        // that would overwrite f.txt. Drift the working f.txt before merging.
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/f.txt`, 'base\n');
        await add(ctx, ['f.txt']);
        await commit(ctx, { message: 'base', author });
        await branchCreate(ctx, { name: 'theirs' });
        await checkout(ctx, { rev: 'theirs' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/f.txt`, 'theirs\n');
        await add(ctx, ['f.txt']);
        await commit(ctx, { message: 'theirs-edit', author });
        await checkout(ctx, { rev: 'main' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/o.txt`, 'o\n');
        await add(ctx, ['o.txt']);
        const oursTip = await commit(ctx, { message: 'ours-add', author });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/f.txt`, 'DIRTY\n');

        // Act
        let error: unknown;
        try {
          await mergeRun(ctx, { rev: 'theirs', author });
        } catch (caught) {
          error = caught;
        }

        // Assert — WORKING_TREE_DIRTY on f.txt; HEAD and the dirty bytes untouched.
        expect(error).toBeInstanceOf(TsgitError);
        const data = (error as TsgitError).data;
        expect(data.code).toBe('WORKING_TREE_DIRTY');
        if (data.code === 'WORKING_TREE_DIRTY') {
          expect(data.localChanges).toContain('f.txt');
          expect(data.untracked).toEqual([]);
        }
        expect(await resolveRef(ctx, 'refs/heads/main' as RefName)).toBe(oursTip.id);
        expect(await ctx.fs.readUtf8(`${ctx.layout.workDir}/f.txt`)).toBe('DIRTY\n');
      });
    });
  });

  describe('Given an untracked file clashes with a theirs-only add', () => {
    describe('When merge', () => {
      it('Then it refuses with WORKING_TREE_DIRTY, leaving HEAD and the untracked file intact', async () => {
        // Arrange — base f.txt; ours +o.txt; theirs +m.txt. Pre-write an untracked
        // m.txt the theirs-only add would clobber.
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/f.txt`, 'base\n');
        await add(ctx, ['f.txt']);
        await commit(ctx, { message: 'base', author });
        await branchCreate(ctx, { name: 'theirs' });
        await checkout(ctx, { rev: 'theirs' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/m.txt`, 'theirs-m\n');
        await add(ctx, ['m.txt']);
        await commit(ctx, { message: 'theirs-add', author });
        await checkout(ctx, { rev: 'main' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/o.txt`, 'o\n');
        await add(ctx, ['o.txt']);
        const oursTip = await commit(ctx, { message: 'ours-add', author });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/m.txt`, 'untracked\n');

        // Act
        let error: unknown;
        try {
          await mergeRun(ctx, { rev: 'theirs', author });
        } catch (caught) {
          error = caught;
        }

        // Assert — WORKING_TREE_DIRTY on m.txt; HEAD and the untracked bytes untouched.
        expect(error).toBeInstanceOf(TsgitError);
        const data = (error as TsgitError).data;
        expect(data.code).toBe('WORKING_TREE_DIRTY');
        if (data.code === 'WORKING_TREE_DIRTY') {
          expect(data.untracked).toContain('m.txt');
          expect(data.localChanges).toEqual([]);
        }
        expect(await resolveRef(ctx, 'refs/heads/main' as RefName)).toBe(oursTip.id);
        expect(await ctx.fs.readUtf8(`${ctx.layout.workDir}/m.txt`)).toBe('untracked\n');
      });
    });
  });

  describe('Given a dirty-worktree merge refusal acquired the index lock', () => {
    describe('When a later index operation runs', () => {
      it('Then the lock was released so the operation is not blocked', async () => {
        // Arrange — a clean true-merge that would overwrite f.txt, drifted so it refuses.
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/f.txt`, 'base\n');
        await add(ctx, ['f.txt']);
        await commit(ctx, { message: 'base', author });
        await branchCreate(ctx, { name: 'theirs' });
        await checkout(ctx, { rev: 'theirs' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/f.txt`, 'theirs\n');
        await add(ctx, ['f.txt']);
        await commit(ctx, { message: 'theirs-edit', author });
        await checkout(ctx, { rev: 'main' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/o.txt`, 'o\n');
        await add(ctx, ['o.txt']);
        await commit(ctx, { message: 'ours-add', author });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/f.txt`, 'DIRTY\n');
        let refused = false;
        try {
          await mergeRun(ctx, { rev: 'theirs', author });
        } catch (caught) {
          refused =
            (caught as { readonly data?: { readonly code?: string } }).data?.code ===
            'WORKING_TREE_DIRTY';
        }
        expect(refused).toBe(true);

        // Act — a follow-up op that re-acquires the index lock; a leaked lock
        // would surface as RESOURCE_LOCKED here.
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/q.txt`, 'q\n');
        await add(ctx, ['q.txt']);

        // Assert — the add succeeded, so the refused merge released the lock.
        const indexPaths = (await readIndex(ctx)).entries.map((e) => e.path).sort();
        expect(indexPaths).toContain('q.txt');
      });
    });
  });

  describe('Given a tracked file the conflicting merge would overwrite is locally modified', () => {
    describe('When merge', () => {
      it('Then it refuses with WORKING_TREE_DIRTY, leaving HEAD and the dirty file intact with no MERGE_HEAD', async () => {
        // Arrange — base file.txt; both sides change the SAME line → content
        // conflict. Drift the working file.txt before merging.
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file.txt`, 'a\nb\nc\n');
        await add(ctx, ['file.txt']);
        await commit(ctx, { message: 'base', author });
        await branchCreate(ctx, { name: 'theirs' });
        await checkout(ctx, { rev: 'theirs' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file.txt`, 'a\nY\nc\n');
        await add(ctx, ['file.txt']);
        await commit(ctx, { message: 'theirs-edit', author });
        await checkout(ctx, { rev: 'main' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file.txt`, 'a\nX\nc\n');
        await add(ctx, ['file.txt']);
        const oursTip = await commit(ctx, { message: 'ours-edit', author });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file.txt`, 'a\nDIRTY-LOCAL\nc\n');

        // Act
        let error: unknown;
        try {
          await mergeRun(ctx, { rev: 'theirs', author });
        } catch (caught) {
          error = caught;
        }

        // Assert — WORKING_TREE_DIRTY on file.txt; HEAD, dirty bytes, no MERGE_HEAD.
        expect(error).toBeInstanceOf(TsgitError);
        const data = (error as TsgitError).data;
        expect(data.code).toBe('WORKING_TREE_DIRTY');
        if (data.code === 'WORKING_TREE_DIRTY') {
          expect(data.localChanges).toContain('file.txt');
          expect(data.untracked).toEqual([]);
        }
        expect(await resolveRef(ctx, 'refs/heads/main' as RefName)).toBe(oursTip.id);
        expect(await ctx.fs.readUtf8(`${ctx.layout.workDir}/file.txt`)).toBe('a\nDIRTY-LOCAL\nc\n');
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/MERGE_HEAD`)).toBe(false);
      });
    });
  });

  describe('Given a conflicting-merge tracked-dirty refusal acquired the index lock', () => {
    describe('When a later index operation runs', () => {
      it('Then the lock was released so the operation is not blocked', async () => {
        // Arrange — a content conflict on file.txt, drifted so it refuses.
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file.txt`, 'a\nb\nc\n');
        await add(ctx, ['file.txt']);
        await commit(ctx, { message: 'base', author });
        await branchCreate(ctx, { name: 'theirs' });
        await checkout(ctx, { rev: 'theirs' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file.txt`, 'a\nY\nc\n');
        await add(ctx, ['file.txt']);
        await commit(ctx, { message: 'theirs-edit', author });
        await checkout(ctx, { rev: 'main' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file.txt`, 'a\nX\nc\n');
        await add(ctx, ['file.txt']);
        await commit(ctx, { message: 'ours-edit', author });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file.txt`, 'a\nDIRTY-LOCAL\nc\n');
        let refused = false;
        try {
          await mergeRun(ctx, { rev: 'theirs', author });
        } catch (caught) {
          refused =
            (caught as { readonly data?: { readonly code?: string } }).data?.code ===
            'WORKING_TREE_DIRTY';
        }
        expect(refused).toBe(true);

        // Act — a follow-up op that re-acquires the index lock; a leaked lock
        // would surface as RESOURCE_LOCKED here.
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/q.txt`, 'q\n');
        await add(ctx, ['q.txt']);

        // Assert — the add succeeded, so the refused merge released the lock.
        const indexPaths = (await readIndex(ctx)).entries.map((e) => e.path).sort();
        expect(indexPaths).toContain('q.txt');
      });
    });
  });

  describe('Given only a tracked-dirty conflict path (untracked guard branch quiet)', () => {
    describe('When merge', () => {
      it('Then it refuses with the path in localChanges and untracked empty', async () => {
        // Arrange — single content conflict on file.txt, drifted dirty; nothing
        // else the merge touches is squatted.
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file.txt`, 'a\nb\nc\n');
        await add(ctx, ['file.txt']);
        await commit(ctx, { message: 'base', author });
        await branchCreate(ctx, { name: 'theirs' });
        await checkout(ctx, { rev: 'theirs' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file.txt`, 'a\nY\nc\n');
        await add(ctx, ['file.txt']);
        await commit(ctx, { message: 'theirs-edit', author });
        await checkout(ctx, { rev: 'main' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file.txt`, 'a\nX\nc\n');
        await add(ctx, ['file.txt']);
        await commit(ctx, { message: 'ours-edit', author });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file.txt`, 'a\nDIRTY-LOCAL\nc\n');

        // Act
        let error: unknown;
        try {
          await mergeRun(ctx, { rev: 'theirs', author });
        } catch (caught) {
          error = caught;
        }

        // Assert — localChanges carries file.txt; untracked is empty.
        const data = (error as TsgitError).data;
        expect(data.code).toBe('WORKING_TREE_DIRTY');
        if (data.code === 'WORKING_TREE_DIRTY') {
          expect(data.localChanges).toEqual(['file.txt']);
          expect(data.untracked).toEqual([]);
        }
      });
    });
  });

  describe('Given only an untracked file squatting a theirs-only add during a conflicting merge', () => {
    describe('When merge', () => {
      it('Then it refuses with the path in untracked and localChanges empty', async () => {
        // Arrange — file.txt conflicts (both sides change), theirs also adds
        // m.txt; an untracked m.txt squats it. file.txt is NOT drifted, so only
        // the untracked branch fires.
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file.txt`, 'a\nb\nc\n');
        await add(ctx, ['file.txt']);
        await commit(ctx, { message: 'base', author });
        await branchCreate(ctx, { name: 'theirs' });
        await checkout(ctx, { rev: 'theirs' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file.txt`, 'a\nY\nc\n');
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/m.txt`, 'theirs-m\n');
        await add(ctx, ['file.txt', 'm.txt']);
        await commit(ctx, { message: 'theirs-edit-and-add', author });
        await checkout(ctx, { rev: 'main' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file.txt`, 'a\nX\nc\n');
        await add(ctx, ['file.txt']);
        await commit(ctx, { message: 'ours-edit', author });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/m.txt`, 'untracked\n');

        // Act
        let error: unknown;
        try {
          await mergeRun(ctx, { rev: 'theirs', author });
        } catch (caught) {
          error = caught;
        }

        // Assert — untracked carries m.txt; localChanges is empty.
        const data = (error as TsgitError).data;
        expect(data.code).toBe('WORKING_TREE_DIRTY');
        if (data.code === 'WORKING_TREE_DIRTY') {
          expect(data.untracked).toEqual(['m.txt']);
          expect(data.localChanges).toEqual([]);
        }
        expect(await ctx.fs.readUtf8(`${ctx.layout.workDir}/m.txt`)).toBe('untracked\n');
      });
    });
  });

  describe('Given a dirty file the conflicting merge does not touch', () => {
    describe('When merge', () => {
      it('Then it does not refuse, the conflict materialises and MERGE_HEAD is written', async () => {
        // Arrange — file.txt conflicts; untouched.txt exists on both sides
        // unchanged and is drifted dirty. The guard must NOT fire on it (M3).
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file.txt`, 'a\nb\nc\n');
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/untouched.txt`, 'keep\n');
        await add(ctx, ['file.txt', 'untouched.txt']);
        await commit(ctx, { message: 'base', author });
        await branchCreate(ctx, { name: 'theirs' });
        await checkout(ctx, { rev: 'theirs' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file.txt`, 'a\nY\nc\n');
        await add(ctx, ['file.txt']);
        await commit(ctx, { message: 'theirs-edit', author });
        await checkout(ctx, { rev: 'main' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file.txt`, 'a\nX\nc\n');
        await add(ctx, ['file.txt']);
        await commit(ctx, { message: 'ours-edit', author });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/untouched.txt`, 'DRIFTED\n');

        // Act
        const result = await mergeRun(ctx, { rev: 'theirs', author });

        // Assert — the guard does not over-fire: the conflict materialises and
        // MERGE_HEAD is written (the untouched path is outside changedPaths),
        // and the dirty bytes at the untouched path survive untouched.
        expect(result.kind).toBe('conflict');
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/MERGE_HEAD`)).toBe(true);
        expect(await ctx.fs.readUtf8(`${ctx.layout.workDir}/untouched.txt`)).toBe('DRIFTED\n');
      });
    });
  });

  describe('Given a non-overlapping content change to the same file on each side', () => {
    describe('When merge', () => {
      it('Then merged content combines both edits', async () => {
        // Arrange — base file has 3 lines. Each side modifies a different line.
        // mergeContent should produce a clean merge with both edits.
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file.txt`, 'line1\nline2\nline3\n');
        await add(ctx, ['file.txt']);
        await commit(ctx, { message: 'base', author });
        await branchCreate(ctx, { name: 'feature' });
        await checkout(ctx, { rev: 'feature' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file.txt`, 'line1\nline2\nFEATURE\n');
        await add(ctx, ['file.txt']);
        await commit(ctx, { message: 'on-feature', author });
        await checkout(ctx, { rev: 'main' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file.txt`, 'MAIN\nline2\nline3\n');
        await add(ctx, ['file.txt']);
        await commit(ctx, { message: 'on-main', author });

        // Act
        const result = await mergeRun(ctx, { rev: 'feature', author });

        // Assert — merged content combines both line edits.
        expect(result.kind).toBe('merge');
        if (result.kind !== 'merge') throw new Error('expected merge kind');
        const mergeCommit = await readObject(ctx, result.id);
        if (mergeCommit.type !== 'commit') throw new Error('not a commit');
        const mergedTree = (await readObject(ctx, mergeCommit.data.tree)) as Tree;
        const fileEntry = mergedTree.entries.find((e) => e.name === 'file.txt');
        expect(fileEntry).toBeDefined();
        const blob = await readBlob(ctx, fileEntry?.id as ObjectId);
        const content = new TextDecoder().decode(blob.content);
        expect(content).toBe('MAIN\nline2\nFEATURE\n');
      });
    });
  });

  describe('Given conflicting modifications to the same file', () => {
    describe('When merge runs', () => {
      it('Then returns kind=conflict with the conflicting path and HEAD does NOT advance', async () => {
        // Arrange — same file, divergent content on the same lines.
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file.txt`, 'shared\n');
        await add(ctx, ['file.txt']);
        const baseCommit = await commit(ctx, { message: 'base', author });
        await branchCreate(ctx, { name: 'feature' });
        await checkout(ctx, { rev: 'feature' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file.txt`, 'FEATURE-CHANGE\n');
        await add(ctx, ['file.txt']);
        await commit(ctx, { message: 'on-feature', author });
        await checkout(ctx, { rev: 'main' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file.txt`, 'MAIN-CHANGE\n');
        await add(ctx, ['file.txt']);
        const mainTip = await commit(ctx, { message: 'on-main', author });

        // Act
        const result = await mergeRun(ctx, { rev: 'feature', author });

        // Assert — kind='conflict' with path + type + heads.
        expect(result.kind).toBe('conflict');
        if (result.kind !== 'conflict') throw new Error('expected conflict kind');
        expect(result.conflicts).toHaveLength(1);
        expect(result.conflicts[0]?.path).toBe('file.txt');
        expect(result.conflicts[0]?.type).toBe('content');
        expect(result.origHead).toBe(mainTip.id);
        expect(result.mergeHead).not.toBe(baseCommit.id); // points at the feature tip

        // Also confirm HEAD did NOT advance (the conflicting merge must not commit).
        const main = await resolveRef(ctx, 'refs/heads/main' as RefName);
        const mainHeadCommit = await readObject(ctx, main);
        if (mainHeadCommit.type !== 'commit') throw new Error('not a commit');
        expect(mainHeadCommit.data.message).toBe('on-main\n'); // still pre-merge tip
        expect(mainHeadCommit.data.parents).toHaveLength(1); // not a merge commit
      });
    });
  });

  describe('Given a merge where one side deletes a file the other unchanged', () => {
    describe('When merge', () => {
      it('Then the merged tree omits the deleted file', async () => {
        // Arrange — base has a.txt + b.txt. Feature deletes a.txt. Main is
        // unchanged. The merge result should have b.txt only — exercising
        // the resolved-deleted branch of collectLeaves.
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/b.txt`, 'b');
        await add(ctx, ['a.txt', 'b.txt']);
        await commit(ctx, { message: 'base', author });
        await branchCreate(ctx, { name: 'feature' });
        await checkout(ctx, { rev: 'feature' });
        // Remove a.txt by re-staging an empty list — use rm command surface.
        const { rm } = await import('../../../../src/application/commands/rm.js');
        await rm(ctx, ['a.txt']);
        await commit(ctx, { message: 'feature-delete', author });
        await checkout(ctx, { rev: 'main' });
        // Advance main without touching a.txt or b.txt so they're force-unchanged.
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/c.txt`, 'c');
        await add(ctx, ['c.txt']);
        await commit(ctx, { message: 'on-main', author });

        // Act
        const result = await mergeRun(ctx, { rev: 'feature', author });

        // Assert — merged tree has b.txt (unchanged) + c.txt (added on main),
        // but a.txt is GONE (resolved-deleted on feature's side).
        expect(result.kind).toBe('merge');
        if (result.kind !== 'merge') throw new Error('expected merge kind');
        const mergeCommit = await readObject(ctx, result.id);
        if (mergeCommit.type !== 'commit') throw new Error('not a commit');
        const mergedTree = (await readObject(ctx, mergeCommit.data.tree)) as Tree;
        const names = mergedTree.entries.map((e) => e.name).sort();
        expect(names).toEqual(['b.txt', 'c.txt']);
      });
    });
  });

  describe('Given a clean merge with multiple top-level subdirectories on each side', () => {
    describe('When merge', () => {
      it('Then writeNestedTree resolves all subdirs in parallel and produces correct nested trees', async () => {
        // Arrange — feature and main each add files under DIFFERENT top-level
        // directories. The merged root must have >= 2 top-level subdirs so
        // the root-level Promise.all over `subdirs` is genuinely exercised
        // with multi-element parallelism (a mutation swapping Promise.all
        // for a serial for-await loop would survive single-subdir test).
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/src/base.ts`, 'base');
        await add(ctx, ['src/base.ts']);
        await commit(ctx, { message: 'base', author });
        await branchCreate(ctx, { name: 'feature' });
        await checkout(ctx, { rev: 'feature' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/src/feature/a.ts`, 'a');
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/lib/x.ts`, 'x');
        await add(ctx, ['src/feature/a.ts', 'lib/x.ts']);
        await commit(ctx, { message: 'on-feature', author });
        await checkout(ctx, { rev: 'main' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/src/main/b.ts`, 'b');
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/pkg/y.ts`, 'y');
        await add(ctx, ['src/main/b.ts', 'pkg/y.ts']);
        await commit(ctx, { message: 'on-main', author });

        // Act
        const result = await mergeRun(ctx, { rev: 'feature', author });

        // Assert — merged root has THREE top-level subdirs: src, lib, pkg.
        expect(result.kind).toBe('merge');
        if (result.kind !== 'merge') throw new Error('expected merge kind');
        const mergeCommit = await readObject(ctx, result.id);
        if (mergeCommit.type !== 'commit') throw new Error('not a commit');
        const root = (await readObject(ctx, mergeCommit.data.tree)) as Tree;
        const rootNames = root.entries.map((e) => e.name).sort();
        expect(rootNames).toEqual(['lib', 'pkg', 'src']);
        // And src/ has feature/ + main/ + base.ts — nested depth-2 parallelism.
        const srcEntry = root.entries.find((e) => e.name === 'src');
        if (srcEntry === undefined) throw new Error('expected src entry');
        const src = (await readObject(ctx, srcEntry.id)) as Tree;
        const srcNames = src.entries.map((e) => e.name).sort();
        expect(srcNames).toEqual(['base.ts', 'feature', 'main']);
      });
    });
  });

  describe('Given unrelated histories sharing a path with divergent content', () => {
    describe('When merge', () => {
      it('Then add-add conflict surfaces (proves baseFlat is undefined, not silently substituted)', async () => {
        // Arrange — both unrelated roots write `shared.txt` with DIFFERENT
        // content. With `baseFlat = undefined` (the correct behaviour for
        // unrelated histories), `mergeTrees` falls into `resolveAddAdd`
        // which fires `add-add` conflict for divergent entries — exactly
        // what we want to assert.
        //
        // If a mutation substituted ourTree (or theirTree) as a stand-in for
        // baseFlat, the path would match the substituted "base" on one side,
        // resolve via the `oneSideAbsent / unchanged` path, and produce a
        // silent clean merge. So asserting the conflict throw discriminates
        // the `undefined` branch from any "silent substitution" mutation.
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/shared.txt`, 'main-version\n');
        await add(ctx, ['shared.txt']);
        await commit(ctx, { message: 'main-root', author });

        // Build an unrelated commit chain with a divergent shared.txt.
        const { writeObject } = await import(
          '../../../../src/application/primitives/write-object.js'
        );
        const { writeTree } = await import('../../../../src/application/primitives/write-tree.js');
        const { createCommit } = await import(
          '../../../../src/application/primitives/create-commit.js'
        );
        const { updateRef } = await import('../../../../src/application/primitives/update-ref.js');
        const { FILE_MODE } = await import('../../../../src/domain/objects/file-mode.js');
        const otherBlobId = await writeObject(ctx, {
          type: 'blob',
          content: new TextEncoder().encode('unrelated-version\n'),
          id: '' as ObjectId,
        });
        const otherTreeId = await writeTree(ctx, [
          treeEntry(FILE_MODE.REGULAR, 'shared.txt' as never, otherBlobId),
        ]);
        const otherCommitId = await createCommit(ctx, {
          tree: otherTreeId,
          parents: [],
          author,
          committer: author,
          message: 'unrelated-root',
          extraHeaders: [],
        });
        await updateRef(ctx, 'refs/heads/unrelated' as RefName, otherCommitId, {
          reflogMessage: 'branch: Created from seed',
        });

        // Act
        const result = await mergeRun(ctx, {
          rev: 'unrelated',
          author,
          allowUnrelatedHistories: true,
        });

        // Assert — kind='conflict' with add-add for shared.txt.
        expect(result.kind).toBe('conflict');
        if (result.kind !== 'conflict') throw new Error('expected conflict kind');
        expect(result.conflicts).toHaveLength(1);
        expect(result.conflicts[0]?.path).toBe('shared.txt');
        expect(result.conflicts[0]?.type).toBe('add-add');
      });
    });
  });

  describe("Given diverged histories + fastForward='only'", () => {
    describe('When merge', () => {
      it('Then throws NON_FAST_FORWARD carrying the ref + both tips', async () => {
        // Arrange — diverge: both branches advance from a common base.
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
        await add(ctx, ['a.txt']);
        await commit(ctx, { message: 'base', author });
        await branchCreate(ctx, { name: 'feature' });
        await checkout(ctx, { rev: 'feature' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/b.txt`, 'b');
        await add(ctx, ['b.txt']);
        const featureTip = await commit(ctx, { message: 'on-feature', author });
        await checkout(ctx, { rev: 'main' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/c.txt`, 'c');
        await add(ctx, ['c.txt']);
        const mainTip = await commit(ctx, { message: 'on-main', author });

        // Act
        let caught: unknown;
        try {
          await mergeRun(ctx, { rev: 'feature', fastForward: 'only' });
        } catch (err) {
          caught = err;
        }

        // Assert
        const data = (
          caught as { data?: { code?: string; ref?: string; local?: string; remote?: string } }
        )?.data;
        expect(data?.code).toBe('NON_FAST_FORWARD');
        expect(data?.ref).toBe('refs/heads/main');
        expect(data?.local).toBe(mainTip.id);
        expect(data?.remote).toBe(featureTip.id);
      });
    });
  });
});

describe('merge.4b conflict persistence', () => {
  const setupConflictingMerge = async (
    ctx: ReturnType<typeof createMemoryContext>,
  ): Promise<{ readonly preMergeMain: ObjectId; readonly featureTip: ObjectId }> => {
    await init(ctx);
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file.txt`, 'base\n');
    await add(ctx, ['file.txt']);
    await commit(ctx, { message: 'base', author });
    await branchCreate(ctx, { name: 'feature' });
    await checkout(ctx, { rev: 'feature' });
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file.txt`, 'FEATURE\n');
    await add(ctx, ['file.txt']);
    const featureTip = await commit(ctx, { message: 'on-feature', author });
    await checkout(ctx, { rev: 'main' });
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file.txt`, 'MAIN\n');
    await add(ctx, ['file.txt']);
    const mainTip = await commit(ctx, { message: 'on-main', author });
    return { preMergeMain: mainTip.id, featureTip: featureTip.id };
  };

  describe('Given a content conflict beside a path both sides edit in different hunks', () => {
    describe('When merge runs', () => {
      it('Then the line-merged path is staged at stage 0 with its merged blob', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const commitBoth = async (conflicting: string, merged: string, message: string) => {
          await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file.txt`, conflicting);
          await ctx.fs.writeUtf8(`${ctx.layout.workDir}/merged.txt`, merged);
          await add(ctx, ['file.txt', 'merged.txt']);
          await commit(ctx, { message, author });
        };
        await init(ctx);
        await commitBoth('base\n', 'a\nb\nc\n', 'base');
        await branchCreate(ctx, { name: 'feature' });
        await checkout(ctx, { rev: 'feature' });
        await commitBoth('FEATURE\n', 'a\nb\nC\n', 'on-feature');
        await checkout(ctx, { rev: 'main' });
        await commitBoth('MAIN\n', 'A\nb\nc\n', 'on-main');
        const mergedId = await writeObject(ctx, {
          type: 'blob',
          content: new TextEncoder().encode('A\nb\nC\n'),
          id: '' as ObjectId,
        });

        // Act
        await mergeRun(ctx, { rev: 'feature', author });

        // Assert
        const result = (await readIndex(ctx)).entries.find((e) => e.path === 'merged.txt');
        expect(result?.flags.stage).toBe(0);
        expect(result?.id).toBe(mergedId);
      });
    });
  });

  describe('Given a content conflict', () => {
    describe('When merge runs', () => {
      it('Then the working-tree file contains the <<<<<<< / ======= / >>>>>>> marker block', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await setupConflictingMerge(ctx);

        // Act
        await mergeRun(ctx, { rev: 'feature', author });

        // Assert
        const result = await ctx.fs.readUtf8(`${ctx.layout.workDir}/file.txt`);
        expect(result).toContain('<<<<<<<');
        expect(result).toContain('=======');
        expect(result).toContain('>>>>>>>');
        expect(result).toContain('MAIN');
        expect(result).toContain('FEATURE');
      });
      it('Then the open marker is labelled HEAD and the close marker the merged rev', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await setupConflictingMerge(ctx);

        // Act
        await mergeRun(ctx, { rev: 'feature', author });

        // Assert
        const result = await ctx.fs.readUtf8(`${ctx.layout.workDir}/file.txt`);
        expect(result).toContain('<<<<<<< HEAD\n');
        expect(result).toContain('>>>>>>> feature\n');
      });
      it('Then .git/MERGE_HEAD records the target tip id', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const { featureTip } = await setupConflictingMerge(ctx);

        // Act
        await mergeRun(ctx, { rev: 'feature', author });

        // Assert — exact content (id + LF), kills mutants that drop LF or
        // record the wrong id.
        const result = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/MERGE_HEAD`);
        expect(result).toBe(`${featureTip}\n`);
      });
      it('Then .git/ORIG_HEAD records the pre-merge HEAD id', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const { preMergeMain } = await setupConflictingMerge(ctx);

        // Act
        await mergeRun(ctx, { rev: 'feature', author });

        // Assert
        const result = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/ORIG_HEAD`);
        expect(result).toBe(`${preMergeMain}\n`);
      });
      it('Then the index has stage-1, stage-2, and stage-3 entries for the conflicting path', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await setupConflictingMerge(ctx);

        // Act
        await mergeRun(ctx, { rev: 'feature', author });

        // Assert
        const { readIndex } = await import('../../../../src/application/primitives/read-index.js');
        const result = await readIndex(ctx);
        const fileEntries = result.entries.filter((e) => e.path === 'file.txt');
        const stages = fileEntries.map((e) => e.flags.stage).sort();
        expect(stages).toEqual([1, 2, 3]);
      });
    });
    describe('When merge runs with a message', () => {
      it('Then .git/MERGE_MSG records the message, then the conflicted paths block', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await setupConflictingMerge(ctx);

        // Act
        await mergeRun(ctx, { rev: 'feature', author, message: 'Merge feature into main' });

        // Assert
        const result = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/MERGE_MSG`);
        expect(result).toBe('Merge feature into main\n\n# Conflicts:\n#\tfile.txt\n');
      });
    });
  });

  describe('Given a conflicting merge with a clean theirs-only-changed sibling path', () => {
    describe('When merge runs', () => {
      it('Then the clean sibling is materialised in the working tree with theirs content', async () => {
        // Arrange — file.txt conflicts (both sides change it); clean.txt is
        // changed by theirs ONLY and is NOT dirty in the working tree (ours
        // never touched it, so it still holds the base bytes). The conflict
        // writer must still materialise this clean, theirs-only-changed path.
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file.txt`, 'a\nb\nc\n');
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/clean.txt`, 'base-clean\n');
        await add(ctx, ['file.txt', 'clean.txt']);
        await commit(ctx, { message: 'base', author });
        await branchCreate(ctx, { name: 'theirs' });
        await checkout(ctx, { rev: 'theirs' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file.txt`, 'a\nY\nc\n');
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/clean.txt`, 'THEIRS-CLEAN\n');
        await add(ctx, ['file.txt', 'clean.txt']);
        await commit(ctx, { message: 'theirs-edit-both', author });
        await checkout(ctx, { rev: 'main' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file.txt`, 'a\nX\nc\n');
        await add(ctx, ['file.txt']);
        await commit(ctx, { message: 'ours-edit-file-only', author });

        // Act — conflicting merge: file.txt conflicts, clean.txt resolves to theirs.
        const result = await mergeRun(ctx, { rev: 'theirs', author });

        // Assert — the merge conflicts on file.txt yet the clean, theirs-only
        // sibling is written to the working tree with theirs bytes (the base
        // bytes are gone). Under a neutered conflict-writer filter the sibling
        // would still read 'base-clean\n'.
        expect(result.kind).toBe('conflict');
        expect(await ctx.fs.readUtf8(`${ctx.layout.workDir}/clean.txt`)).toBe('THEIRS-CLEAN\n');
      });
    });
  });

  describe('Given a resolved content conflict', () => {
    describe('When add + commit run', () => {
      it('Then a merge commit is created with two parents (origHead + mergeHead)', async () => {
        // Arrange — merge produces conflict; user resolves by overwriting the
        // file and running add + commit. The resulting commit must have
        // parents=[preMergeMain, featureTip].
        const ctx = createMemoryContext();
        const { preMergeMain, featureTip } = await setupConflictingMerge(ctx);
        await mergeRun(ctx, { rev: 'feature', author });

        // Act — manual resolution.
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file.txt`, 'RESOLVED\n');
        await add(ctx, ['file.txt']);
        const result = await commit(ctx, { message: 'resolved merge', author });

        // Assert — two parents in the right order.
        expect(result.parents).toEqual([preMergeMain, featureTip]);

        // Verify the merge-state markers were cleared (recovery aid ORIG_HEAD
        // remains; MERGE_HEAD and MERGE_MSG are gone).
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/MERGE_HEAD`)).toBe(false);
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/MERGE_MSG`)).toBe(false);
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/ORIG_HEAD`)).toBe(true);
      });
    });
  });

  describe('Given a conflicting merge already in progress', () => {
    describe('When merge is called again', () => {
      it('Then throws OPERATION_IN_PROGRESS', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await setupConflictingMerge(ctx);
        await mergeRun(ctx, { rev: 'feature', author });

        // Act / Assert
        let caught: unknown;
        try {
          await mergeRun(ctx, { rev: 'feature', author });
        } catch (err) {
          caught = err;
        }
        const data = (caught as { data?: { code?: string; operation?: string } })?.data;
        // Assert
        expect(data?.code).toBe('OPERATION_IN_PROGRESS');
        expect(data?.operation).toBe('merge');
      });
    });
  });

  describe('Given an unmerged index', () => {
    describe('When commit runs without resolving', () => {
      it('Then throws MERGE_HAS_CONFLICTS', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await setupConflictingMerge(ctx);
        await mergeRun(ctx, { rev: 'feature', author });

        // Act / Assert — user tries to commit BEFORE running `add` on the
        // resolved file; the unmerged stage-1/2/3 entries remain.
        let caught: unknown;
        try {
          await commit(ctx, { message: 'cannot commit', author });
        } catch (err) {
          caught = err;
        }
        const data = (caught as { data?: { code?: string; count?: number } })?.data;
        // Assert
        expect(data?.code).toBe('MERGE_HAS_CONFLICTS');
        expect(data?.count).toBe(1);
      });
    });
  });

  describe('rejectUnsupportedConflicts (direct)', () => {
    describe.each(['rename-rename', 'rename-delete'] as const)(
      'Given a %s MergeConflict',
      (type) => {
        describe('When rejectUnsupportedConflicts is called', () => {
          it('Then it is accepted, as git stops on it', async () => {
            // Arrange
            const { rejectUnsupportedConflicts } = await import(
              '../../../../src/application/commands/merge.js'
            );
            const sut = rejectUnsupportedConflicts;

            // Act
            const result = (): void => sut([{ type, path: 'p' as never }]);

            // Assert
            expect(result).not.toThrow();
          });
        });
      },
    );

    describe('Given a %s MergeConflict', () => {
      describe('When rejectUnsupportedConflicts is called', () => {
        it.each(['gitlink'] as const)(
          'Then throws UNSUPPORTED_OPERATION with operation=merge',
          async (conflictType) => {
            // Arrange
            const { rejectUnsupportedConflicts } = await import(
              '../../../../src/application/commands/merge.js'
            );
            const conflict = {
              type: conflictType,
              path: 'sub/path.txt' as never,
            } as never;

            // Act
            let caught: unknown;
            try {
              rejectUnsupportedConflicts([conflict]);
            } catch (err) {
              caught = err;
            }

            // Assert
            const data = (
              caught as { data?: { code?: string; operation?: string; reason?: string } }
            )?.data;
            expect(data?.code).toBe('UNSUPPORTED_OPERATION');
            expect(data?.operation).toBe('merge');
            expect(data?.reason).toContain(conflictType);
            expect(data?.reason).toContain('sub/path.txt');
          },
        );
        it.each([
          'content',
          'add-add',
          'distinct-types',
          'modify-delete',
          'type-change',
          'binary',
        ] as const)('Then does not throw (supported type)', async (conflictType) => {
          // Arrange
          const { rejectUnsupportedConflicts } = await import(
            '../../../../src/application/commands/merge.js'
          );
          const conflict = { type: conflictType, path: 'x.txt' as never } as never;

          // Act / Assert — no throw.
          expect(() => rejectUnsupportedConflicts([conflict])).not.toThrow();
        });
      });
    });

    describe('Given an empty conflicts array', () => {
      describe('When rejectUnsupportedConflicts is called', () => {
        it('Then does not throw', async () => {
          // Arrange
          const { rejectUnsupportedConflicts } = await import(
            '../../../../src/application/commands/merge.js'
          );

          // Act / Assert
          expect(() => rejectUnsupportedConflicts([])).not.toThrow();
        });
      });
    });
  });

  describe('Given a partially-resolved index (one path stage-0, another stage-1/2/3)', () => {
    describe('When commit runs', () => {
      it('Then throws MERGE_HAS_CONFLICTS reporting only the still-unmerged path', async () => {
        // Arrange — start from a multi-conflict setup, resolve ONE path, then
        // attempt to commit. Only the unresolved path should appear in the
        // error's `paths`. Kills `!==` → `===` mutations on
        // rejectUnmergedIndex's stage check, and confirms the set deduplicates
        // stage-1/2/3 entries to a single path.
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file-a.txt`, 'base-a\n');
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file-b.txt`, 'base-b\n');
        await add(ctx, ['file-a.txt', 'file-b.txt']);
        await commit(ctx, { message: 'base', author });
        await branchCreate(ctx, { name: 'feature' });
        await checkout(ctx, { rev: 'feature' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file-a.txt`, 'FEAT-A\n');
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file-b.txt`, 'FEAT-B\n');
        await add(ctx, ['file-a.txt', 'file-b.txt']);
        await commit(ctx, { message: 'on-feature', author });
        await checkout(ctx, { rev: 'main' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file-a.txt`, 'MAIN-A\n');
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file-b.txt`, 'MAIN-B\n');
        await add(ctx, ['file-a.txt', 'file-b.txt']);
        await commit(ctx, { message: 'on-main', author });
        await mergeRun(ctx, { rev: 'feature', author });

        // Resolve only file-a (move stage-1/2/3 to stage-0); leave file-b
        // unmerged.
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file-a.txt`, 'resolved-a\n');
        await add(ctx, ['file-a.txt']);

        // Act / Assert
        let caught: unknown;
        try {
          await commit(ctx, { message: 'partial', author });
        } catch (err) {
          caught = err;
        }
        const data = (
          caught as { data?: { code?: string; count?: number; paths?: ReadonlyArray<string> } }
        )?.data;
        // Assert
        expect(data?.code).toBe('MERGE_HAS_CONFLICTS');
        expect(data?.count).toBe(1);
        expect(data?.paths).toEqual(['file-b.txt']);
      });
    });
  });

  describe('Given a resolved conflict with no MERGE_MSG draft', () => {
    describe('When commit runs with empty message', () => {
      it('Then throws EMPTY_COMMIT_MESSAGE (the empty user message + no draft branch)', async () => {
        // Arrange — set up a conflict, resolve it, manually delete
        // MERGE_MSG to exercise the (c) branch of resolveCommitMessage
        // (empty user message + no MERGE_MSG → sanitizeMessage rejects).
        const ctx = createMemoryContext();
        await setupConflictingMerge(ctx);
        await mergeRun(ctx, { rev: 'feature', author });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file.txt`, 'RESOLVED\n');
        await add(ctx, ['file.txt']);
        await ctx.fs.rm(`${ctx.layout.gitDir}/MERGE_MSG`);

        // Act / Assert
        let caught: unknown;
        try {
          await commit(ctx, { message: '', author });
        } catch (err) {
          caught = err;
        }
        // Assert
        expect((caught as { data?: { code?: string } })?.data?.code).toBe('EMPTY_COMMIT_MESSAGE');
      });
    });
  });

  describe('Given a resolved conflict and an empty commit message', () => {
    describe('When commit runs', () => {
      it('Then the MERGE_MSG draft is used as the commit message', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await setupConflictingMerge(ctx);
        await mergeRun(ctx, { rev: 'feature', author, message: 'Merge feature' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file.txt`, 'RESOLVED\n');
        await add(ctx, ['file.txt']);

        // Act — empty user message; commit should fall back to MERGE_MSG.
        const result = await commit(ctx, { message: '', author });

        // Assert
        const { readObject } = await import(
          '../../../../src/application/primitives/read-object.js'
        );
        const commitObj = await readObject(ctx, result.id);
        if (commitObj.type !== 'commit') throw new Error('not a commit');
        expect(commitObj.data.message).toBe('Merge feature\n');
      });
    });
  });
});

import { asBareContext, recordingProgress, withProgress } from './fixtures.js';

describe('merge — bounded blob reads', () => {
  describe('Given a conflicting merge', () => {
    describe('When the merger runs', () => {
      it('Then ours/theirs/base blob reads OVERLAP at the content-merger phase (parallelism)', async () => {
        // Arrange — set up a conflicting merge so the three blob reads
        // (ours/theirs/base) all happen inside `buildContentMerger`. Pre-
        // compute the three loose-object paths for the conflicting `file.txt`
        // blob on each side; scope the in-flight counter to ONLY those three
        // paths so the earlier `flattenTree` parallel walks (3 tree reads in
        // parallel) don't taint the assertion. A serial mutation of
        // `Promise.all` inside `buildContentMerger` would drop the conflict-
        // blob in-flight count to 1.
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file.txt`, 'base\n');
        await add(ctx, ['file.txt']);
        await commit(ctx, { message: 'base', author });
        await branchCreate(ctx, { name: 'feature' });
        await checkout(ctx, { rev: 'feature' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file.txt`, 'FEATURE\n');
        await add(ctx, ['file.txt']);
        await commit(ctx, { message: 'on-feature', author });
        await checkout(ctx, { rev: 'main' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file.txt`, 'MAIN\n');
        await add(ctx, ['file.txt']);
        await commit(ctx, { message: 'on-main', author });

        // Compute the three blob ids (base/feature/main) then derive their
        // loose-object paths. Only reads to these specific paths bump the
        // counter — flattenTree's tree reads are excluded.
        const { computeLooseObjectPath } = await import(
          '../../../../src/domain/storage/loose-path.js'
        );
        const blobIds = new Set<string>();
        const collectBlob = async (branchName: string): Promise<void> => {
          const tip = await resolveRef(ctx, `refs/heads/${branchName}` as RefName);
          const commitObj = await readObject(ctx, tip);
          if (commitObj.type !== 'commit') throw new Error('not a commit');
          const tree = (await readObject(ctx, commitObj.data.tree)) as Tree;
          const entry = tree.entries.find((e) => e.name === 'file.txt');
          if (entry !== undefined) blobIds.add(entry.id);
        };
        await collectBlob('main');
        await collectBlob('feature');
        // Walk main's parent to grab the base blob id.
        const mainTip = await resolveRef(ctx, 'refs/heads/main' as RefName);
        const mainCommit = await readObject(ctx, mainTip);
        if (mainCommit.type !== 'commit') throw new Error('not a commit');
        const baseCommitId = mainCommit.data.parents[0];
        if (baseCommitId !== undefined) {
          const baseCommit = await readObject(ctx, baseCommitId);
          if (baseCommit.type === 'commit') {
            const baseTree = (await readObject(ctx, baseCommit.data.tree)) as Tree;
            const baseEntry = baseTree.entries.find((e) => e.name === 'file.txt');
            if (baseEntry !== undefined) blobIds.add(baseEntry.id);
          }
        }
        const objectsDir = `${ctx.layout.gitDir}/objects/`;
        const conflictBlobPaths = new Set(
          [...blobIds].map((id) => `${objectsDir}${computeLooseObjectPath(id as ObjectId)}`),
        );

        let inFlight = 0;
        let maxInFlight = 0;
        const originalRead = ctx.fs.read.bind(ctx.fs);
        const originalExists = ctx.fs.exists.bind(ctx.fs);
        const trackConflictBlobOp = async <T>(path: string, op: () => Promise<T>): Promise<T> => {
          if (!conflictBlobPaths.has(path)) return op();
          inFlight += 1;
          if (inFlight > maxInFlight) maxInFlight = inFlight;
          try {
            await Promise.resolve();
            return await op();
          } finally {
            inFlight -= 1;
          }
        };
        (ctx.fs as { read: typeof originalRead }).read = (path: string) =>
          trackConflictBlobOp(path, () => originalRead(path));
        (ctx.fs as { exists: typeof originalExists }).exists = (path: string) =>
          trackConflictBlobOp(path, () => originalExists(path));

        // Act — conflicting merge invokes contentMerger which reads the
        // three blobs via Promise.all. Throws MERGE_HAS_CONFLICTS after.
        try {
          await mergeRun(ctx, { rev: 'feature', author });
        } catch {
          // expected MERGE_HAS_CONFLICTS — irrelevant to the assertion.
        }

        // Assert — at some moment ≥ 2 CONFLICT-BLOB reads were in flight
        // simultaneously. A sequential merger over the three blob ids would
        // never observe inFlight ≥ 2 for THIS scoped set.
        expect(maxInFlight).toBeGreaterThanOrEqual(2);
      });
    });
  });
});

describe('merge — progress reporting', () => {
  describe('Given an up-to-date merge', () => {
    describe('When run', () => {
      it('Then NO progress events fire (early return before start)', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
        await add(ctx, ['a.txt']);
        await commit(ctx, { message: 'm', author });
        const { reporter, events } = recordingProgress();

        // Act
        await mergeRun(withProgress(ctx, reporter), { rev: 'main' });

        // Assert
        expect(events).toEqual([]);
      });
    });
  });

  describe('Given a real merge', () => {
    describe('When run', () => {
      it('Then a merge:write-files end event fires (finally block runs)', async () => {
        // Arrange — diverged histories force a true merge through mergeCommit's
        // try/finally; the `finally { progress.end }` block must emit an `end`.
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
        await add(ctx, ['a.txt']);
        await commit(ctx, { message: 'base', author });
        await branchCreate(ctx, { name: 'feature' });
        await checkout(ctx, { rev: 'feature' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/b.txt`, 'b');
        await add(ctx, ['b.txt']);
        await commit(ctx, { message: 'on-feature', author });
        await checkout(ctx, { rev: 'main' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/c.txt`, 'c');
        await add(ctx, ['c.txt']);
        await commit(ctx, { message: 'on-main', author });
        const { reporter, events } = recordingProgress();

        // Act
        await mergeRun(withProgress(ctx, reporter), { rev: 'feature', author });

        // Assert — both a start and the finally-block end fired for the op.
        expect(events).toContainEqual({ kind: 'start', op: 'merge:write-files' });
        expect(events).toContainEqual({ kind: 'end', op: 'merge:write-files' });
      });
    });
  });
});

describe('merge — guard rails', () => {
  describe('Given a bare repository', () => {
    describe('When merge runs', () => {
      it('Then throws WORK_TREE_REQUIRED with operation=merge', async () => {
        // Arrange
        const ctx0 = createMemoryContext();
        await init(ctx0);
        const ctx = asBareContext(ctx0);

        // Act
        let caught: unknown;
        try {
          await mergeRun(ctx, { rev: 'feature' });
        } catch (err) {
          caught = err;
        }

        // Assert — `operation` carries the literal 'merge'.
        const data = (caught as { data?: { code?: string; operation?: string } })?.data;
        expect(data?.code).toBe('WORK_TREE_REQUIRED');
        expect(data?.operation).toBe('merge');
      });
    });
  });

  describe('Given a detached HEAD diverged from a branch', () => {
    /** HEAD detached at `main`, which diverged from `side`. */
    const seedDetached = async (): Promise<{
      ctx: Context;
      base: ObjectId;
      ours: ObjectId;
      theirs: ObjectId;
    }> => {
      const ctx = createMemoryContext();
      await init(ctx, { initialBranch: 'main' });
      await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
      await add(ctx, ['a.txt']);
      const base = await commit(ctx, { message: 'base', author });
      await branchCreate(ctx, { name: 'side' });
      await checkout(ctx, { rev: 'side' });
      await ctx.fs.writeUtf8(`${ctx.layout.workDir}/s.txt`, 's');
      await add(ctx, ['s.txt']);
      const theirs = await commit(ctx, { message: 'side', author });
      await checkout(ctx, { rev: 'main' });
      await ctx.fs.writeUtf8(`${ctx.layout.workDir}/m.txt`, 'm');
      await add(ctx, ['m.txt']);
      const ours = await commit(ctx, { message: 'main', author });
      await checkout(ctx, { rev: ours.id });
      return { ctx, base: base.id, ours: ours.id, theirs: theirs.id };
    };

    describe('When merge is given the branch', () => {
      it('Then HEAD stays detached at the two-parent merge commit', async () => {
        // Arrange
        const { ctx, ours, theirs } = await seedDetached();
        const sut = mergeRun;

        // Act
        const result = await sut(ctx, { rev: 'side', author, committer: author });

        // Assert
        expect(result).toEqual({
          kind: 'merge',
          id: expect.any(String),
          branch: undefined,
          parents: [ours, theirs],
        });
        const head = await getRefStore(ctx).resolveDirect('HEAD' as RefName);
        expect(head).toEqual({ kind: 'direct', id: (result as { id: ObjectId }).id });
      });

      it("Then the commit is titled into HEAD and HEAD logs git's merge note", async () => {
        // Arrange
        const { ctx } = await seedDetached();
        const sut = mergeRun;

        // Act
        const result = await sut(ctx, { rev: 'side', author, committer: author });

        // Assert
        const made = await readObject(ctx, (result as { id: ObjectId }).id);
        expect(made.type === 'commit' && made.data.message).toBe("Merge branch 'side' into HEAD\n");
        expect((await readReflog(ctx, 'HEAD' as RefName)).at(-1)?.message).toBe(
          "merge side: Merge made by the 'ort' strategy.",
        );
      });
    });

    describe('When merge fast-forwards to the branch', () => {
      it('Then HEAD moves detached and logs the fast-forward', async () => {
        // Arrange
        const { ctx, base, theirs } = await seedDetached();
        await checkout(ctx, { rev: base });
        const sut = mergeRun;

        // Act
        const result = await sut(ctx, { rev: 'side' });

        // Assert
        expect(result).toEqual({ kind: 'fast-forward', id: theirs, branch: undefined });
        const head = await getRefStore(ctx).resolveDirect('HEAD' as RefName);
        expect(head).toEqual({ kind: 'direct', id: theirs });
        expect((await readReflog(ctx, 'HEAD' as RefName)).at(-1)?.message).toBe(
          'merge side: Fast-forward',
        );
      });
    });

    describe('When merge is told fast-forward only', () => {
      it('Then it refuses NON_FAST_FORWARD on HEAD', async () => {
        // Arrange
        const { ctx, ours, theirs } = await seedDetached();
        const sut = mergeRun;

        // Act
        let caught: unknown;
        try {
          await sut(ctx, { rev: 'side', fastForward: 'only' });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect((caught as TsgitError).data).toEqual({
          code: 'NON_FAST_FORWARD',
          ref: 'HEAD',
          local: ours,
          remote: theirs,
        });
      });
    });

    describe('When merge.suppressDest names HEAD', () => {
      it('Then the title drops the destination', async () => {
        // Arrange
        const { ctx } = await seedDetached();
        const configPath = `${ctx.layout.gitDir}/config`;
        const config = await ctx.fs.readUtf8(configPath);
        await ctx.fs.writeUtf8(configPath, `${config}[merge]\n  suppressDest = HEAD\n`);
        const sut = mergeRun;

        // Act
        const result = await sut(ctx, { rev: 'side', author, committer: author });

        // Assert
        const made = await readObject(ctx, (result as { id: ObjectId }).id);
        expect(made.type === 'commit' && made.data.message).toBe("Merge branch 'side'\n");
      });
    });
  });

  describe('Given a target that is a strict ancestor branch of HEAD', () => {
    describe('When merge runs', () => {
      it('Then result.kind=up-to-date (base===theirId short-circuit)', async () => {
        // Arrange — main advances two commits; `old` branch stays at the first.
        // The merge target `old` is a STRICT ancestor: base===theirId but
        // base!==ourId, so only the `base === theirId` guard catches it.
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
        await add(ctx, ['a.txt']);
        await commit(ctx, { message: 'first', author });
        await branchCreate(ctx, { name: 'old' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/b.txt`, 'b');
        await add(ctx, ['b.txt']);
        const second = await commit(ctx, { message: 'second', author });

        // Act
        const result = await mergeRun(ctx, { rev: 'old', author });

        // Assert — up-to-date, NOT a fresh merge commit.
        expect(result.kind).toBe('up-to-date');
        if (result.kind !== 'up-to-date') throw new Error('expected up-to-date');
        expect(result.id).toBe(second.id);
      });
    });
  });

  describe('Given a clean merge with an empty message', () => {
    describe('When merge runs', () => {
      it('Then throws EMPTY_COMMIT_MESSAGE (allowEmpty=false)', async () => {
        // Arrange — diverged histories so a true clean merge is attempted.
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
        await add(ctx, ['a.txt']);
        await commit(ctx, { message: 'base', author });
        await branchCreate(ctx, { name: 'feature' });
        await checkout(ctx, { rev: 'feature' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/b.txt`, 'b');
        await add(ctx, ['b.txt']);
        await commit(ctx, { message: 'on-feature', author });
        await checkout(ctx, { rev: 'main' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/c.txt`, 'c');
        await add(ctx, ['c.txt']);
        await commit(ctx, { message: 'on-main', author });

        // Act
        let caught: unknown;
        try {
          await mergeRun(ctx, { rev: 'feature', author, message: '' });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect((caught as { data?: { code?: string } })?.data?.code).toBe('EMPTY_COMMIT_MESSAGE');
      });
    });
  });

  describe('Given a conflicting merge with an empty message', () => {
    describe('When merge runs', () => {
      it('Then throws EMPTY_COMMIT_MESSAGE (allowEmpty=false on the conflict path)', async () => {
        // Arrange — a content conflict so persistConflictState's sanitizeMessage runs.
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file.txt`, 'base\n');
        await add(ctx, ['file.txt']);
        await commit(ctx, { message: 'base', author });
        await branchCreate(ctx, { name: 'feature' });
        await checkout(ctx, { rev: 'feature' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file.txt`, 'FEATURE\n');
        await add(ctx, ['file.txt']);
        await commit(ctx, { message: 'on-feature', author });
        await checkout(ctx, { rev: 'main' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file.txt`, 'MAIN\n');
        await add(ctx, ['file.txt']);
        await commit(ctx, { message: 'on-main', author });

        // Act
        let caught: unknown;
        try {
          await mergeRun(ctx, { rev: 'feature', author, message: '' });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect((caught as { data?: { code?: string } })?.data?.code).toBe('EMPTY_COMMIT_MESSAGE');
      });
    });
  });

  describe('Given a clean merge', () => {
    describe('When merge runs', () => {
      it('Then the merge commit object records both parents', async () => {
        // Arrange — diverged histories; assert the commit OBJECT's parents
        // (commitData.parents), not just the result envelope.
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
        await add(ctx, ['a.txt']);
        await commit(ctx, { message: 'base', author });
        const preMain = await resolveRef(ctx, 'refs/heads/main' as RefName);
        await branchCreate(ctx, { name: 'feature' });
        await checkout(ctx, { rev: 'feature' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/b.txt`, 'b');
        await add(ctx, ['b.txt']);
        const featureTip = await commit(ctx, { message: 'on-feature', author });
        await checkout(ctx, { rev: 'main' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/c.txt`, 'c');
        await add(ctx, ['c.txt']);
        const mainTip = await commit(ctx, { message: 'on-main', author });

        // Act
        const result = await mergeRun(ctx, { rev: 'feature', author });

        // Assert — exactly [ourId, theirId]; not an empty parents array.
        expect(result.kind).toBe('merge');
        if (result.kind !== 'merge') throw new Error('expected merge kind');
        const mergeCommit = await readObject(ctx, result.id);
        if (mergeCommit.type !== 'commit') throw new Error('not a commit');
        expect(mergeCommit.data.parents).toEqual([mainTip.id, featureTip.id]);
        expect(mergeCommit.data.parents).not.toEqual([]);
        expect(preMain).not.toBe(mainTip.id);
      });
    });
  });
});

describe('merge — updateRef CAS guard', () => {
  // Patch readUtf8 so the SECOND read of `refs/heads/main` (the updateRef
  // CAS read) returns a fabricated id, simulating a concurrent ref move.
  // resolveRef reads it once first; the CAS reads it again.
  const patchStaleMainRef = (ctx: ReturnType<typeof createMemoryContext>): void => {
    const refPath = `${ctx.layout.gitDir}/refs/heads/main`;
    const staleId = '1'.repeat(40);
    let mainReads = 0;
    const original = ctx.fs.openWithNoFollow.bind(ctx.fs);
    (ctx.fs as { openWithNoFollow: typeof original }).openWithNoFollow = async (path, mode) => {
      if (path !== refPath) return original(path, mode);
      mainReads += 1;
      if (mainReads > 1) await ctx.fs.writeUtf8(refPath, `${staleId}\n`);
      return original(path, mode);
    };
  };

  describe('Given the branch ref moved before a fast-forward updateRef', () => {
    describe('When merge runs', () => {
      it('Then throws REF_UPDATE_CONFLICT (expected guard)', async () => {
        // Arrange — fast-forward setup.
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
        await add(ctx, ['a.txt']);
        await commit(ctx, { message: 'first', author });
        await branchCreate(ctx, { name: 'feature' });
        await checkout(ctx, { rev: 'feature' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/b.txt`, 'b');
        await add(ctx, ['b.txt']);
        await commit(ctx, { message: 'second', author });
        await checkout(ctx, { rev: 'main' });
        patchStaleMainRef(ctx);

        // Act
        let caught: unknown;
        try {
          await mergeRun(ctx, { rev: 'feature' });
        } catch (err) {
          caught = err;
        }

        // Assert — the `{ expected: ourId }` CAS rejects the stale ref.
        expect((caught as { data?: { code?: string } })?.data?.code).toBe('REF_UPDATE_CONFLICT');
      });
    });
  });

  describe('Given the branch ref moved before a clean-merge updateRef', () => {
    describe('When merge runs', () => {
      it('Then throws REF_UPDATE_CONFLICT (expected guard)', async () => {
        // Arrange — diverged histories → clean merge → commitCleanMerge's updateRef.
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
        await add(ctx, ['a.txt']);
        await commit(ctx, { message: 'base', author });
        await branchCreate(ctx, { name: 'feature' });
        await checkout(ctx, { rev: 'feature' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/b.txt`, 'b');
        await add(ctx, ['b.txt']);
        await commit(ctx, { message: 'on-feature', author });
        await checkout(ctx, { rev: 'main' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/c.txt`, 'c');
        await add(ctx, ['c.txt']);
        await commit(ctx, { message: 'on-main', author });
        patchStaleMainRef(ctx);

        // Act
        let caught: unknown;
        try {
          await mergeRun(ctx, { rev: 'feature', author });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect((caught as { data?: { code?: string } })?.data?.code).toBe('REF_UPDATE_CONFLICT');
      });
    });
  });

  describe('Given a working-tree write fails mid conflict-persist', () => {
    describe('When merge runs', () => {
      it('Then the index lock is released so a retry is not RESOURCE_LOCKED', async () => {
        // Arrange — a content conflict; patch fs.write to throw on the
        // working-tree conflict file the FIRST time so writeConflictingWorkingTree
        // fails inside persistConflictState's try. The finally block must
        // release the index lock.
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file.txt`, 'base\n');
        await add(ctx, ['file.txt']);
        await commit(ctx, { message: 'base', author });
        await branchCreate(ctx, { name: 'feature' });
        await checkout(ctx, { rev: 'feature' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file.txt`, 'FEATURE\n');
        await add(ctx, ['file.txt']);
        await commit(ctx, { message: 'on-feature', author });
        await checkout(ctx, { rev: 'main' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file.txt`, 'MAIN\n');
        await add(ctx, ['file.txt']);
        await commit(ctx, { message: 'on-main', author });

        const conflictFile = `${ctx.layout.workDir}/file.txt`;
        const originalWrite = ctx.fs.write.bind(ctx.fs);
        let failOnce = true;
        (ctx.fs as { write: typeof originalWrite }).write = async (path, data) => {
          if (failOnce && path === conflictFile) {
            failOnce = false;
            throw new Error('injected working-tree write failure');
          }
          return originalWrite(path, data);
        };

        // Act — first merge fails mid-persist; lock must be released by finally.
        let firstError: unknown;
        try {
          await mergeRun(ctx, { rev: 'feature', author });
        } catch (err) {
          firstError = err;
        }

        // Assert — first merge threw the injected error, AND the lock file is gone.
        expect((firstError as Error)?.message).toBe('injected working-tree write failure');
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/index.lock`)).toBe(false);
      });
    });
  });
});

describe('merge — conflicting-write atomicity', () => {
  describe('Given a conflicting merge where one changed path is hostile and a sibling path is clean', () => {
    describe('When merge runs', () => {
      it('Then throws INVALID_INDEX_ENTRY and the clean sibling is never written', async () => {
        // Arrange — `sub/.` conflicts (both sides change it differently from
        // base); `clean.txt` is changed by theirs only and resolves cleanly.
        // Nested under `sub/` (not top-level) so the conflicting path never
        // collides with the work directory's own root. Under the previous
        // per-outcome guard (validated inside the write wave), the clean
        // sibling batch ran and completed BEFORE the conflicts batch ever
        // reached `sub/.`'s refusal — this proves the hoisted whole-set gate
        // now refuses before either path is written.
        const ctx = createMemoryContext();
        await init(ctx);

        const cleanBase = await writeBlob(ctx, 'base-clean\n');
        const cleanTheirs = await writeBlob(ctx, 'THEIRS-CLEAN\n');
        const dotBase = await writeBlob(ctx, 'base\n');
        const dotOurs = await writeBlob(ctx, 'ours\n');
        const dotTheirs = await writeBlob(ctx, 'theirs\n');
        const dotEntry = (id: ObjectId): TreeEntry => treeEntry(FILE_MODE.REGULAR, '.', id);

        const baseTree = await writeTreeMod.writeTree(ctx, [
          treeEntry(FILE_MODE.REGULAR, 'clean.txt', cleanBase),
          treeEntry(
            FILE_MODE.DIRECTORY,
            'sub',
            await writeTreeMod.writeTree(ctx, [dotEntry(dotBase)]),
          ),
        ]);
        const mainTree = await writeTreeMod.writeTree(ctx, [
          treeEntry(FILE_MODE.REGULAR, 'clean.txt', cleanBase),
          treeEntry(
            FILE_MODE.DIRECTORY,
            'sub',
            await writeTreeMod.writeTree(ctx, [dotEntry(dotOurs)]),
          ),
        ]);
        const featureTree = await writeTreeMod.writeTree(ctx, [
          treeEntry(FILE_MODE.REGULAR, 'clean.txt', cleanTheirs),
          treeEntry(
            FILE_MODE.DIRECTORY,
            'sub',
            await writeTreeMod.writeTree(ctx, [dotEntry(dotTheirs)]),
          ),
        ]);

        const { createCommit: createCommitPrim } = await import(
          '../../../../src/application/primitives/create-commit.js'
        );
        const { updateRef } = await import('../../../../src/application/primitives/update-ref.js');
        const baseCommitId = await createCommitPrim(ctx, {
          tree: baseTree,
          parents: [],
          author,
          committer: author,
          message: 'base',
          extraHeaders: [],
        });
        const mainCommitId = await createCommitPrim(ctx, {
          tree: mainTree,
          parents: [baseCommitId],
          author,
          committer: author,
          message: 'ours-edit-dot',
          extraHeaders: [],
        });
        await updateRef(ctx, 'refs/heads/main' as RefName, mainCommitId, {
          reflogMessage: 'branch: Created',
        });
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
        const featureCommitId = await createCommitPrim(ctx, {
          tree: featureTree,
          parents: [baseCommitId],
          author,
          committer: author,
          message: 'theirs-edit-both',
          extraHeaders: [],
        });
        await updateRef(ctx, 'refs/heads/feature' as RefName, featureCommitId, {
          reflogMessage: 'branch: Created from seed',
        });

        // Act
        let caught: unknown;
        try {
          await mergeRun(ctx, { rev: 'feature', author });
        } catch (err) {
          caught = err;
        }

        // Assert
        const data = (caught as { data?: { code?: string; reason?: string } })?.data;
        expect(data?.code).toBe('INVALID_INDEX_ENTRY');
        expect(data?.reason).toBe("'.' segment rejected");
        expect(await ctx.fs.exists(`${ctx.layout.workDir}/clean.txt`)).toBe(false);
      });
    });
  });
});

describe('merge commit — HEAD through a chain of symbolic refs', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Given HEAD -> refs/heads/s -> refs/heads/x and a diverged feature branch', () => {
    describe('When merge records a merge commit', () => {
      it('Then x, s and HEAD each log the merge from the pre-merge id', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
        await add(ctx, ['a.txt']);
        await commit(ctx, { message: 'first', author });
        await branchCreate(ctx, { name: 'x' });
        await branchCreate(ctx, { name: 'feature' });
        await checkout(ctx, { rev: 'feature' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/b.txt`, 'b');
        await add(ctx, ['b.txt']);
        await commit(ctx, { message: 'second', author });
        await checkout(ctx, { rev: 'x' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/c.txt`, 'c');
        await add(ctx, ['c.txt']);
        const ours = await commit(ctx, { message: 'third', author });
        await chainHeadThroughS(ctx, 'refs/heads/x');
        freezeClock();

        // Act
        const result = await mergeRun(ctx, { rev: 'feature', message: 'merge', author });

        // Assert
        const created = result.kind === 'merge' ? result.id : undefined;
        const line = `${ours.id} ${created} tsgit <tsgit@localhost> ${FROZEN_SECONDS} +0000\tmerge feature: Merge made by the 'ort' strategy.`;
        expect(await lastReflogLine(ctx, 'refs/heads/x')).toBe(line);
        expect(await lastReflogLine(ctx, 'refs/heads/s')).toBe(line);
        expect(await lastReflogLine(ctx, 'HEAD')).toBe(line);
      });
    });
  });
});

describe('merge — internal reflog action', () => {
  const seedFastForward = async () => {
    const ctx = createMemoryContext();
    await init(ctx);
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
    await add(ctx, ['a.txt']);
    await commit(ctx, { message: 'first', author });
    await branchCreate(ctx, { name: 'feature' });
    await checkout(ctx, { rev: 'feature' });
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/b.txt`, 'b');
    await add(ctx, ['b.txt']);
    await commit(ctx, { message: 'second', author });
    await checkout(ctx, { rev: 'main' });
    return ctx;
  };

  describe('Given a merge, with or without an internal reflogAction override', () => {
    describe('When merge runs', () => {
      it.each([
        {
          label: 'the default "merge <rev>" prefix is recorded for a fast-forward',
          mergeOptions: { rev: 'feature' } as const,
          internalOptions: undefined,
          expected: 'merge feature: Fast-forward',
        },
        {
          label:
            'the default "merge <rev>" merge-commit prefix is recorded for a forced merge commit',
          mergeOptions: { rev: 'feature', fastForward: 'never', message: 'merge', author } as const,
          internalOptions: undefined,
          expected: "merge feature: Merge made by the 'ort' strategy.",
        },
        {
          label: '"pull: Fast-forward" is recorded when reflogAction is "pull"',
          mergeOptions: { rev: 'feature' } as const,
          internalOptions: { reflogAction: 'pull' } as const,
          expected: 'pull: Fast-forward',
        },
        {
          label:
            '"pull: Merge made by the \'ort\' strategy." is recorded for a forced merge with reflogAction "pull"',
          mergeOptions: { rev: 'feature', fastForward: 'never', message: 'merge', author } as const,
          internalOptions: { reflogAction: 'pull' } as const,
          expected: "pull: Merge made by the 'ort' strategy.",
        },
      ])('Then $label', async ({ mergeOptions, internalOptions, expected }) => {
        // Arrange
        const ctx = await seedFastForward();

        // Act
        await mergeRun(ctx, mergeOptions, internalOptions);

        // Assert
        const messages = (await readReflog(ctx, 'refs/heads/main' as RefName)).map(
          (e) => e.message,
        );
        expect(messages).toContain(expected);
      });
    });
  });
});

describe('resolveMergeAuthor / resolveMergeCommitter (direct)', () => {
  describe('Given no explicit author and a configured user', () => {
    describe('When resolveMergeAuthor runs', () => {
      it('Then returns the config user with a sane timestamp and +0000 offset', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/config`,
          '[user]\n  name = Grace\n  email = grace@example.com\n',
        );
        const before = Math.floor(Date.now() / 1000);

        // Act
        const result = await resolveMergeAuthor(ctx, { rev: 'feature' });

        // Assert — name/email from config; timestamp is Date.now()/1000 (seconds,
        // not ms — kills the `/1000`→`*1000` mutant); offset is the literal +0000.
        const after = Math.floor(Date.now() / 1000);
        expect(result.name).toBe('Grace');
        expect(result.email).toBe('grace@example.com');
        expect(result.timezoneOffset).toBe('+0000');
        expect(result.timestamp).toBeGreaterThanOrEqual(before);
        expect(result.timestamp).toBeLessThanOrEqual(after);
      });
    });
  });

  describe('Given an explicit author', () => {
    describe('When resolveMergeAuthor runs', () => {
      it('Then the explicit author wins over config', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/config`,
          '[user]\n  name = Grace\n  email = grace@example.com\n',
        );

        // Act
        const result = await resolveMergeAuthor(ctx, { rev: 'feature', author });

        // Assert
        expect(result).toEqual(author);
      });
    });
  });

  describe('Given an explicit committer', () => {
    describe('When resolveMergeCommitter runs', () => {
      it('Then the explicit committer wins over the author', async () => {
        // Arrange
        const committer: AuthorIdentity = {
          name: 'Linus',
          email: 'linus@example.com',
          timestamp: 1_700_000_500,
          timezoneOffset: '+0100',
        };

        // Act
        const result = resolveMergeCommitter({ rev: 'feature', committer }, author);

        // Assert
        expect(result).toEqual(committer);
      });
    });
  });

  describe('Given no explicit committer', () => {
    describe('When resolveMergeCommitter runs', () => {
      it('Then it falls back to the author', async () => {
        // Arrange & Act
        const result = resolveMergeCommitter({ rev: 'feature' }, author);

        // Assert
        expect(result).toEqual(author);
      });
    });
  });
});

describe('writeNestedTree (direct)', () => {
  describe('Given core.maxTreeDepth configured to zero and a top-level leaf', () => {
    describe('When writeNestedTree runs', () => {
      it('Then it completes — zero permits exactly the top level', async () => {
        // Arrange — the companion to the negative case, and the one that
        // separates `maxDepth < 0` from `maxDepth <= 0`: a cap of 0 must still
        // admit depth-0 entries, so a flat leaf list writes a tree.
        const ctx = await buildSeededContext();
        await seedMaxTreeDepth(ctx, '0');
        const blobId = await writeBlob(ctx, DEEP_CHAIN_LEAF_CONTENT);
        const leaves = [{ path: 'f.txt' as FilePath, id: blobId, mode: FILE_MODE.REGULAR }];

        // Act
        const result = await writeNestedTree(ctx, leaves);

        // Assert
        const tree = await readObject(ctx, result);
        expect(tree.type).toBe('tree');
      });
    });
  });

  describe('Given core.maxTreeDepth configured negative and a top-level leaf', () => {
    describe('When writeNestedTree runs', () => {
      it('Then it throws TREE_DEPTH_EXCEEDED at depth 0 — the root itself is refused', async () => {
        // Arrange — a negative cap is a valid cap, not "unlimited": the root
        // sits at depth 0 and `0 > -1`, so even a flat leaf list is refused
        // before anything is partitioned. Matches the traversal sites, where
        // real git also refuses a flat tree under a negative cap.
        const ctx = await buildSeededContext();
        await seedMaxTreeDepth(ctx, '-1');
        const blobId = await writeBlob(ctx, DEEP_CHAIN_LEAF_CONTENT);
        const leaves = [{ path: 'f.txt' as FilePath, id: blobId, mode: FILE_MODE.REGULAR }];

        // Act + Assert
        try {
          await writeNestedTree(ctx, leaves);
          expect.unreachable();
        } catch (error) {
          const data = (error as { data: { code: string; depth: number } }).data;
          expect(data.code).toBe('TREE_DEPTH_EXCEEDED');
          expect(data.depth).toBe(0);
        }
      });
    });
  });

  describe('Given config unset (default cap) and a leaf at exactly the default depth', () => {
    describe('When writeNestedTree runs', () => {
      it('Then it completes and the tree round-trips', async () => {
        // Arrange — this is the assertion that distinguishes an explicit
        // stack from recursion: before the rewrite, writeNestedTree's own
        // recursion overflows the JS call stack well before reaching
        // DEFAULT_MAX_TREE_DEPTH (2048).
        const ctx = await buildSeededContext();
        const blobId = await writeBlob(ctx, DEEP_CHAIN_LEAF_CONTENT);
        const path = deepIndexPath(DEFAULT_MAX_TREE_DEPTH) as FilePath;
        const leaves = [{ path, id: blobId, mode: FILE_MODE.REGULAR }];
        const expectedRootId = await buildTreeChain(ctx, DEFAULT_MAX_TREE_DEPTH);

        // Act
        const result = await writeNestedTree(ctx, leaves);

        // Assert — identity against an independently-built chain of the
        // same shape proves the write order too, not just "no throw".
        expect(result).toBe(expectedRootId);
      });
    });
  });

  describe('Given config unset (default cap) and a leaf one past the default depth', () => {
    describe('When writeNestedTree runs', () => {
      it('Then it throws TREE_DEPTH_EXCEEDED with the exact depth', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const blobId = await writeBlob(ctx, 'x');
        const path = deepIndexPath(DEFAULT_MAX_TREE_DEPTH + 1) as FilePath;
        const leaves = [{ path, id: blobId, mode: FILE_MODE.REGULAR }];

        // Act
        let caught: unknown;
        try {
          await writeNestedTree(ctx, leaves);
        } catch (err) {
          caught = err;
        }

        // Assert
        const data = (caught as { data?: { code?: string; depth?: number } })?.data;
        expect(data?.code).toBe('TREE_DEPTH_EXCEEDED');
        expect(data?.depth).toBe(DEFAULT_MAX_TREE_DEPTH + 1);
      });
    });
  });

  describe('Given core.maxTreeDepth configured to a small cap', () => {
    const SMALL_CAP = 4;

    describe('When a leaf is exactly at the configured cap', () => {
      it('Then it succeeds (depth > cap, not >=)', async () => {
        // Arrange — no subdirs beyond the cap; depth === cap must NOT throw.
        const ctx = await buildSeededContext();
        await seedMaxTreeDepth(ctx, String(SMALL_CAP));
        const blobId = await writeBlob(ctx, DEEP_CHAIN_LEAF_CONTENT);
        const path = deepIndexPath(SMALL_CAP) as FilePath;
        const leaves = [{ path, id: blobId, mode: FILE_MODE.REGULAR }];
        const expectedRootId = await buildTreeChain(ctx, SMALL_CAP);

        // Act
        const result = await writeNestedTree(ctx, leaves);

        // Assert
        expect(result).toBe(expectedRootId);
      });
    });

    describe('When a leaf is one level past the configured cap', () => {
      it('Then it throws TREE_DEPTH_EXCEEDED with depth = cap + 1', async () => {
        // Arrange — one extra `/` forces one extra level, tripping the cap
        // at cap + 1; this kills a `depth - 1` mutant and a `false`
        // conditional mutant on the guard.
        const ctx = await buildSeededContext();
        await seedMaxTreeDepth(ctx, String(SMALL_CAP));
        const blobId = await writeBlob(ctx, 'x');
        const path = deepIndexPath(SMALL_CAP + 1) as FilePath;
        const leaves = [{ path, id: blobId, mode: FILE_MODE.REGULAR }];

        // Act
        let caught: unknown;
        try {
          await writeNestedTree(ctx, leaves);
        } catch (err) {
          caught = err;
        }

        // Assert
        const data = (caught as { data?: { code?: string; depth?: number } })?.data;
        expect(data?.code).toBe('TREE_DEPTH_EXCEEDED');
        expect(data?.depth).toBe(SMALL_CAP + 1);
      });
    });

    describe('When a leaf sits far beyond the configured cap (20x)', () => {
      it('Then it throws TREE_DEPTH_EXCEEDED with depth = cap + 1, never larger, never a RangeError', async () => {
        // Arrange — the DURING-descent guard fires as soon as depth crosses
        // the cap, without ever partitioning the levels beyond it: proves
        // the guard is reachable (not dead code behind a stack overflow)
        // regardless of how much deeper the input actually goes.
        const ctx = await buildSeededContext();
        await seedMaxTreeDepth(ctx, String(SMALL_CAP));
        const blobId = await writeBlob(ctx, 'x');
        const path = deepIndexPath(SMALL_CAP * 20) as FilePath;
        const leaves = [{ path, id: blobId, mode: FILE_MODE.REGULAR }];

        // Act
        let caught: unknown;
        try {
          await writeNestedTree(ctx, leaves);
        } catch (err) {
          caught = err;
        }

        // Assert
        const data = (caught as { data?: { code?: string; depth?: number } })?.data;
        expect(data?.code).toBe('TREE_DEPTH_EXCEEDED');
        expect(data?.depth).toBe(SMALL_CAP + 1);
      });
    });
  });

  describe('Given the same fixture evaluated against two different configured caps', () => {
    const FIXTURE_DEPTH = 5;

    describe('When core.maxTreeDepth equals the fixture depth', () => {
      it('Then it completes (the cap is read from config, not hardcoded)', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await seedMaxTreeDepth(ctx, String(FIXTURE_DEPTH));
        const blobId = await writeBlob(ctx, DEEP_CHAIN_LEAF_CONTENT);
        const path = deepIndexPath(FIXTURE_DEPTH) as FilePath;
        const leaves = [{ path, id: blobId, mode: FILE_MODE.REGULAR }];
        const expectedRootId = await buildTreeChain(ctx, FIXTURE_DEPTH);

        // Act
        const result = await writeNestedTree(ctx, leaves);

        // Assert
        expect(result).toBe(expectedRootId);
      });
    });

    describe('When core.maxTreeDepth is one less than the fixture depth', () => {
      it('Then the same fixture now refuses with depth = fixture depth', async () => {
        // Arrange — SAME fixture depth as the passing case above; only the
        // configured cap changes. A guard reading a hardcoded constant
        // instead of config would pass both cases identically.
        const ctx = await buildSeededContext();
        await seedMaxTreeDepth(ctx, String(FIXTURE_DEPTH - 1));
        const blobId = await writeBlob(ctx, 'x');
        const path = deepIndexPath(FIXTURE_DEPTH) as FilePath;
        const leaves = [{ path, id: blobId, mode: FILE_MODE.REGULAR }];

        // Act
        let caught: unknown;
        try {
          await writeNestedTree(ctx, leaves);
        } catch (err) {
          caught = err;
        }

        // Assert
        const data = (caught as { data?: { code?: string; depth?: number } })?.data;
        expect(data?.code).toBe('TREE_DEPTH_EXCEEDED');
        expect(data?.depth).toBe(FIXTURE_DEPTH);
      });
    });
  });

  describe('Given more top-level leaf directories than the ioBound limit', () => {
    describe('When writeNestedTree runs', () => {
      it('Then subtree writes at the same trie level peak at exactly the bound', async () => {
        // Arrange — an explicit ioBound distinct from cpuBound so a
        // bucket-swap regression fails loudly. Each leaf sits in its own
        // top-level directory, so every one becomes a sibling frame at the
        // trie's deepest level, all writeTree calls fanning out together.
        const ioBound = 3;
        const base = await buildSeededContext();
        const ctx: typeof base = { ...base, concurrency: { cpuBound: 1, ioBound } };
        const width = ioBound + 4;
        const leaves = await Promise.all(
          Array.from({ length: width }, async (_unused, i) => ({
            path: `d${String(i).padStart(3, '0')}/f.txt` as FilePath,
            id: await writeBlob(ctx, `content-${i}`),
            mode: FILE_MODE.REGULAR,
          })),
        );
        let inFlight = 0;
        let maxInFlight = 0;
        const realWriteTree = writeTreeMod.writeTree;
        const spy = vi
          .spyOn(writeTreeMod, 'writeTree')
          .mockImplementation(async (spyCtx, entries) => {
            inFlight += 1;
            if (inFlight > maxInFlight) maxInFlight = inFlight;
            await Promise.resolve();
            inFlight -= 1;
            return realWriteTree(spyCtx, entries);
          });

        // Act
        try {
          const result = await writeNestedTree(ctx, leaves);

          // Assert
          const tree = await readObject(ctx, result);
          expect(tree.type).toBe('tree');
          expect(maxInFlight).toBe(ioBound);
        } finally {
          spy.mockRestore();
        }
      });
    });
  });
});

describe('writeOutcomeToTree (direct)', () => {
  const seedBlob = async (
    ctx: ReturnType<typeof createMemoryContext>,
    text: string,
  ): Promise<ObjectId> =>
    writeObject(ctx, {
      type: 'blob',
      content: new TextEncoder().encode(text),
      id: '' as ObjectId,
    });

  describe('Given an outcome carrying resolvable bytes (unchanged / resolved-known / resolved-merged)', () => {
    describe('When writeOutcomeToTree runs', () => {
      it.each([
        {
          status: 'unchanged',
          path: 'u.txt' as FilePath,
          content: 'UNCHANGED-BYTES',
          label: 'the blob content is written to the working tree',
        },
        {
          status: 'resolved-known',
          path: 'k.txt' as FilePath,
          content: 'KNOWN-BYTES',
          label: 'the blob content is written to the working tree',
        },
        {
          status: 'resolved-merged',
          path: 'm.txt' as FilePath,
          content: 'MERGED-BYTES',
          label: 'the outcome bytes are written verbatim',
        },
      ] as const)('Then $label', async ({ status, path, content }) => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        const outcome: MergeOutcome =
          status === 'resolved-merged'
            ? { status, path, bytes: new TextEncoder().encode(content), mode: FILE_MODE.REGULAR }
            : { status, path, id: await seedBlob(ctx, content), mode: FILE_MODE.REGULAR };

        // Act
        await writeOutcomeToTree(ctx, outcome, undefined);

        // Assert
        expect(await ctx.fs.readUtf8(`${ctx.layout.workDir}/${path}`)).toBe(content);
      });
    });
  });

  describe('Given a resolved-deleted outcome for an existing file', () => {
    describe('When writeOutcomeToTree runs', () => {
      it('Then the working-tree file is removed', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/d.txt`, 'to-be-removed');
        const outcome: MergeOutcome = { status: 'resolved-deleted', path: 'd.txt' as FilePath };

        // Act
        await writeOutcomeToTree(ctx, outcome, undefined);

        // Assert
        expect(await ctx.fs.exists(`${ctx.layout.workDir}/d.txt`)).toBe(false);
      });
    });
  });

  // Once flatten-raw stops refusing `.`/`..` at parse, a merged tree carrying
  // such a name reaches this writer for the first time — it must refuse
  // before anything touches the working tree.
  describe('Given an outcome named "."', () => {
    describe('When writeOutcomeToTree runs', () => {
      it('Then throws INVALID_INDEX_ENTRY before any write is attempted', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        const streamBlobSpy = vi.spyOn(streamBlobMod, 'streamBlob');
        const outcome: MergeOutcome = {
          status: 'unchanged',
          path: '.' as FilePath,
          id: await seedBlob(ctx, 'DOT-BYTES'),
          mode: FILE_MODE.REGULAR,
        };

        // Act
        let caught: unknown;
        let streamBlobCallCount: number;
        try {
          await writeOutcomeToTree(ctx, outcome, undefined);
        } catch (err) {
          caught = err;
        } finally {
          streamBlobCallCount = streamBlobSpy.mock.calls.length;
          streamBlobSpy.mockRestore();
        }

        // Assert
        const data = (caught as { data?: { code?: string; reason?: string; offset?: number } })
          ?.data;
        expect(data?.code).toBe('INVALID_INDEX_ENTRY');
        expect(data?.reason).toBe("'.' segment rejected");
        expect(data?.offset).toBe(NO_PARSER_OFFSET);
        expect(streamBlobCallCount).toBe(0);
      });
    });
  });

  describe('Given an outcome named ".."', () => {
    describe('When writeOutcomeToTree runs', () => {
      it('Then throws INVALID_INDEX_ENTRY before any write is attempted', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        const streamBlobSpy = vi.spyOn(streamBlobMod, 'streamBlob');
        const outcome: MergeOutcome = {
          status: 'unchanged',
          path: '..' as FilePath,
          id: await seedBlob(ctx, 'DOTDOT-BYTES'),
          mode: FILE_MODE.REGULAR,
        };

        // Act
        let caught: unknown;
        let streamBlobCallCount: number;
        try {
          await writeOutcomeToTree(ctx, outcome, undefined);
        } catch (err) {
          caught = err;
        } finally {
          streamBlobCallCount = streamBlobSpy.mock.calls.length;
          streamBlobSpy.mockRestore();
        }

        // Assert
        const data = (caught as { data?: { code?: string; reason?: string; offset?: number } })
          ?.data;
        expect(data?.code).toBe('INVALID_INDEX_ENTRY');
        expect(data?.reason).toBe("'..' segment rejected");
        expect(data?.offset).toBe(NO_PARSER_OFFSET);
        expect(streamBlobCallCount).toBe(0);
      });
    });
  });

  // A `resolved-deleted` outcome's path is sourced from the merge's `ours`
  // tree flatten, never from a parsed index — so the premise "this path
  // already passed validation when the index was parsed" does not hold for
  // it, and it must be validated here like every other outcome.
  describe('Given a resolved-deleted outcome named ".."', () => {
    describe('When writeOutcomeToTree runs', () => {
      it('Then throws INVALID_INDEX_ENTRY and the working-tree file is not removed', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        const outcome: MergeOutcome = { status: 'resolved-deleted', path: '..' as FilePath };
        const removeSpy = vi.spyOn(writeFileMod, 'removeWorkingTreeFile');

        // Act
        let caught: unknown;
        let removeCallCount: number;
        try {
          await writeOutcomeToTree(ctx, outcome, undefined);
        } catch (err) {
          caught = err;
        } finally {
          removeCallCount = removeSpy.mock.calls.length;
          removeSpy.mockRestore();
        }

        // Assert
        const data = (caught as { data?: { code?: string; reason?: string; offset?: number } })
          ?.data;
        expect(data?.code).toBe('INVALID_INDEX_ENTRY');
        expect(data?.reason).toBe("'..' segment rejected");
        expect(data?.offset).toBe(NO_PARSER_OFFSET);
        expect(removeCallCount).toBe(0);
      });
    });
  });
});

describe('writeOutcomeToTree (direct) — streaming', () => {
  const seedBlob = async (
    ctx: ReturnType<typeof createMemoryContext>,
    content: Uint8Array,
  ): Promise<ObjectId> => writeObject(ctx, { type: 'blob', content, id: '' as ObjectId });

  describe('Given an unchanged outcome', () => {
    describe('When writeOutcomeToTree runs', () => {
      it('Then routes through writeWorkingTreeFileStream (not buffered readBlob)', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        const bytes = new TextEncoder().encode('unchanged-stream');
        const id = await seedBlob(ctx, bytes);
        const outcome: MergeOutcome = {
          status: 'unchanged',
          path: 'u.txt' as FilePath,
          id,
          mode: FILE_MODE.REGULAR,
        };
        const writeStreamSpy = vi.spyOn(writeFileMod, 'writeWorkingTreeFileStream');

        // Act
        await writeOutcomeToTree(ctx, outcome, undefined);

        // Assert
        expect(writeStreamSpy).toHaveBeenCalledOnce();
        expect(await ctx.fs.readUtf8(`${ctx.layout.workDir}/u.txt`)).toBe('unchanged-stream');

        writeStreamSpy.mockRestore();
      });
    });
  });

  describe('Given a resolved-known outcome', () => {
    describe('When writeOutcomeToTree runs', () => {
      it('Then routes through writeWorkingTreeFileStream and written bytes match blob content', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        const bytes = new TextEncoder().encode('known-stream');
        const id = await seedBlob(ctx, bytes);
        const outcome: MergeOutcome = {
          status: 'resolved-known',
          path: 'k.txt' as FilePath,
          id,
          mode: FILE_MODE.REGULAR,
        };
        const writeStreamSpy = vi.spyOn(writeFileMod, 'writeWorkingTreeFileStream');

        // Act
        await writeOutcomeToTree(ctx, outcome, undefined);

        // Assert
        expect(writeStreamSpy).toHaveBeenCalledOnce();
        expect(await ctx.fs.readUtf8(`${ctx.layout.workDir}/k.txt`)).toBe('known-stream');

        writeStreamSpy.mockRestore();
      });
    });
  });

  describe('Given a resolved-known outcome with a large blob (uncapped write)', () => {
    describe('When writeOutcomeToTree runs', () => {
      it('Then the full content is written with no size cap', async () => {
        // Arrange — a blob large enough to fail a small explicit cap but fine uncapped
        const ctx = createMemoryContext();
        await init(ctx);
        const bytes = new Uint8Array(1024).fill(0x42); // 1 KiB, any hypothetical small cap would throw
        const id = await seedBlob(ctx, bytes);
        const outcome: MergeOutcome = {
          status: 'resolved-known',
          path: 'large.bin' as FilePath,
          id,
          mode: FILE_MODE.REGULAR,
        };

        // Act — must not throw; uncapped streaming path
        await writeOutcomeToTree(ctx, outcome, undefined);

        // Assert — streamBlob called with exactly (ctx, id) — no third options arg
        const written = await ctx.fs.read(`${ctx.layout.workDir}/large.bin`);
        expect(written).toEqual(bytes);
      });
    });
  });

  describe('Given a resolved-merged outcome', () => {
    describe('When writeOutcomeToTree runs', () => {
      it('Then routes through buffered writeWorkingTreeFile (not streamBlob) and streamBlob is never called', async () => {
        // Arrange — resolved-merged carries synthesised bytes in memory; no blob id to stream
        const ctx = createMemoryContext();
        await init(ctx);
        const outcome: MergeOutcome = {
          status: 'resolved-merged',
          path: 'm.txt' as FilePath,
          bytes: new TextEncoder().encode('MERGED-BYTES'),
          mode: FILE_MODE.REGULAR,
        };
        const streamBlobSpy = vi.spyOn(streamBlobMod, 'streamBlob');
        const writeStreamSpy = vi.spyOn(writeFileMod, 'writeWorkingTreeFileStream');

        // Act
        await writeOutcomeToTree(ctx, outcome, undefined);

        // Assert — streaming path must NOT be taken; mutation streaming it must die here
        expect(streamBlobSpy).not.toHaveBeenCalled();
        expect(writeStreamSpy).not.toHaveBeenCalled();
        expect(await ctx.fs.readUtf8(`${ctx.layout.workDir}/m.txt`)).toBe('MERGED-BYTES');

        streamBlobSpy.mockRestore();
        writeStreamSpy.mockRestore();
      });
    });
  });

  describe('Given an unchanged outcome on an excluded sparse path', () => {
    describe('When writeOutcomeToTree runs', () => {
      it('Then short-circuits before opening any stream (isExcluded guard precedes stream open)', async () => {
        // Arrange — matcher that excludes everything
        const ctx = createMemoryContext();
        await init(ctx);
        const bytes = new TextEncoder().encode('excluded-data');
        const id = await seedBlob(ctx, bytes);
        const outcome: MergeOutcome = {
          status: 'unchanged',
          path: 'ex.txt' as FilePath,
          id,
          mode: FILE_MODE.REGULAR,
        };
        // SparseMatcher is (path: FilePath) => boolean; returning false means excluded
        const excludesMatcher = (() => false) as Parameters<typeof writeOutcomeToTree>[2];
        const streamBlobSpy = vi.spyOn(streamBlobMod, 'streamBlob');

        // Act
        await writeOutcomeToTree(ctx, outcome, excludesMatcher);

        // Assert — stream not opened; guard fires before stream
        expect(streamBlobSpy).not.toHaveBeenCalled();
        expect(await ctx.fs.exists(`${ctx.layout.workDir}/ex.txt`)).toBe(false);

        streamBlobSpy.mockRestore();
      });
    });
  });
});

describe('materialiseConflictBytes (direct)', () => {
  const seedBlob = async (
    ctx: ReturnType<typeof createMemoryContext>,
    text: string,
  ): Promise<ObjectId> =>
    writeObject(ctx, {
      type: 'blob',
      content: new TextEncoder().encode(text),
      id: '' as ObjectId,
    });
  const conflictOf = (over: Partial<MergeConflict>): MergeConflict =>
    ({ path: 'c.txt' as FilePath, ...over }) as MergeConflict;
  const decode = (b: Uint8Array | undefined): string =>
    b === undefined ? '<undefined>' : new TextDecoder().decode(b);

  describe('Given a conflict with resolvable bytes (conflictContent, ours, or theirs)', () => {
    describe('When materialiseConflictBytes runs', () => {
      it.each([
        {
          label: 'it returns that conflictContent verbatim',
          expected: 'PRECOMPUTED-CONFLICT-CONTENT',
          build: async (_ctx: ReturnType<typeof createMemoryContext>) =>
            conflictOf({
              type: 'content',
              conflictContent: new TextEncoder().encode('PRECOMPUTED-CONFLICT-CONTENT'),
            }),
        },
        {
          label: 'conflictContent is NOT used (the type===content operand matters)',
          expected: 'OURS-TYPECHANGE',
          build: async (ctx: ReturnType<typeof createMemoryContext>) =>
            conflictOf({
              type: 'type-change',
              conflictContent: new TextEncoder().encode('SHOULD-NOT-BE-USED'),
              ourId: await seedBlob(ctx, 'OURS-TYPECHANGE'),
            }),
        },
        {
          label: 'a binary conflict returns the ours blob bytes',
          expected: 'OURS-BINARY',
          build: async (ctx: ReturnType<typeof createMemoryContext>) =>
            conflictOf({ type: 'binary', ourId: await seedBlob(ctx, 'OURS-BINARY') }),
        },
        {
          label: 'an add-add conflict returns the ours blob bytes',
          expected: 'OURS-ADDADD',
          build: async (ctx: ReturnType<typeof createMemoryContext>) =>
            conflictOf({ type: 'add-add', ourId: await seedBlob(ctx, 'OURS-ADDADD') }),
        },
        {
          label: 'a type-change conflict returns the ours blob bytes',
          expected: 'OURS-TYPE-CHANGE',
          build: async (ctx: ReturnType<typeof createMemoryContext>) =>
            conflictOf({ type: 'type-change', ourId: await seedBlob(ctx, 'OURS-TYPE-CHANGE') }),
        },
        {
          label: 'a modify-delete conflict with only ourId returns the ours blob bytes',
          expected: 'OURS-MODDEL',
          build: async (ctx: ReturnType<typeof createMemoryContext>) =>
            conflictOf({ type: 'modify-delete', ourId: await seedBlob(ctx, 'OURS-MODDEL') }),
        },
        {
          label:
            'a modify-delete conflict with only theirId returns the theirs blob bytes (?? falls through)',
          expected: 'THEIRS-MODDEL',
          build: async (ctx: ReturnType<typeof createMemoryContext>) =>
            conflictOf({ type: 'modify-delete', theirId: await seedBlob(ctx, 'THEIRS-MODDEL') }),
        },
        {
          label: 'a bare content conflict with both ids returns the ours blob bytes',
          expected: 'OURS-LINE',
          build: async (ctx: ReturnType<typeof createMemoryContext>) =>
            conflictOf({
              type: 'content',
              ourId: await seedBlob(ctx, 'OURS-LINE'),
              theirId: await seedBlob(ctx, 'THEIRS-LINE'),
            }),
        },
        {
          label: 'a bare content conflict with only ourId returns the ours blob bytes',
          expected: 'OURS-ONLY',
          build: async (ctx: ReturnType<typeof createMemoryContext>) =>
            conflictOf({ type: 'content', ourId: await seedBlob(ctx, 'OURS-ONLY') }),
        },
      ])('Then $label', async ({ expected, build }) => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        const conflict = await build(ctx);

        // Act
        const result = await materialiseConflictBytes(ctx, conflict);

        // Assert
        expect(decode(result)).toBe(expected);
      });
    });
  });

  describe('Given a conflict with no resolvable bytes', () => {
    describe('When materialiseConflictBytes runs', () => {
      it.each([
        {
          label: 'a binary conflict with no ourId returns undefined',
          build: async (_ctx: ReturnType<typeof createMemoryContext>) =>
            conflictOf({ type: 'binary' }),
        },
        {
          label: 'an add-add conflict with no ourId returns undefined',
          build: async (_ctx: ReturnType<typeof createMemoryContext>) =>
            conflictOf({ type: 'add-add' }),
        },
        {
          label: 'a modify-delete conflict with neither id returns undefined',
          build: async (_ctx: ReturnType<typeof createMemoryContext>) =>
            conflictOf({ type: 'modify-delete' }),
        },
        {
          // A gitlink conflict reaches the final `if` block; the `type === 'content'`
          // operand must keep it out, returning undefined even with both ids present.
          label:
            'an unhandled conflict type carrying both ids returns undefined (the second type===content guard matters)',
          build: async (ctx: ReturnType<typeof createMemoryContext>) =>
            conflictOf({
              type: 'gitlink',
              ourId: await seedBlob(ctx, 'OURS-GITLINK'),
              theirId: await seedBlob(ctx, 'THEIRS-GITLINK'),
            }),
        },
      ])('Then $label', async ({ build }) => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        const conflict = await build(ctx);

        // Act
        const result = await materialiseConflictBytes(ctx, conflict);

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });
});

describe('buildConflictIndexEntries (direct)', () => {
  const fakeId = (c: string): ObjectId => c.repeat(40) as ObjectId;

  describe('Given an unchanged outcome', () => {
    describe('When buildConflictIndexEntries runs', () => {
      it('Then a stage-0 entry is produced for it', () => {
        // Arrange
        const outcomes: MergeOutcome[] = [
          {
            status: 'unchanged',
            path: 'u.txt' as FilePath,
            id: fakeId('a'),
            mode: FILE_MODE.REGULAR,
          },
        ];

        // Act
        const result = buildConflictIndexEntries(outcomes, [], undefined, []);

        // Assert
        expect(result).toHaveLength(1);
        expect(result[0]?.path).toBe('u.txt');
        expect(result[0]?.flags.stage).toBe(0);
      });
    });
  });

  describe('Given a resolved-known outcome', () => {
    describe('When buildConflictIndexEntries runs', () => {
      it('Then a stage-0 entry is produced for it', () => {
        // Arrange
        const outcomes: MergeOutcome[] = [
          {
            status: 'resolved-known',
            path: 'k.txt' as FilePath,
            id: fakeId('b'),
            mode: FILE_MODE.REGULAR,
          },
        ];

        // Act
        const result = buildConflictIndexEntries(outcomes, [], undefined, []);

        // Assert
        expect(result).toHaveLength(1);
        expect(result[0]?.path).toBe('k.txt');
        expect(result[0]?.flags.stage).toBe(0);
      });
    });
  });

  describe('Given a resolved-deleted outcome', () => {
    describe('When buildConflictIndexEntries runs', () => {
      it('Then no stage-0 entry is produced', () => {
        // Arrange — resolved-deleted contributes no stage-0 entry.
        const outcomes: MergeOutcome[] = [
          { status: 'resolved-deleted', path: 'd.txt' as FilePath },
        ];

        // Act
        const result = buildConflictIndexEntries(outcomes, [], undefined, []);

        // Assert
        expect(result).toEqual([]);
      });
    });
  });

  describe('Given a stage-0 outcome', () => {
    describe('When buildConflictIndexEntries runs', () => {
      it('Then the entry flags are assumeValid=false and skipWorktree=false', () => {
        // Arrange
        const outcomes: MergeOutcome[] = [
          {
            status: 'unchanged',
            path: 'f.txt' as FilePath,
            id: fakeId('c'),
            mode: FILE_MODE.REGULAR,
          },
        ];

        // Act
        const result = buildConflictIndexEntries(outcomes, [], undefined, []);

        // Assert — every flag is literally false.
        expect(result[0]?.flags.assumeValid).toBe(false);
        expect(result[0]?.flags.skipWorktree).toBe(false);
        expect(result[0]?.flags.intentToAdd).toBe(false);
      });
    });
  });

  describe('Given stage-0 outcomes and a conflict whose paths interleave alphabetically', () => {
    describe('When buildConflictIndexEntries runs', () => {
      it('Then entries are sorted by (path, stage)', () => {
        // Arrange — stage-0 paths `zzz`/`aaa` and a content conflict on `mmm`.
        // `[...stage0, ...stageConflicts]` is `[zzz@0, aaa@0, mmm@1, mmm@2, mmm@3]`
        // — NOT sorted; the explicit `combined.sort` must reorder it.
        const outcomes: MergeOutcome[] = [
          {
            status: 'unchanged',
            path: 'zzz.txt' as FilePath,
            id: fakeId('e'),
            mode: FILE_MODE.REGULAR,
          },
          {
            status: 'resolved-known',
            path: 'aaa.txt' as FilePath,
            id: fakeId('d'),
            mode: FILE_MODE.REGULAR,
          },
        ];
        const conflicts: MergeConflict[] = [
          {
            type: 'content',
            path: 'mmm.txt' as FilePath,
            baseId: fakeId('1'),
            ourId: fakeId('2'),
            theirId: fakeId('3'),
            baseMode: FILE_MODE.REGULAR,
            ourMode: FILE_MODE.REGULAR,
            theirMode: FILE_MODE.REGULAR,
          },
        ];

        // Act
        const result = buildConflictIndexEntries(outcomes, conflicts, undefined, []);

        // Assert — fully sorted by path, then by stage within `mmm.txt`.
        const order = result.map((e) => `${e.path}@${e.flags.stage}`);
        expect(order).toEqual(['aaa.txt@0', 'mmm.txt@1', 'mmm.txt@2', 'mmm.txt@3', 'zzz.txt@0']);
      });
    });
  });
});

describe('merge — sparse checkout', () => {
  // Matcher excluding any path that starts with `drop`.
  const excludesDrop = (p: FilePath): boolean => !p.startsWith('drop');

  const enableSparseSrcOnly = async (ctx: ReturnType<typeof createMemoryContext>) => {
    const { updateCoreConfig } = await import(
      '../../../../src/application/primitives/update-config.js'
    );
    await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/info/sparse-checkout`, '/*\n!/*/\n/src/\n');
    await updateCoreConfig(ctx, { sparseCheckout: 'true', sparseCheckoutCone: 'true' });
  };

  const seedBlob = async (
    ctx: ReturnType<typeof createMemoryContext>,
    text: string,
  ): Promise<ObjectId> =>
    writeObject(ctx, { type: 'blob', content: new TextEncoder().encode(text), id: '' as ObjectId });

  describe('Given an unchanged outcome whose path the sparse matcher excludes', () => {
    describe('When writeOutcomeToTree runs', () => {
      it('Then the file is not written', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        const id = await seedBlob(ctx, 'X');
        const outcome: MergeOutcome = {
          status: 'unchanged',
          path: 'drop.txt' as FilePath,
          id,
          mode: FILE_MODE.REGULAR,
        };

        // Act
        await writeOutcomeToTree(ctx, outcome, excludesDrop);

        // Assert
        expect(await ctx.fs.exists(`${ctx.layout.workDir}/drop.txt`)).toBe(false);
      });
    });
  });

  describe('Given an unchanged outcome whose path the sparse matcher includes', () => {
    describe('When writeOutcomeToTree runs', () => {
      it('Then the file is written', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        const id = await seedBlob(ctx, 'KEPT');
        const outcome: MergeOutcome = {
          status: 'unchanged',
          path: 'keep.txt' as FilePath,
          id,
          mode: FILE_MODE.REGULAR,
        };

        // Act
        await writeOutcomeToTree(ctx, outcome, excludesDrop);

        // Assert
        expect(await ctx.fs.readUtf8(`${ctx.layout.workDir}/keep.txt`)).toBe('KEPT');
      });
    });
  });

  describe('Given a resolved-known outcome whose path the sparse matcher excludes', () => {
    describe('When writeOutcomeToTree runs', () => {
      it('Then the file is not written', async () => {
        // Arrange — `resolved-known` is blob-backed like `unchanged`, so an
        // excluded path is skipped: its content is recoverable from the store.
        const ctx = createMemoryContext();
        await init(ctx);
        const id = await seedBlob(ctx, 'X');
        const outcome: MergeOutcome = {
          status: 'resolved-known',
          path: 'drop.txt' as FilePath,
          id,
          mode: FILE_MODE.REGULAR,
        };

        // Act
        await writeOutcomeToTree(ctx, outcome, excludesDrop);

        // Assert
        expect(await ctx.fs.exists(`${ctx.layout.workDir}/drop.txt`)).toBe(false);
      });
    });
  });

  describe('Given a resolved-merged outcome whose path the sparse matcher excludes', () => {
    describe('When writeOutcomeToTree runs', () => {
      it('Then the file is still written (merged bytes have no other persistence)', async () => {
        // Arrange — `resolved-merged` carries its merged bytes in memory only;
        // the working-tree write is their sole persistence, so it must happen
        // even for an out-of-pattern path, unlike a blob-backed clean outcome.
        const ctx = createMemoryContext();
        await init(ctx);
        const outcome: MergeOutcome = {
          status: 'resolved-merged',
          path: 'drop.txt' as FilePath,
          bytes: new TextEncoder().encode('MERGED'),
          mode: FILE_MODE.REGULAR,
        };

        // Act
        await writeOutcomeToTree(ctx, outcome, excludesDrop);

        // Assert
        expect(await ctx.fs.readUtf8(`${ctx.layout.workDir}/drop.txt`)).toBe('MERGED');
      });
    });
  });

  describe('Given an unchanged outcome whose path the sparse matcher excludes', () => {
    describe('When buildConflictIndexEntries runs', () => {
      it('Then its stage-0 entry is skip-worktree', () => {
        // Arrange
        const outcomes: MergeOutcome[] = [
          {
            status: 'unchanged',
            path: 'drop.txt' as FilePath,
            id: 'a'.repeat(40) as ObjectId,
            mode: FILE_MODE.REGULAR,
          },
        ];

        // Act
        const result = buildConflictIndexEntries(outcomes, [], excludesDrop, []);

        // Assert
        expect(result).toHaveLength(1);
        expect(result[0]?.path).toBe('drop.txt');
        expect(result[0]?.flags.stage).toBe(0);
        expect(result[0]?.flags.skipWorktree).toBe(true);
      });
    });
  });

  describe('Given a resolved-known outcome whose path the sparse matcher excludes', () => {
    describe('When buildConflictIndexEntries runs', () => {
      it('Then its stage-0 entry is skip-worktree', () => {
        // Arrange
        const outcomes: MergeOutcome[] = [
          {
            status: 'resolved-known',
            path: 'drop.txt' as FilePath,
            id: 'b'.repeat(40) as ObjectId,
            mode: FILE_MODE.REGULAR,
          },
        ];

        // Act
        const result = buildConflictIndexEntries(outcomes, [], excludesDrop, []);

        // Assert
        expect(result[0]?.flags.skipWorktree).toBe(true);
      });
    });
  });

  describe('Given an unchanged outcome whose path the sparse matcher includes', () => {
    describe('When buildConflictIndexEntries runs', () => {
      it('Then its stage-0 entry is not skip-worktree', () => {
        // Arrange
        const outcomes: MergeOutcome[] = [
          {
            status: 'unchanged',
            path: 'keep.txt' as FilePath,
            id: 'c'.repeat(40) as ObjectId,
            mode: FILE_MODE.REGULAR,
          },
        ];

        // Act
        const result = buildConflictIndexEntries(outcomes, [], excludesDrop, []);

        // Assert
        expect(result[0]?.flags.skipWorktree).toBe(false);
      });
    });
  });

  describe('Given a sparse repo', () => {
    describe('When a conflicting merge runs', () => {
      it('Then an excluded clean path is not re-materialised but the in-pattern conflict is', async () => {
        // Arrange — base has `src/a.txt` + `docs/b.txt`; main and feature each
        // change only `src/a.txt` (→ conflict). `docs/b.txt` is unchanged on every
        // side (→ a clean `unchanged` outcome). Sparse excludes `docs/`; the file
        // is removed from disk to mimic a sparse working tree.
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/src/a.txt`, 'base-a\n');
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/docs/b.txt`, 'shared-b\n');
        await add(ctx, ['src/a.txt', 'docs/b.txt']);
        await commit(ctx, { message: 'base', author });
        await branchCreate(ctx, { name: 'feature' });
        await checkout(ctx, { rev: 'feature' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/src/a.txt`, 'FEATURE-a\n');
        await add(ctx, ['src/a.txt']);
        await commit(ctx, { message: 'on-feature', author });
        await checkout(ctx, { rev: 'main' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/src/a.txt`, 'MAIN-a\n');
        await add(ctx, ['src/a.txt']);
        await commit(ctx, { message: 'on-main', author });
        await enableSparseSrcOnly(ctx);
        await ctx.fs.rm(`${ctx.layout.workDir}/docs/b.txt`);

        // Act
        const result = await mergeRun(ctx, { rev: 'feature', author });

        // Assert — the in-pattern conflict file is materialised with markers; the
        // excluded clean file stays absent (not re-materialised) and is recorded
        // skip-worktree.
        expect(result.kind).toBe('conflict');
        expect(await ctx.fs.readUtf8(`${ctx.layout.workDir}/src/a.txt`)).toContain('<<<<<<<');
        expect(await ctx.fs.exists(`${ctx.layout.workDir}/docs/b.txt`)).toBe(false);
        const { readIndex } = await import('../../../../src/application/primitives/read-index.js');
        const index = await readIndex(ctx);
        expect(index.entries.find((e) => e.path === 'docs/b.txt')?.flags.skipWorktree).toBe(true);
        const srcStages = index.entries
          .filter((e) => e.path === 'src/a.txt')
          .map((e) => e.flags.stage)
          .sort((a, b) => a - b);
        expect(srcStages).toEqual([1, 2, 3]);
      });
    });
  });
});

describe('asMergeDirtyError (direct)', () => {
  describe('Given a CHECKOUT_OVERWRITE_DIRTY error', () => {
    describe('When asMergeDirtyError maps it', () => {
      it('Then returns WORKING_TREE_DIRTY carrying the same classes', () => {
        // Arrange
        const original = checkoutOverwriteDirty({
          localChanges: ['x.txt' as FilePath],
          untracked: [],
        });

        // Act
        const result = asMergeDirtyError(original);

        // Assert
        expect(result).toBeInstanceOf(TsgitError);
        const data = (result as TsgitError).data;
        expect(data.code).toBe('WORKING_TREE_DIRTY');
        if (data.code === 'WORKING_TREE_DIRTY') {
          expect(data.localChanges).toEqual(['x.txt']);
          expect(data.untracked).toEqual([]);
        }
      });
    });
  });

  describe('Given a TsgitError with a different code', () => {
    describe('When asMergeDirtyError maps it', () => {
      it('Then returns the original error unchanged', () => {
        // Arrange
        const original = new TsgitError({ code: 'NOTHING_TO_COMMIT' });

        // Act
        const result = asMergeDirtyError(original);

        // Assert
        expect(result).toBe(original);
      });
    });
  });

  describe('Given a non-TsgitError value', () => {
    describe('When asMergeDirtyError maps it', () => {
      it('Then returns it unchanged', () => {
        // Arrange
        const original = new Error('boom');

        // Act
        const result = asMergeDirtyError(original);

        // Assert
        expect(result).toBe(original);
      });
    });
  });
});

describe('merge — post-merge hook', () => {
  const hookedCtx = (runner: MemoryHookRunner): ReturnType<typeof createMemoryContext> =>
    createMemoryContext({ hooks: runner });

  describe('Given a fast-forwardable target', () => {
    describe('When merge fast-forwards', () => {
      it('Then post-merge fires once with the squash flag off', async () => {
        // Arrange
        const runner = new MemoryHookRunner();
        const ctx = hookedCtx(runner);
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
        await add(ctx, ['a.txt']);
        await commit(ctx, { message: 'first', author });
        await branchCreate(ctx, { name: 'feature' });
        await checkout(ctx, { rev: 'feature' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/b.txt`, 'b');
        await add(ctx, ['b.txt']);
        await commit(ctx, { message: 'second', author });
        await checkout(ctx, { rev: 'main' });

        // Act
        const result = await mergeRun(ctx, { rev: 'feature' });

        // Assert
        expect(result.kind).toBe('fast-forward');
        const postMerge = runner.calls.filter((c) => c.name === 'post-merge');
        expect(postMerge).toHaveLength(1);
        expect(postMerge[0]?.args).toEqual(['0']);
      });
    });
  });

  describe('Given diverged histories with non-conflicting paths', () => {
    describe('When merge makes a clean true-merge', () => {
      it('Then post-merge fires once with the squash flag off', async () => {
        // Arrange
        const runner = new MemoryHookRunner();
        const ctx = hookedCtx(runner);
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/f.txt`, 'base\n');
        await add(ctx, ['f.txt']);
        await commit(ctx, { message: 'base', author });
        await branchCreate(ctx, { name: 'theirs' });
        await checkout(ctx, { rev: 'theirs' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/m.txt`, 'm\n');
        await add(ctx, ['m.txt']);
        await commit(ctx, { message: 'theirs-add', author });
        await checkout(ctx, { rev: 'main' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a\n');
        await add(ctx, ['a.txt']);
        await commit(ctx, { message: 'ours-add', author });

        // Act
        const result = await mergeRun(ctx, { rev: 'theirs', author });

        // Assert
        expect(result.kind).toBe('merge');
        const postMerge = runner.calls.filter((c) => c.name === 'post-merge');
        expect(postMerge).toHaveLength(1);
        expect(postMerge[0]?.args).toEqual(['0']);
      });
    });
  });

  describe('Given a target equal to HEAD', () => {
    describe('When merge is up-to-date', () => {
      it('Then post-merge does not fire', async () => {
        // Arrange
        const runner = new MemoryHookRunner();
        const ctx = hookedCtx(runner);
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
        await add(ctx, ['a.txt']);
        const c = await commit(ctx, { message: 'first', author });

        // Act
        const result = await mergeRun(ctx, { rev: c.id });

        // Assert
        expect(result.kind).toBe('up-to-date');
        expect(runner.calls.some((call) => call.name === 'post-merge')).toBe(false);
      });
    });
  });

  describe('Given conflicting modifications to the same file', () => {
    describe('When merge conflicts', () => {
      it('Then post-merge does not fire', async () => {
        // Arrange
        const runner = new MemoryHookRunner();
        const ctx = hookedCtx(runner);
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file.txt`, 'shared\n');
        await add(ctx, ['file.txt']);
        await commit(ctx, { message: 'base', author });
        await branchCreate(ctx, { name: 'feature' });
        await checkout(ctx, { rev: 'feature' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file.txt`, 'FEATURE-CHANGE\n');
        await add(ctx, ['file.txt']);
        await commit(ctx, { message: 'on-feature', author });
        await checkout(ctx, { rev: 'main' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file.txt`, 'MAIN-CHANGE\n');
        await add(ctx, ['file.txt']);
        await commit(ctx, { message: 'on-main', author });

        // Act
        const result = await mergeRun(ctx, { rev: 'feature', author });

        // Assert
        expect(result.kind).toBe('conflict');
        expect(runner.calls.some((call) => call.name === 'post-merge')).toBe(false);
      });
    });
  });

  describe('Given a post-merge hook that exits non-zero on a clean merge', () => {
    describe('When merge runs', () => {
      it('Then the merge result still returns (informational hook)', async () => {
        // Arrange
        const runner = new MemoryHookRunner({
          'post-merge': { kind: 'ran', exitCode: 1, stdout: '', stderr: 'noisy' },
        });
        const ctx = hookedCtx(runner);
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
        await add(ctx, ['a.txt']);
        await commit(ctx, { message: 'first', author });
        await branchCreate(ctx, { name: 'feature' });
        await checkout(ctx, { rev: 'feature' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/b.txt`, 'b');
        await add(ctx, ['b.txt']);
        await commit(ctx, { message: 'second', author });
        await checkout(ctx, { rev: 'main' });

        // Act
        const result = await mergeRun(ctx, { rev: 'feature' });

        // Assert
        expect(result.kind).toBe('fast-forward');
      });
    });
  });
});

// ── Slice 4 tests ──────────────────────────────────────────────────────────────

describe('materialiseConflictBytes — add-add with conflictContent (slice 4)', () => {
  const seedBlob = async (
    ctx: ReturnType<typeof createMemoryContext>,
    text: string,
  ): Promise<ObjectId> =>
    writeObject(ctx, {
      type: 'blob',
      content: new TextEncoder().encode(text),
      id: '' as ObjectId,
    });
  const decode = (b: Uint8Array | undefined): string =>
    b === undefined ? '<undefined>' : new TextDecoder().decode(b);

  describe('Given an add-add conflict WITH conflictContent', () => {
    describe('When materialiseConflictBytes runs', () => {
      it('Then it returns conflictContent (not ours blob)', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        const oursId = await seedBlob(ctx, 'OURS-BYTES');
        const markerBytes = new TextEncoder().encode(
          '<<<<<<< HEAD\nOURS\n=======\nTHEIRS\n>>>>>>> feature\n',
        );
        const conflict: MergeConflict = {
          type: 'add-add',
          path: 'f.txt' as FilePath,
          ourId: oursId,
          ourMode: FILE_MODE.REGULAR,
          theirMode: FILE_MODE.REGULAR,
          conflictContent: markerBytes,
          contentVerdict: 'content',
        };

        // Act
        const result = await materialiseConflictBytes(ctx, conflict);

        // Assert — conflictContent is preferred over ours blob
        expect(decode(result)).toBe('<<<<<<< HEAD\nOURS\n=======\nTHEIRS\n>>>>>>> feature\n');
      });
    });
  });

  describe('Given a bare add-add conflict (no conflictContent)', () => {
    describe('When materialiseConflictBytes runs', () => {
      it('Then it returns the ours blob (existing behaviour)', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        const oursId = await seedBlob(ctx, 'OURS-SYMLINK-TARGET');
        const conflict: MergeConflict = {
          type: 'add-add',
          path: 'link' as FilePath,
          ourId: oursId,
          ourMode: FILE_MODE.SYMLINK,
          theirMode: FILE_MODE.SYMLINK,
        };

        // Act
        const result = await materialiseConflictBytes(ctx, conflict);

        // Assert — ours blob fallback
        expect(decode(result)).toBe('OURS-SYMLINK-TARGET');
      });
    });
  });
});

describe('merge — add-add content merge (slice 4, end-to-end)', () => {
  describe('Given two branches adding the same path with overlapping text', () => {
    describe('When merge runs', () => {
      it('Then the worktree file contains the content-merged marker bytes (not ours blob)', async () => {
        // Arrange — both branches add f.txt (unrelated histories: no common base),
        // with overlapping text that will conflict.
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/f.txt`, 'OURS-VERSION\n');
        await add(ctx, ['f.txt']);
        await commit(ctx, { message: 'ours-root', author });

        const theirsBlobId = await writeObject(ctx, {
          type: 'blob',
          content: new TextEncoder().encode('THEIRS-VERSION\n'),
          id: '' as ObjectId,
        });
        const { writeTree } = await import('../../../../src/application/primitives/write-tree.js');
        const { createCommit: createCommitPrim } = await import(
          '../../../../src/application/primitives/create-commit.js'
        );
        const { updateRef } = await import('../../../../src/application/primitives/update-ref.js');
        const theirsTreeId = await writeTree(ctx, [
          treeEntry(FILE_MODE.REGULAR, 'f.txt' as FilePath, theirsBlobId),
        ]);
        const theirsCommitId = await createCommitPrim(ctx, {
          tree: theirsTreeId,
          parents: [],
          author,
          committer: author,
          message: 'theirs-root',
          extraHeaders: [],
        });
        await updateRef(ctx, 'refs/heads/theirs' as RefName, theirsCommitId, {
          reflogMessage: 'branch: Created from seed',
        });

        // Act
        const result = await mergeRun(ctx, {
          rev: 'theirs',
          author,
          allowUnrelatedHistories: true,
        });

        // Assert — conflict kind and worktree carries marker bytes
        expect(result.kind).toBe('conflict');
        const onDisk = await ctx.fs.readUtf8(`${ctx.layout.workDir}/f.txt`);
        expect(onDisk).toContain('<<<<<<<');
        expect(onDisk).toContain('=======');
        expect(onDisk).toContain('>>>>>>>');
        expect(onDisk).toContain('OURS-VERSION');
        expect(onDisk).toContain('THEIRS-VERSION');
      });
    });
  });

  describe('Given two branches adding the same path as symlinks with different targets', () => {
    describe('When merge runs', () => {
      it('Then the worktree keeps ours symlink (bare add-add fallback)', async () => {
        // Arrange — both sides add a symlink at the same path (no common base)
        const ctx = createMemoryContext();
        await init(ctx);

        // Build ours commit: symlink 'link' → 'target-ours'
        const oursBlobId = await writeObject(ctx, {
          type: 'blob',
          content: new TextEncoder().encode('target-ours'),
          id: '' as ObjectId,
        });
        const { writeTree } = await import('../../../../src/application/primitives/write-tree.js');
        const { createCommit: createCommitPrim } = await import(
          '../../../../src/application/primitives/create-commit.js'
        );
        const { updateRef } = await import('../../../../src/application/primitives/update-ref.js');
        const oursTreeId = await writeTree(ctx, [
          treeEntry(FILE_MODE.SYMLINK, 'link' as FilePath, oursBlobId),
        ]);
        const oursCommitId = await createCommitPrim(ctx, {
          tree: oursTreeId,
          parents: [],
          author,
          committer: author,
          message: 'ours-root',
          extraHeaders: [],
        });
        await updateRef(ctx, 'refs/heads/main' as RefName, oursCommitId, {
          reflogMessage: 'branch: Created',
        });
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
        // Place the ours symlink on disk and stage it (a real checkout tracks it).
        await ctx.fs.symlink('target-ours', `${ctx.layout.workDir}/link`);
        await add(ctx, ['link']);

        // Build theirs commit: symlink 'link' → 'target-theirs'
        const theirsBlobId = await writeObject(ctx, {
          type: 'blob',
          content: new TextEncoder().encode('target-theirs'),
          id: '' as ObjectId,
        });
        const theirsTreeId = await writeTree(ctx, [
          treeEntry(FILE_MODE.SYMLINK, 'link' as FilePath, theirsBlobId),
        ]);
        const theirsCommitId = await createCommitPrim(ctx, {
          tree: theirsTreeId,
          parents: [],
          author,
          committer: author,
          message: 'theirs-root',
          extraHeaders: [],
        });
        await updateRef(ctx, 'refs/heads/theirs' as RefName, theirsCommitId, {
          reflogMessage: 'branch: Created from seed',
        });

        // Act
        const result = await mergeRun(ctx, {
          rev: 'theirs',
          author,
          allowUnrelatedHistories: true,
        });

        // Assert — bare add-add: ours symlink remains
        expect(result.kind).toBe('conflict');
        if (result.kind !== 'conflict') throw new Error('expected conflict');
        expect(result.conflicts[0]?.type).toBe('add-add');
        const target = await ctx.fs.readlink(`${ctx.layout.workDir}/link`);
        expect(target).toBe('target-ours');
      });
    });
  });
});

describe('merge — distinct-types conflict (slice 4, end-to-end)', () => {
  const buildUnrelatedCommit = async (
    ctx: ReturnType<typeof createMemoryContext>,
    branchName: string,
    entries: Array<{ name: string; content: string; mode: string }>,
  ): Promise<void> => {
    const { writeTree } = await import('../../../../src/application/primitives/write-tree.js');
    const { createCommit: createCommitPrim } = await import(
      '../../../../src/application/primitives/create-commit.js'
    );
    const { updateRef } = await import('../../../../src/application/primitives/update-ref.js');
    const treeEntries = await Promise.all(
      entries.map(async ({ name, content, mode }) => {
        const id = await writeObject(ctx, {
          type: 'blob',
          content: new TextEncoder().encode(content),
          id: '' as ObjectId,
        });
        return treeEntry(mode as never, name as FilePath, id);
      }),
    );
    const treeId = await writeTree(ctx, treeEntries);
    const commitId = await createCommitPrim(ctx, {
      tree: treeId,
      parents: [],
      author,
      committer: author,
      message: `${branchName}-root`,
      extraHeaders: [],
    });
    await updateRef(ctx, `refs/heads/${branchName}` as RefName, commitId, {
      reflogMessage: 'branch: Created from seed',
    });
  };

  describe('Given ours adds a regular file and theirs adds a symlink at the same path', () => {
    describe('When merge runs', () => {
      it('Then ours regular bytes are at f.txt~HEAD, theirs symlink is at f.txt, index has stage 2 at f.txt~HEAD and stage 3 at f.txt', async () => {
        // Arrange — ours adds regular file f.txt, theirs adds symlink f.txt → some-target
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/f.txt`, 'ours-regular-content\n');
        await add(ctx, ['f.txt']);
        await commit(ctx, { message: 'ours-root', author });

        await buildUnrelatedCommit(ctx, 'theirs', [
          { name: 'f.txt', content: 'some-target', mode: FILE_MODE.SYMLINK },
        ]);

        // Act
        const result = await mergeRun(ctx, {
          rev: 'theirs',
          author,
          allowUnrelatedHistories: true,
        });

        // Assert — conflict reported
        expect(result.kind).toBe('conflict');
        if (result.kind !== 'conflict') throw new Error('expected conflict');
        expect(result.conflicts[0]?.type).toBe('distinct-types');

        // Regular file at f.txt~HEAD (ours regular side renamed)
        const oursContent = await ctx.fs.readUtf8(`${ctx.layout.workDir}/f.txt~HEAD`);
        expect(oursContent).toBe('ours-regular-content\n');

        // Symlink at original path f.txt pointing to 'some-target'
        const linkTarget = await ctx.fs.readlink(`${ctx.layout.workDir}/f.txt`);
        expect(linkTarget).toBe('some-target');

        // Index: stage 2 at f.txt~HEAD (ours), stage 3 at f.txt (theirs)
        const index = await readIndex(ctx);
        const oursEntry = index.entries.find((e) => e.path === ('f.txt~HEAD' as FilePath));
        const theirsEntry = index.entries.find((e) => e.path === 'f.txt');
        expect(oursEntry?.flags.stage).toBe(2);
        expect(theirsEntry?.flags.stage).toBe(3);
      });
    });
  });

  describe('Given ours adds a symlink and theirs adds a regular file at the same path', () => {
    describe('When merge runs', () => {
      it('Then theirs regular bytes are at f.txt~theirs, ours symlink is at f.txt, index has stage 2 at f.txt and stage 3 at f.txt~theirs', async () => {
        // Arrange — ours adds symlink f.txt → some-target, theirs adds regular file f.txt
        const ctx = createMemoryContext();
        await init(ctx);

        // Set up ours root commit with a symlink
        const { writeTree } = await import('../../../../src/application/primitives/write-tree.js');
        const { createCommit: createCommitPrim } = await import(
          '../../../../src/application/primitives/create-commit.js'
        );
        const { updateRef } = await import('../../../../src/application/primitives/update-ref.js');
        const oursBlobId = await writeObject(ctx, {
          type: 'blob',
          content: new TextEncoder().encode('some-target'),
          id: '' as ObjectId,
        });
        const oursTreeId = await writeTree(ctx, [
          treeEntry(FILE_MODE.SYMLINK, 'f.txt' as FilePath, oursBlobId),
        ]);
        const oursCommitId = await createCommitPrim(ctx, {
          tree: oursTreeId,
          parents: [],
          author,
          committer: author,
          message: 'ours-root',
          extraHeaders: [],
        });
        await updateRef(ctx, 'refs/heads/main' as RefName, oursCommitId, {
          reflogMessage: 'branch: Created',
        });
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
        // Place ours symlink on disk and stage it (a real checkout tracks it).
        await ctx.fs.symlink('some-target', `${ctx.layout.workDir}/f.txt`);
        await add(ctx, ['f.txt']);

        await buildUnrelatedCommit(ctx, 'theirs', [
          { name: 'f.txt', content: 'theirs-regular-content\n', mode: FILE_MODE.REGULAR },
        ]);

        // Act
        const result = await mergeRun(ctx, {
          rev: 'theirs',
          author,
          allowUnrelatedHistories: true,
        });

        // Assert — conflict reported
        expect(result.kind).toBe('conflict');
        if (result.kind !== 'conflict') throw new Error('expected conflict');
        expect(result.conflicts[0]?.type).toBe('distinct-types');

        // Regular file at f.txt~theirs (theirs' regular side renamed)
        const theirsContent = await ctx.fs.readUtf8(`${ctx.layout.workDir}/f.txt~theirs`);
        expect(theirsContent).toBe('theirs-regular-content\n');

        // Symlink at original path f.txt pointing to 'some-target' (ours)
        const linkTarget = await ctx.fs.readlink(`${ctx.layout.workDir}/f.txt`);
        expect(linkTarget).toBe('some-target');

        // Index: stage 2 at f.txt (ours), stage 3 at f.txt~theirs (theirs)
        const index = await readIndex(ctx);
        const oursEntry = index.entries.find((e) => e.path === 'f.txt');
        const theirsEntry = index.entries.find((e) => e.path === ('f.txt~theirs' as FilePath));
        expect(oursEntry?.flags.stage).toBe(2);
        expect(theirsEntry?.flags.stage).toBe(3);
      });
    });
  });
});

describe('merge — labels threading (slice 4)', () => {
  describe('Given ours and theirs add the same path (unrelated histories)', () => {
    describe('When merge runs with rev=feature', () => {
      it('Then conflict markers carry HEAD and feature labels', async () => {
        // Arrange — two unrelated commits adding the same file with different content
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/f.txt`, 'OURS-CONTENT\n');
        await add(ctx, ['f.txt']);
        await commit(ctx, { message: 'ours-root', author });

        const theirsBlobId = await writeObject(ctx, {
          type: 'blob',
          content: new TextEncoder().encode('THEIRS-CONTENT\n'),
          id: '' as ObjectId,
        });
        const { writeTree } = await import('../../../../src/application/primitives/write-tree.js');
        const { createCommit: createCommitPrim } = await import(
          '../../../../src/application/primitives/create-commit.js'
        );
        const { updateRef } = await import('../../../../src/application/primitives/update-ref.js');
        const theirsTreeId = await writeTree(ctx, [
          treeEntry(FILE_MODE.REGULAR, 'f.txt' as FilePath, theirsBlobId),
        ]);
        const theirsCommitId = await createCommitPrim(ctx, {
          tree: theirsTreeId,
          parents: [],
          author,
          committer: author,
          message: 'theirs-root',
          extraHeaders: [],
        });
        await updateRef(ctx, 'refs/heads/feature' as RefName, theirsCommitId, {
          reflogMessage: 'branch: Created from seed',
        });

        // Act
        await mergeRun(ctx, { rev: 'feature', author, allowUnrelatedHistories: true });

        // Assert — conflict markers use HEAD and feature labels
        const onDisk = await ctx.fs.readUtf8(`${ctx.layout.workDir}/f.txt`);
        expect(onDisk).toContain('<<<<<<< HEAD\n');
        expect(onDisk).toContain('>>>>>>> feature\n');
      });
    });
  });
});

describe('writeConflictToTree (direct)', () => {
  const seedBlob = async (
    ctx: ReturnType<typeof createMemoryContext>,
    text: string,
  ): Promise<ObjectId> =>
    writeObject(ctx, {
      type: 'blob',
      content: new TextEncoder().encode(text),
      id: '' as ObjectId,
    });
  const conflictOf = (over: Partial<MergeConflict>): MergeConflict =>
    ({ path: 'p' as FilePath, ...over }) as MergeConflict;

  // Symlink survivor — writeConflictToTree recreates the symlink rather than writing bytes
  describe('Given a conflict whose winning side is a symlink', () => {
    describe('When writeConflictToTree runs', () => {
      it.each([
        {
          label: 'ours symlink is re-created at the path (not target bytes as a regular file)',
          expectedTarget: 'ours-target',
          build: async (ctx: ReturnType<typeof createMemoryContext>) => {
            const oursId = await seedBlob(ctx, 'ours-target');
            const theirsId = await seedBlob(ctx, 'theirs-target');
            const baseId = await seedBlob(ctx, 'base-file-content');
            return conflictOf({
              type: 'content',
              ourId: oursId,
              theirId: theirsId,
              baseId,
              ourMode: FILE_MODE.SYMLINK,
              theirMode: FILE_MODE.SYMLINK,
              baseMode: FILE_MODE.REGULAR,
            });
          },
        },
        {
          label: 'the survivor symlink is re-created at the path (modify-delete)',
          expectedTarget: 'survivor-target',
          build: async (ctx: ReturnType<typeof createMemoryContext>) =>
            conflictOf({
              type: 'modify-delete',
              theirId: await seedBlob(ctx, 'survivor-target'),
              theirMode: FILE_MODE.SYMLINK,
              // ourId/ourMode are undefined: ours deleted the path
            }),
        },
        {
          label:
            'ours symlink is re-created at the path (useMode generalised beyond add-add, bare type-change)',
          expectedTarget: 'symlink-target',
          build: async (ctx: ReturnType<typeof createMemoryContext>) =>
            conflictOf({
              type: 'type-change',
              ourId: await seedBlob(ctx, 'symlink-target'),
              ourMode: FILE_MODE.SYMLINK,
            }),
        },
      ])('Then $label', async ({ expectedTarget, build }) => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        const conflict = await build(ctx);

        // Act
        await writeConflictToTree(ctx, conflict);

        // Assert — lstat reveals a symlink pointing at the expected target
        const stat = await ctx.fs.lstat(`${ctx.layout.workDir}/p`);
        expect(stat.isSymbolicLink).toBe(true);
        const target = await ctx.fs.readlink(`${ctx.layout.workDir}/p`);
        expect(target).toBe(expectedTarget);
      });
    });
  });

  // Marker-bytes conflict with ourMode 100755 — exec bit preserved
  describe('Given a content conflict with conflictContent and executable ourMode', () => {
    describe('When writeConflictToTree runs', () => {
      it('Then the marker file is written with exec mode (chmod 0o755 called)', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        const chmodSpy = vi.spyOn(ctx.fs, 'chmod');
        const conflict = conflictOf({
          type: 'content',
          conflictContent: new TextEncoder().encode(
            '<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> side\n',
          ),
          ourMode: FILE_MODE.EXECUTABLE,
        });

        // Act
        await writeConflictToTree(ctx, conflict);

        // Assert — chmod called with exec permission
        expect(chmodSpy).toHaveBeenCalledWith(`${ctx.layout.workDir}/p`, 0o755);
      });
    });
  });

  // Marker bytes carry the three-way-merged mode, not ours' stage mode
  describe('Given a content conflict where mergedMode is executable but ourMode is regular', () => {
    describe('When writeConflictToTree runs', () => {
      it('Then the marker file is written with the merged exec mode', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        const chmodSpy = vi.spyOn(ctx.fs, 'chmod');
        const conflict = conflictOf({
          type: 'content',
          conflictContent: new TextEncoder().encode(
            '<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> side\n',
          ),
          ourMode: FILE_MODE.REGULAR,
          theirMode: FILE_MODE.EXECUTABLE,
          mergedMode: FILE_MODE.EXECUTABLE,
        });

        // Act
        await writeConflictToTree(ctx, conflict);

        // Assert — merged mode wins over ours' stage mode
        expect(chmodSpy).toHaveBeenCalledWith(`${ctx.layout.workDir}/p`, 0o755);
      });
    });
  });

  // Refusal seam: no mode at all — nothing is written, no blob is read
  describe('Given a conflict carrying conflictContent but no mode on any field', () => {
    describe('When writeConflictToTree runs', () => {
      it('Then nothing is written at the path', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        const conflict = conflictOf({
          type: 'content',
          conflictContent: new TextEncoder().encode('marker-bytes\n'),
        });

        // Act
        await writeConflictToTree(ctx, conflict);

        // Assert — no file materialised
        expect(await ctx.fs.exists(`${ctx.layout.workDir}/p`)).toBe(false);
      });
    });
  });

  // A conflict's path still reaches `.git/index` via `conflictsToIndexEntries`
  // even when no mode can be derived — the mode-derived guard must not also
  // skip path validation.
  describe('Given a hostile-named conflict carrying conflictContent but no mode on any field', () => {
    describe('When writeConflictToTree runs', () => {
      it('Then throws INVALID_INDEX_ENTRY before any write is attempted', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        const conflict = conflictOf({
          path: '..' as FilePath,
          type: 'content',
          conflictContent: new TextEncoder().encode('marker-bytes\n'),
        });

        // Act
        let caught: unknown;
        try {
          await writeConflictToTree(ctx, conflict);
        } catch (err) {
          caught = err;
        }

        // Assert
        const data = (caught as { data?: { code?: string; reason?: string; offset?: number } })
          ?.data;
        expect(data?.code).toBe('INVALID_INDEX_ENTRY');
        expect(data?.reason).toBe("'..' segment rejected");
        expect(data?.offset).toBe(NO_PARSER_OFFSET);
      });
    });
  });

  // Refusal seam: mode defined but no derivable bytes — no write, no throw
  describe('Given a bare add-add conflict with only theirId and theirMode', () => {
    describe('When writeConflictToTree runs', () => {
      it('Then nothing is written at the path', async () => {
        // Arrange — conflictContent absent and ourId absent, so no bytes can be derived
        // while the theirs mode is present
        const ctx = createMemoryContext();
        await init(ctx);
        const theirsId = await seedBlob(ctx, 'theirs-only');
        const conflict = conflictOf({
          type: 'add-add',
          theirId: theirsId,
          theirMode: FILE_MODE.REGULAR,
        });

        // Act
        await writeConflictToTree(ctx, conflict);

        // Assert — no file materialised
        expect(await ctx.fs.exists(`${ctx.layout.workDir}/p`)).toBe(false);
      });
    });
  });

  // Once flatten-raw stops refusing `.`/`..` at parse, a merged tree carrying
  // such a name reaches this writer for the first time — it must refuse
  // before any blob is read or any bytes are written.
  describe('Given a conflict path named "."', () => {
    describe('When writeConflictToTree runs', () => {
      it('Then throws INVALID_INDEX_ENTRY before any write is attempted', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        const writeSpy = vi.spyOn(writeFileMod, 'writeWorkingTreeEntry');
        const conflict = conflictOf({
          path: '.' as FilePath,
          type: 'add-add',
          ourId: await seedBlob(ctx, 'ours'),
          ourMode: FILE_MODE.REGULAR,
          theirId: await seedBlob(ctx, 'theirs'),
          theirMode: FILE_MODE.REGULAR,
        });

        // Act
        let caught: unknown;
        let writeCallCount: number;
        try {
          await writeConflictToTree(ctx, conflict);
        } catch (err) {
          caught = err;
        } finally {
          writeCallCount = writeSpy.mock.calls.length;
          writeSpy.mockRestore();
        }

        // Assert
        const data = (caught as { data?: { code?: string; reason?: string; offset?: number } })
          ?.data;
        expect(data?.code).toBe('INVALID_INDEX_ENTRY');
        expect(data?.reason).toBe("'.' segment rejected");
        expect(data?.offset).toBe(NO_PARSER_OFFSET);
        expect(writeCallCount).toBe(0);
      });
    });
  });

  describe('Given a conflict path named ".."', () => {
    describe('When writeConflictToTree runs', () => {
      it('Then throws INVALID_INDEX_ENTRY before any write is attempted', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        const writeSpy = vi.spyOn(writeFileMod, 'writeWorkingTreeEntry');
        const conflict = conflictOf({
          path: '..' as FilePath,
          type: 'add-add',
          ourId: await seedBlob(ctx, 'ours'),
          ourMode: FILE_MODE.REGULAR,
          theirId: await seedBlob(ctx, 'theirs'),
          theirMode: FILE_MODE.REGULAR,
        });

        // Act
        let caught: unknown;
        let writeCallCount: number;
        try {
          await writeConflictToTree(ctx, conflict);
        } catch (err) {
          caught = err;
        } finally {
          writeCallCount = writeSpy.mock.calls.length;
          writeSpy.mockRestore();
        }

        // Assert
        const data = (caught as { data?: { code?: string; reason?: string; offset?: number } })
          ?.data;
        expect(data?.code).toBe('INVALID_INDEX_ENTRY');
        expect(data?.reason).toBe("'..' segment rejected");
        expect(data?.offset).toBe(NO_PARSER_OFFSET);
        expect(writeCallCount).toBe(0);
      });
    });
  });
});

describe('merge ORIG_HEAD', () => {
  type Ctx = ReturnType<typeof createMemoryContext>;

  const origHeadPath = (ctx: Ctx): string => `${ctx.layout.gitDir}/ORIG_HEAD`;

  const commitFile = async (ctx: Ctx, name: string, message: string): Promise<ObjectId> => {
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/${name}`, name);
    await add(ctx, [name]);
    return (await commit(ctx, { message, author })).id;
  };

  const seedBase = async (ctx: Ctx): Promise<ObjectId> => {
    await init(ctx);
    return commitFile(ctx, 'a.txt', 'base');
  };

  /** main = base, feature = base + b.txt; HEAD on main. */
  const featureAhead = async (ctx: Ctx): Promise<{ main: ObjectId; feature: ObjectId }> => {
    const main = await seedBase(ctx);
    await branchCreate(ctx, { name: 'feature' });
    await checkout(ctx, { rev: 'feature' });
    const feature = await commitFile(ctx, 'b.txt', 'on-feature');
    await checkout(ctx, { rev: 'main' });
    return { main, feature };
  };

  /** feature = base, main = base + c.txt; HEAD on main. */
  const mainAhead = async (ctx: Ctx): Promise<{ main: ObjectId }> => {
    await seedBase(ctx);
    await branchCreate(ctx, { name: 'feature' });
    return { main: await commitFile(ctx, 'c.txt', 'on-main') };
  };

  /** Both branches add a different file; HEAD on main. */
  const diverged = async (ctx: Ctx): Promise<{ main: ObjectId }> => {
    await featureAhead(ctx);
    return { main: await commitFile(ctx, 'c.txt', 'on-main') };
  };

  describe('Given the target is the current HEAD commit', () => {
    describe('When merge reports up-to-date', () => {
      it('Then ORIG_HEAD records HEAD', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const main = await seedBase(ctx);

        // Act
        await mergeRun(ctx, { rev: main });

        // Assert
        expect(await ctx.fs.readUtf8(origHeadPath(ctx))).toBe(`${main}\n`);
      });
    });
  });

  describe('Given the target is an ancestor of HEAD', () => {
    describe('When merge reports up-to-date', () => {
      it('Then ORIG_HEAD records HEAD', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const { main } = await mainAhead(ctx);

        // Act
        await mergeRun(ctx, { rev: 'feature' });

        // Assert
        expect(await ctx.fs.readUtf8(origHeadPath(ctx))).toBe(`${main}\n`);
      });
    });
  });

  describe('Given the target is ahead of HEAD', () => {
    describe('When merge fast-forwards', () => {
      it('Then ORIG_HEAD records the pre-merge HEAD', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const { main } = await featureAhead(ctx);

        // Act
        await mergeRun(ctx, { rev: 'feature' });

        // Assert
        expect(await ctx.fs.readUtf8(origHeadPath(ctx))).toBe(`${main}\n`);
      });
    });

    describe("When merge runs with fastForward 'never'", () => {
      it('Then ORIG_HEAD records the pre-merge HEAD', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const { main } = await featureAhead(ctx);

        // Act
        await mergeRun(ctx, { rev: 'feature', fastForward: 'never', author });

        // Assert
        expect(await ctx.fs.readUtf8(origHeadPath(ctx))).toBe(`${main}\n`);
      });
    });

    describe('When a clean true merge commits', () => {
      it('Then ORIG_HEAD records the pre-merge HEAD and no reflog is written for it', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const { main } = await diverged(ctx);

        // Act
        await mergeRun(ctx, { rev: 'feature', author });

        // Assert
        expect(await ctx.fs.readUtf8(origHeadPath(ctx))).toBe(`${main}\n`);
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/logs/ORIG_HEAD`)).toBe(false);
      });
    });
  });

  describe("Given diverged histories and fastForward 'only'", () => {
    describe('When merge refuses', () => {
      it('Then ORIG_HEAD records HEAD', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const { main } = await diverged(ctx);

        // Act
        await mergeRun(ctx, { rev: 'feature', fastForward: 'only' }).catch(() => undefined);

        // Assert
        expect(await ctx.fs.readUtf8(origHeadPath(ctx))).toBe(`${main}\n`);
      });
    });
  });

  describe('Given an untracked file the merge would overwrite', () => {
    describe('When merge refuses', () => {
      it('Then ORIG_HEAD records HEAD', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const { main } = await diverged(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/b.txt`, 'untracked');

        // Act
        await mergeRun(ctx, { rev: 'feature', author }).catch(() => undefined);

        // Assert
        expect(await ctx.fs.readUtf8(origHeadPath(ctx))).toBe(`${main}\n`);
      });
    });
  });

  describe('Given a rev that does not resolve', () => {
    describe('When merge refuses', () => {
      it('Then ORIG_HEAD is not written', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedBase(ctx);

        // Act
        await mergeRun(ctx, { rev: 'nope' }).catch(() => undefined);

        // Assert
        expect(await ctx.fs.exists(origHeadPath(ctx))).toBe(false);
      });
    });
  });

  describe('Given a merge already pending', () => {
    describe('When merge refuses', () => {
      it('Then ORIG_HEAD is not rewritten', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await diverged(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/c.txt`, 'c');
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/MERGE_HEAD`, `${'a'.repeat(40)}\n`);

        // Act
        await mergeRun(ctx, { rev: 'feature', author }).catch(() => undefined);

        // Assert
        expect(await ctx.fs.exists(origHeadPath(ctx))).toBe(false);
      });
    });
  });
});

describe('Given an alternate that fails to load', () => {
  type Ctx = ReturnType<typeof createMemoryContext>;

  const seedDiverged = async (): Promise<{ ctx: Ctx; main: ObjectId }> => {
    const ctx = createMemoryContext();
    await init(ctx);
    const commitFile = async (name: string, message: string): Promise<ObjectId> => {
      await ctx.fs.writeUtf8(`${ctx.layout.workDir}/${name}`, name);
      await add(ctx, [name]);
      return (await commit(ctx, { message, author })).id;
    };
    await commitFile('a.txt', 'base');
    await branchCreate(ctx, { name: 'feature' });
    await checkout(ctx, { rev: 'feature' });
    await commitFile('b.txt', 'on-feature');
    await checkout(ctx, { rev: 'main' });
    return { ctx, main: await commitFile('c.txt', 'on-main') };
  };

  describe('When mergeRun targets the current HEAD commit', () => {
    it('Then it rejects with the alternate error before writing anything', async () => {
      // Arrange
      const { ctx, main } = await seedDiverged();
      const before = await snapshotFiles(ctx);
      const loadError = await failSourceLoad(ctx);
      const sut = mergeRun;

      // Act — git's get_merge_parent parses the named object before ORIG_HEAD is written
      const attempt = sut(ctx, { rev: main, author, message: 'm' });

      // Assert
      await expect(attempt).rejects.toBe(loadError);
      const result = await snapshotFiles(ctx);
      expect(result).toEqual(before);
      vi.restoreAllMocks();
    });
  });
});

describe('merge default message', () => {
  const USER_CONFIG = '[user]\n  name = Grace\n  email = grace@example.com\n';

  /** main and feature each add one file over a shared base; HEAD on `branch`. */
  const divergedRepo = async (
    config = '',
    branch = 'main',
  ): Promise<{ readonly ctx: Context; readonly feature: ObjectId }> => {
    const ctx = createMemoryContext();
    await init(ctx);
    await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, `${USER_CONFIG}${config}`);
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
    await add(ctx, ['a.txt']);
    await commit(ctx, { message: 'base', author });
    await branchCreate(ctx, { name: 'feature' });
    await checkout(ctx, { rev: 'feature' });
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/b.txt`, 'b');
    await add(ctx, ['b.txt']);
    const feature = (await commit(ctx, { message: 'on-feature', author })).id;
    await checkout(ctx, { rev: 'main' });
    if (branch !== 'main') {
      await branchCreate(ctx, { name: branch });
      await checkout(ctx, { rev: branch });
    }
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/c.txt`, 'c');
    await add(ctx, ['c.txt']);
    await commit(ctx, { message: 'on-main', author });
    return { ctx, feature };
  };

  const mergedMessage = async (ctx: Context, rev: string): Promise<string> => {
    const result = await mergeRun(ctx, { rev, author });
    if (result.kind !== 'merge') throw new Error(`expected a merge, got ${result.kind}`);
    const merged = await readObject(ctx, result.id);
    if (merged.type !== 'commit') throw new Error('not a commit');
    return merged.data.message;
  };

  describe('Given a local branch merged into main', () => {
    describe('When merged without a message', () => {
      it("Then the message is git's branch title with the destination suppressed", async () => {
        // Arrange
        const { ctx } = await divergedRepo();
        const sut = mergedMessage;

        // Act
        const result = await sut(ctx, 'feature');

        // Assert
        expect(result).toBe("Merge branch 'feature'\n");
      });
    });
  });

  describe('Given a local branch merged into a branch git does not suppress', () => {
    describe('When merged without a message', () => {
      it('Then the title names the destination', async () => {
        // Arrange
        const { ctx } = await divergedRepo('', 'topic');
        const sut = mergedMessage;

        // Act
        const result = await sut(ctx, 'feature');

        // Assert
        expect(result).toBe("Merge branch 'feature' into topic\n");
      });
    });
  });

  describe('Given the branch named by its full ref', () => {
    describe('When merged without a message', () => {
      it('Then the title quotes the name as given', async () => {
        // Arrange
        const { ctx } = await divergedRepo();
        const sut = mergedMessage;

        // Act
        const result = await sut(ctx, 'refs/heads/feature');

        // Assert
        expect(result).toBe("Merge branch 'refs/heads/feature'\n");
      });
    });
  });

  describe('Given a lightweight tag at the feature tip', () => {
    describe('When merged without a message', () => {
      it('Then the title names the tag', async () => {
        // Arrange
        const { ctx } = await divergedRepo();
        await tagCreate(ctx, { name: 'lt', target: 'feature' });
        const sut = mergedMessage;

        // Act
        const result = await sut(ctx, 'lt');

        // Assert
        expect(result).toBe("Merge tag 'lt'\n");
      });
    });
  });

  describe('Given an annotated tag at the feature tip', () => {
    describe('When merged without a message', () => {
      it("Then the tag's message follows the title", async () => {
        // Arrange
        const { ctx } = await divergedRepo();
        await tagCreate(ctx, { name: 'at', target: 'feature', message: 'tag body line' });
        const sut = mergedMessage;

        // Act
        const result = await sut(ctx, 'at');

        // Assert
        expect(result).toBe("Merge tag 'at'\n\ntag body line\n");
      });
    });
  });

  describe('Given refs outside the labelled namespaces', () => {
    describe('When an annotated tag is merged through one without a message', () => {
      it('Then the title names a tag by that ref and its message follows', async () => {
        // Arrange
        const { ctx } = await divergedRepo();
        const tag = await tagCreate(ctx, { name: 'at', target: 'feature', message: 'body' });
        await seedRef(ctx, 'refs/custom/at' as RefName, tag.id, { reflogMessage: 'seed' });
        const sut = mergedMessage;

        // Act
        const result = await sut(ctx, 'refs/custom/at');

        // Assert
        expect(result).toBe("Merge tag 'refs/custom/at'\n\nbody\n");
      });
    });

    describe('When a commit is merged through one without a message', () => {
      it('Then the title names a commit by that ref', async () => {
        // Arrange
        const { ctx, feature } = await divergedRepo();
        await seedRef(ctx, 'refs/custom/c' as RefName, feature, { reflogMessage: 'seed' });
        const sut = mergedMessage;

        // Act
        const result = await sut(ctx, 'refs/custom/c');

        // Assert
        expect(result).toBe("Merge commit 'refs/custom/c'\n");
      });
    });
  });

  describe('Given a remote-tracking branch at the feature tip', () => {
    describe('When merged without a message', () => {
      it('Then the title names the remote-tracking branch', async () => {
        // Arrange
        const { ctx, feature } = await divergedRepo();
        await seedRef(ctx, 'refs/remotes/origin/feature' as RefName, feature, {
          reflogMessage: 'seed',
        });
        const sut = mergedMessage;

        // Act
        const result = await sut(ctx, 'origin/feature');

        // Assert
        expect(result).toBe("Merge remote-tracking branch 'origin/feature'\n");
      });
    });
  });

  describe('Given the feature commit named by a full and an abbreviated id', () => {
    describe.each([
      ['full', (id: string) => id],
      ['abbreviated', (id: string) => id.slice(0, 7)],
    ])('When merged by its %s id without a message', (_label, name) => {
      it('Then the title names the commit as given', async () => {
        // Arrange
        const { ctx, feature } = await divergedRepo();
        const sut = mergedMessage;

        // Act
        const result = await sut(ctx, name(feature));

        // Assert
        expect(result).toBe(`Merge commit '${name(feature)}'\n`);
      });
    });
  });

  describe('Given merge.suppressDest patterns', () => {
    describe.each([
      ['a glob matching the destination', '[merge]\n  suppressDest = top*\n', 'topic', ''],
      [
        'a pattern list replacing the defaults',
        '[merge]\n  suppressDest = x\n',
        'main',
        ' into main',
      ],
      ['an empty value clearing them', '[merge]\n  suppressDest =\n', 'main', ' into main'],
      ['a glob that does not cross a slash', '[merge]\n  suppressDest = a*\n', 'a/b', ' into a/b'],
    ])('When merging into a branch under %s', (_label, config, branch, into) => {
      it('Then the destination is named only when no pattern matches', async () => {
        // Arrange
        const { ctx } = await divergedRepo(config, branch);
        const sut = mergedMessage;

        // Act
        const result = await sut(ctx, 'feature');

        // Assert
        expect(result).toBe(`Merge branch 'feature'${into}\n`);
      });
    });
  });

  describe('Given a valueless merge.suppressDest', () => {
    describe('When merging', () => {
      it('Then it refuses with the missing value before merging', async () => {
        // Arrange
        const { ctx } = await divergedRepo('[merge]\n  suppressDest\n');
        const sut = mergeRun;

        // Act
        const error = await sut(ctx, { rev: 'feature', author }).catch((e: unknown) => e);

        // Assert
        expect((error as TsgitError).data).toMatchObject({
          code: 'CONFIG_MISSING_VALUE',
          key: 'merge.suppressdest',
        });
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/ORIG_HEAD`)).toBe(false);
      });
    });
  });

  describe('Given a merge that conflicts', () => {
    describe('When merged without a message', () => {
      it("Then MERGE_MSG carries git's title and the conflicted paths block", async () => {
        // Arrange
        const { ctx } = await divergedRepo();
        await checkout(ctx, { rev: 'feature' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/z.txt`, 'theirs');
        await add(ctx, ['z.txt']);
        await commit(ctx, { message: 'z theirs', author });
        await checkout(ctx, { rev: 'main' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/z.txt`, 'ours');
        await add(ctx, ['z.txt']);
        await commit(ctx, { message: 'z ours', author });
        const sut = mergeRun;

        // Act
        await sut(ctx, { rev: 'feature', author });

        // Assert
        const result = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/MERGE_MSG`);
        expect(result).toBe("Merge branch 'feature'\n\n# Conflicts:\n#\tz.txt\n");
      });
    });
  });
});

describe('merge — several heads (octopus)', () => {
  const t: AuthorIdentity = {
    name: 't',
    email: 't@t',
    timestamp: 1_700_000_000,
    timezoneOffset: '+0000',
  };

  const commitFile = async (
    ctx: Context,
    name: string,
    message: string,
    content = `${message}\n`,
  ): Promise<void> => {
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/${name}`, content);
    await add(ctx, [name]);
    await commit(ctx, { message, author: t, committer: t });
  };

  const branchFromMain = async (ctx: Context, name: string): Promise<void> => {
    await checkout(ctx, { rev: 'main' });
    await branchCreate(ctx, { name });
    await checkout(ctx, { rev: name });
  };

  /** Branches d1 and d2 each add a file on top of `main`, which stays put. */
  const seedSubsumed = async (): Promise<Context> => {
    const ctx = await seedOctopus();
    for (const branch of ['d1', 'd2']) {
      await branchFromMain(ctx, branch);
      await commitFile(ctx, branch, branch);
    }
    await checkout(ctx, { rev: 'main' });
    return ctx;
  };

  /** e1 and e2 edit the two ends of `f`; main adds `n`. */
  const seedContentMerge = async (): Promise<Context> => {
    const ctx = await seedOctopus();
    await commitFile(ctx, 'f', 'f', '1\n2\n3\n4\n5\n');
    await branchFromMain(ctx, 'e1');
    await commitFile(ctx, 'f', 'e1', '1x\n2\n3\n4\n5\n');
    await branchFromMain(ctx, 'e2');
    await commitFile(ctx, 'f', 'e2', '1\n2\n3\n4\n5x\n');
    await checkout(ctx, { rev: 'main' });
    await commitFile(ctx, 'n', 'n');
    return ctx;
  };

  /** git's `a` root, branches b1..b3 each adding a file, and `main` adding `m`. */
  const seedOctopus = async (): Promise<Context> => {
    const ctx = createMemoryContext();
    await init(ctx, { initialBranch: 'main' });
    await commitFile(ctx, 'a', 'a');
    for (const branch of ['b1', 'b2', 'b3']) {
      await checkout(ctx, { rev: 'main' });
      await branchCreate(ctx, { name: branch });
      await checkout(ctx, { rev: branch });
      await commitFile(ctx, branch, branch);
    }
    await checkout(ctx, { rev: 'main' });
    await commitFile(ctx, 'm', 'm');
    return ctx;
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Given main diverged from three branches each adding a file', () => {
    describe('When merge is given the three branches', () => {
      it("Then it records git's four-parent octopus commit", async () => {
        // Arrange
        const ctx = await seedOctopus();
        const sut = mergeRun;

        // Act
        const result = await sut(ctx, { rev: ['b1', 'b2', 'b3'], author: t, committer: t });

        // Assert
        expect(result).toEqual({
          kind: 'merge',
          id: '3a190b784608ad6ceffc1b205eaa24f613617157',
          branch: 'refs/heads/main',
          parents: [
            'a0565ce1b30ed961ef194231a4cc8b508d620fbb',
            '099642b15be68830b2a3d06dbb08b13534567c1c',
            '8719829563f48c78fd4165d900aa0a54fb6bdeff',
            '98e88f839ec08b2e04df0771afde7428eb955d07',
          ],
        });
      });

      it("Then HEAD and main log git's octopus reflog note", async () => {
        // Arrange
        const ctx = await seedOctopus();
        const sut = mergeRun;

        // Act
        await sut(ctx, { rev: ['b1', 'b2', 'b3'], author: t, committer: t });

        // Assert
        const expected = "merge b1 b2 b3: Merge made by the 'octopus' strategy.";
        expect((await readReflog(ctx, 'HEAD' as RefName)).at(-1)?.message).toBe(expected);
        expect((await readReflog(ctx, 'refs/heads/main' as RefName)).at(-1)?.message).toBe(
          expected,
        );
      });
    });
  });

  describe('Given a detached HEAD at main', () => {
    describe('When merge is given two branches', () => {
      it('Then HEAD stays detached at the octopus titled into HEAD', async () => {
        // Arrange
        const ctx = await seedOctopus();
        await checkout(ctx, { rev: 'main', detach: true });
        const sut = mergeRun;

        // Act
        const result = await sut(ctx, { rev: ['b1', 'b2'], author: t, committer: t });

        // Assert
        const id = (result as { id: ObjectId }).id;
        expect(result).toMatchObject({ kind: 'merge', branch: undefined });
        expect(await getRefStore(ctx).resolveDirect('HEAD' as RefName)).toEqual({
          kind: 'direct',
          id,
        });
        const made = await readObject(ctx, id);
        expect(made.type === 'commit' && made.data.message).toBe(
          "Merge branches 'b1' and 'b2' into HEAD\n",
        );
        expect((await readReflog(ctx, 'HEAD' as RefName)).at(-1)?.message).toBe(
          "merge b1 b2: Merge made by the 'octopus' strategy.",
        );
      });
    });

    describe('When merge is given two branches with fastForward only', () => {
      it('Then it refuses NON_FAST_FORWARD on HEAD', async () => {
        // Arrange
        const ctx = await seedOctopus();
        await checkout(ctx, { rev: 'main', detach: true });
        const sut = mergeRun;

        // Act
        const caught = await sut(ctx, { rev: ['b1', 'b2'], fastForward: 'only' }).catch(
          (error: unknown) => error,
        );

        // Assert
        expect((caught as TsgitError).data).toEqual({
          code: 'NON_FAST_FORWARD',
          ref: 'HEAD',
          local: 'a0565ce1b30ed961ef194231a4cc8b508d620fbb',
          remote: '099642b15be68830b2a3d06dbb08b13534567c1c',
        });
      });
    });
  });

  describe('Given heads git reduces before merging', () => {
    describe('When merge runs', () => {
      it.each([
        {
          label: 'a repeated head is merged once',
          seed: seedOctopus,
          rev: ['b1', 'b1', 'b2'],
          fastForward: undefined,
          id: 'a9bbb2c7c121999bda8fc80625b414dfd9d57cd5',
          parents: [
            'a0565ce1b30ed961ef194231a4cc8b508d620fbb',
            '099642b15be68830b2a3d06dbb08b13534567c1c',
            '8719829563f48c78fd4165d900aa0a54fb6bdeff',
          ],
          reflog: "merge b1 b2: Merge made by the 'octopus' strategy.",
        },
        {
          label: 'HEAD among the heads leaves a two-head ort merge',
          seed: seedOctopus,
          rev: ['b1', 'main'],
          fastForward: undefined,
          id: '77f25f73336092205293a7c932c699c11a2659d0',
          parents: [
            'a0565ce1b30ed961ef194231a4cc8b508d620fbb',
            '099642b15be68830b2a3d06dbb08b13534567c1c',
          ],
          reflog: "merge b1: Merge made by the 'ort' strategy.",
        },
        {
          label: 'a HEAD both heads reach is not recorded as a parent',
          seed: seedSubsumed,
          rev: ['d1', 'd2'],
          fastForward: undefined,
          id: 'b94f914ae6cd5880358f3f2738cdcefa9463f2d9',
          parents: [
            'a1e87a94c5228a21ea2146d19917e7fea800678a',
            'be3c439e351b2e50144366ebf444b7785ffe04e9',
          ],
          reflog: "merge d1 d2: Merge made by the 'octopus' strategy.",
        },
        {
          label: 'a HEAD both heads reach is kept as a parent under fastForward never',
          seed: seedSubsumed,
          rev: ['d1', 'd2'],
          fastForward: 'never',
          id: '14f1f5a41fef6107b95c6b9700017c669865bbe3',
          parents: [
            'a0565ce1b30ed961ef194231a4cc8b508d620fbb',
            'a1e87a94c5228a21ea2146d19917e7fea800678a',
            'be3c439e351b2e50144366ebf444b7785ffe04e9',
          ],
          reflog: "merge d1 d2: Merge made by the 'octopus' strategy.",
        },
        {
          label: 'edits to both ends of one file merge cleanly',
          seed: seedContentMerge,
          rev: ['e1', 'e2'],
          fastForward: undefined,
          id: '6779c7fffcf1cf60685188bdd0082e7589318159',
          parents: [
            '09910812416cb55bf314e4bbfdf7987e4576e446',
            '8e8dd0bb0b3b482044815c42aeda0e52d91b09a7',
            'a0191d1120e251331bc42ec660adcf79da0cd74a',
          ],
          reflog: "merge e1 e2: Merge made by the 'octopus' strategy.",
        },
      ] as const)(
        'Then $label, as git records it',
        async ({ seed, rev, fastForward, id, parents, reflog }) => {
          // Arrange
          const ctx = await seed();
          const sut = mergeRun;

          // Act
          const result = await sut(ctx, {
            rev,
            author: t,
            committer: t,
            ...(fastForward === undefined ? {} : { fastForward }),
          });

          // Assert
          expect(result).toEqual({ kind: 'merge', id, branch: 'refs/heads/main', parents });
          expect((await readReflog(ctx, 'HEAD' as RefName)).at(-1)?.message).toBe(reflog);
        },
      );
    });
  });

  /** c1 rewrites `m` one way; main then rewrites it another. */
  const seedConflicting = async (): Promise<Context> => {
    const ctx = await seedOctopus();
    await branchFromMain(ctx, 'c1');
    await commitFile(ctx, 'm', 'c1');
    await checkout(ctx, { rev: 'main' });
    await commitFile(ctx, 'm', 'm2');
    return ctx;
  };

  const MAIN_M2 = '22cb5f2099b7f48e95e0eb659e0686300bef355b';

  describe.each([
    ['c1', ['c1']],
    ['b1 and c1', ['b1', 'c1']],
  ])('Given merging %s conflicts', (_label, rev) => {
    describe.each([
      ['by default', {}, ''],
      ['never fast-forwarding', { fastForward: 'never' as const }, 'no-ff'],
    ])('When merge runs %s', (_mode, extra, expected) => {
      it("Then MERGE_MODE records git's fast-forward mode", async () => {
        // Arrange
        const ctx = await seedConflicting();
        const sut = mergeRun;

        // Act
        await sut(ctx, { rev, author: t, committer: t, ...extra });

        // Assert
        const result = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/MERGE_MODE`);
        expect(result).toBe(expected);
      });
    });
  });

  describe('Given the last head conflicts with main', () => {
    describe('When merge is given b1, b2 and c1', () => {
      it('Then it stops with the conflict, MERGE_HEAD listing every head', async () => {
        // Arrange
        const ctx = await seedConflicting();
        const sut = mergeRun;

        // Act
        const result = await sut(ctx, { rev: ['b1', 'b2', 'c1'], author: t, committer: t });

        // Assert
        expect(result).toEqual({
          kind: 'conflict',
          conflicts: [{ path: 'm', type: 'content' }],
          mergeHead: '099642b15be68830b2a3d06dbb08b13534567c1c',
          origHead: MAIN_M2,
        });
        expect(await ctx.fs.readUtf8(`${ctx.layout.gitDir}/MERGE_HEAD`)).toBe(
          '099642b15be68830b2a3d06dbb08b13534567c1c\n' +
            '8719829563f48c78fd4165d900aa0a54fb6bdeff\n' +
            '5aca2a7136ad8e26f39781e1260fcafa44cc35cb\n',
        );
        expect(await ctx.fs.readUtf8(`${ctx.layout.gitDir}/MERGE_MSG`)).toBe(
          "Merge branches 'b1', 'b2' and 'c1'\n\n# Conflicts:\n#\tm\n",
        );
        expect(await resolveRef(ctx, 'HEAD' as RefName)).toBe(MAIN_M2);
      });

      it("Then the index holds git's merged entries and m's three stages", async () => {
        // Arrange
        const ctx = await seedConflicting();
        const sut = mergeRun;

        // Act
        await sut(ctx, { rev: ['b1', 'b2', 'c1'], author: t, committer: t });

        // Assert
        const result = (await readIndex(ctx)).entries.map(
          (e) => `${e.id} ${e.flags.stage}\t${e.path}`,
        );
        expect(result).toEqual([
          '78981922613b2afb6025042ff6bd878ac1994e85 0\ta',
          'c9c6af7f78bc47490dbf3e822cf2f3c24d4b9061 0\tb1',
          'e6bfff5c1d0f0ecd501552b43a1e13d8008abc31 0\tb2',
          '28ce6a8b26aa170e1de65536fe8abe1832bd3242 1\tm',
          '08bb2331e777f431177c40df6841c0034f89fb58 2\tm',
          'ae9304576a6ec3419b231b2b9c8e33a06f97f9fb 3\tm',
        ]);
      });

      it('Then the working tree holds the merged files and m with conflict markers', async () => {
        // Arrange
        const ctx = await seedConflicting();
        const sut = mergeRun;

        // Act
        await sut(ctx, { rev: ['b1', 'b2', 'c1'], author: t, committer: t });

        // Assert
        const read = (name: string) => ctx.fs.readUtf8(`${ctx.layout.workDir}/${name}`);
        expect(await read('b1')).toBe('b1\n');
        expect(await read('b2')).toBe('b2\n');
        expect(await read('m')).toBe('<<<<<<< HEAD\nm2\n=======\nc1\n>>>>>>> c1\n');
      });
    });
  });

  describe('Given the first head conflicts with main', () => {
    describe('When merge is given c1, b1 and b2', () => {
      it('Then the octopus fails at c1 and nothing changes', async () => {
        // Arrange
        const ctx = await seedConflicting();
        const sut = mergeRun;

        // Act
        const caught = await sut(ctx, { rev: ['c1', 'b1', 'b2'], author: t, committer: t }).catch(
          (error: unknown) => error,
        );

        // Assert
        expect((caught as TsgitError).data).toEqual({
          code: 'OCTOPUS_MERGE_FAILED',
          head: 'c1',
          reason: 'conflict-before-last-head',
        });
        expect(await resolveRef(ctx, 'HEAD' as RefName)).toBe(MAIN_M2);
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/MERGE_HEAD`)).toBe(false);
        expect(await ctx.fs.exists(`${ctx.layout.workDir}/b1`)).toBe(false);
      });
    });
  });

  describe('Given a change staged on main', () => {
    describe('When merge is given two heads', () => {
      it("Then octopus refuses the index that differs from HEAD, as git's diff-index does", async () => {
        // Arrange
        const ctx = await seedOctopus();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/s`, 's\n');
        await add(ctx, ['s']);
        const sut = mergeRun;

        // Act
        const caught = await sut(ctx, { rev: ['b1', 'b2'], author: t, committer: t }).catch(
          (error: unknown) => error,
        );

        // Assert
        expect((caught as TsgitError).data).toEqual({
          code: 'WORKING_TREE_DIRTY',
          localChanges: ['s'],
          untracked: [],
        });
      });
    });
  });

  describe('Given heads main cannot fast-forward to', () => {
    describe('When merge is given two heads with fastForward only', () => {
      it('Then it refuses as a non-fast-forward', async () => {
        // Arrange
        const ctx = await seedOctopus();
        const sut = mergeRun;

        // Act
        const caught = await sut(ctx, { rev: ['b1', 'b2'], fastForward: 'only' }).catch(
          (error: unknown) => error,
        );

        // Assert
        expect((caught as TsgitError).data).toEqual({
          code: 'NON_FAST_FORWARD',
          ref: 'refs/heads/main',
          local: 'a0565ce1b30ed961ef194231a4cc8b508d620fbb',
          remote: '099642b15be68830b2a3d06dbb08b13534567c1c',
        });
      });
    });
  });

  describe('Given heads that all name main itself', () => {
    describe('When merge is given them', () => {
      it('Then it is up to date', async () => {
        // Arrange
        const ctx = await seedOctopus();
        const sut = mergeRun;

        // Act
        const result = await sut(ctx, { rev: ['main', 'main'] });

        // Assert
        expect(result).toEqual({
          kind: 'up-to-date',
          id: 'a0565ce1b30ed961ef194231a4cc8b508d620fbb',
        });
      });
    });
  });

  const removeAndCommit = async (ctx: Context, name: string, message: string): Promise<void> => {
    await rm(ctx, [name]);
    await commit(ctx, { message, author: t, committer: t });
  };

  describe('Given g1 deletes a file main kept', () => {
    describe('When merge is given g1 and b1', () => {
      it('Then it fast-forwards to g1, merges b1, and records the deletion as git does', async () => {
        // Arrange
        const ctx = await seedOctopus();
        await branchFromMain(ctx, 'g1');
        await removeAndCommit(ctx, 'a', 'g1');
        await checkout(ctx, { rev: 'main' });
        const info = vi.fn();
        const sut = mergeRun;

        // Act
        const result = await sut(
          { ...ctx, logger: { ...ctx.logger, info } },
          { rev: ['g1', 'b1'], author: t, committer: t },
        );

        // Assert
        expect(result).toEqual({
          kind: 'merge',
          id: 'e9353cac3a95b8edfb25bd309c018a27f066e932',
          branch: 'refs/heads/main',
          parents: [
            '5d8416e204352240d506f677caed3debbb30fe8f',
            '099642b15be68830b2a3d06dbb08b13534567c1c',
          ],
        });
        expect(info.mock.calls.map(([line]) => line)).toEqual([
          'Fast-forwarding to: g1',
          'Trying simple merge with b1',
        ]);
      });
    });
  });

  describe('Given the last head deletes a file main modified', () => {
    describe('When merge is given b1 and h1', () => {
      it('Then m stays unmerged at stages 1 and 2 with our bytes in the working tree', async () => {
        // Arrange
        const ctx = await seedOctopus();
        await branchFromMain(ctx, 'h1');
        await removeAndCommit(ctx, 'm', 'h1');
        await checkout(ctx, { rev: 'main' });
        await commitFile(ctx, 'm', 'm3');
        const sut = mergeRun;

        // Act
        const result = await sut(ctx, { rev: ['b1', 'h1'], author: t, committer: t });

        // Assert
        expect(result.kind === 'conflict' ? result.conflicts : []).toEqual([
          { path: 'm', type: 'modify-delete' },
        ]);
        const index = (await readIndex(ctx)).entries.map(
          (e) => `${e.id} ${e.flags.stage}\t${e.path}`,
        );
        expect(index.slice(2)).toEqual([
          '28ce6a8b26aa170e1de65536fe8abe1832bd3242 1\tm',
          'e5c9ce9248c688a566f3d03be31d0097edb96443 2\tm',
        ]);
        expect(await ctx.fs.readUtf8(`${ctx.layout.workDir}/m`)).toBe('m3\n');
      });
    });
  });

  describe('Given the last head modifies a file main deleted', () => {
    describe('When merge is given b1 and k1', () => {
      it('Then m stays unmerged at stages 1 and 3 and absent from the working tree', async () => {
        // Arrange
        const ctx = await seedOctopus();
        await branchFromMain(ctx, 'k1');
        await commitFile(ctx, 'm', 'k1', 'k\n');
        await checkout(ctx, { rev: 'main' });
        await removeAndCommit(ctx, 'm', 'rm');
        const sut = mergeRun;

        // Act
        await sut(ctx, { rev: ['b1', 'k1'], author: t, committer: t });

        // Assert
        const index = (await readIndex(ctx)).entries.map(
          (e) => `${e.id} ${e.flags.stage}\t${e.path}`,
        );
        expect(index.slice(2)).toEqual([
          '28ce6a8b26aa170e1de65536fe8abe1832bd3242 1\tm',
          'b68fde2a051d9af2fe3ff4c96c0898e5a3212e4d 3\tm',
        ]);
        expect(await ctx.fs.exists(`${ctx.layout.workDir}/m`)).toBe(false);
      });
    });
  });

  describe('Given an earlier head deletes a file and the last head conflicts', () => {
    describe('When merge is given g1, b2 and c1', () => {
      it('Then the deletion reaches the working tree and the index', async () => {
        // Arrange
        const ctx = await seedConflicting();
        await branchFromMain(ctx, 'g1');
        await removeAndCommit(ctx, 'a', 'g1');
        await checkout(ctx, { rev: 'main' });
        const sut = mergeRun;

        // Act
        const result = await sut(ctx, { rev: ['g1', 'b2', 'c1'], author: t, committer: t });

        // Assert
        expect(result.kind).toBe('conflict');
        expect(await ctx.fs.exists(`${ctx.layout.workDir}/a`)).toBe(false);
        const paths = (await readIndex(ctx)).entries.map((entry) => entry.path);
        expect(paths).toEqual(['b2', 'm', 'm', 'm']);
      });
    });
  });

  describe('Given an octopus left a conflict on its last head', () => {
    describe('When the conflict is resolved and committed', () => {
      it("Then the commit records HEAD and every MERGE_HEAD line as git's commit does", async () => {
        // Arrange
        const ctx = await seedConflicting();
        await mergeRun(ctx, { rev: ['b1', 'b2', 'c1'], author: t, committer: t });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/m`, 'r\n');
        await add(ctx, ['m']);
        const sut = commit;

        // Act
        const result = await sut(ctx, { message: 'Merge branches', author: t, committer: t });

        // Assert
        expect(result.id).toBe('f1e6d6a0c610f4cc8fe6829cbd74d266eb6214dd');
      });
    });
  });
});

describe('merge — unrelated histories', () => {
  const t: AuthorIdentity = {
    name: 't',
    email: 't@t',
    timestamp: 1_700_000_000,
    timezoneOffset: '+0000',
  };

  const commitFile = async (ctx: Context, name: string): Promise<void> => {
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/${name}`, `${name}\n`);
    await add(ctx, [name]);
    await commit(ctx, { message: name, author: t, committer: t });
  };

  /** `main` holds `a`; `rel` adds `r` on top of it; `orphan` shares no history with either. */
  const seedUnrelated = async (): Promise<Context> => {
    const ctx = createMemoryContext();
    await init(ctx, { initialBranch: 'main' });
    await commitFile(ctx, 'a');
    await branchCreate(ctx, { name: 'rel' });
    await checkout(ctx, { rev: 'rel' });
    await commitFile(ctx, 'r');
    await checkout(ctx, { rev: 'main' });
    const blob = await writeBlob(ctx, 'o\n');
    const tree = await writeTreeMod.writeTree(ctx, [
      treeEntry(FILE_MODE.REGULAR, 'o' as never, blob),
    ]);
    const orphan = await writeObject(ctx, {
      type: 'commit',
      id: '' as ObjectId,
      data: { tree, parents: [], author: t, committer: t, message: 'o\n', extraHeaders: [] },
    });
    await seedRef(ctx, 'refs/heads/orphan' as RefName, orphan, { reflogMessage: 'seed' });
    return ctx;
  };

  const refusalOf = async (ctx: Context, input: MergeRunInput): Promise<unknown> => {
    const caught = await mergeRun(ctx, input).catch((error: unknown) => error);
    return (caught as TsgitError).data;
  };

  describe.each([
    ['the orphan alone', ['orphan']],
    ['rel and the orphan', ['rel', 'orphan']],
  ])('Given %s', (_label, rev) => {
    describe.each([
      ['by default', {}],
      ['fast-forward only', { fastForward: 'only' as const }],
    ])('When merge runs %s', (_mode, extra) => {
      it('Then it refuses with UNRELATED_HISTORIES after recording ORIG_HEAD', async () => {
        // Arrange
        const ctx = await seedUnrelated();
        const head = await resolveRef(ctx, 'HEAD' as RefName);
        const sut = refusalOf;

        // Act
        const result = await sut(ctx, { rev, author: t, committer: t, ...extra });

        // Assert
        expect(result).toEqual({ code: 'UNRELATED_HISTORIES' });
        expect(await resolveRef(ctx, 'ORIG_HEAD' as RefName)).toBe(head);
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/MERGE_HEAD`)).toBe(false);
      });
    });
  });

  describe('Given the orphan and allowUnrelatedHistories', () => {
    describe('When merge runs', () => {
      it('Then it records a two-parent merge of both roots', async () => {
        // Arrange
        const ctx = await seedUnrelated();
        const head = await resolveRef(ctx, 'HEAD' as RefName);
        const orphan = await resolveRef(ctx, 'refs/heads/orphan' as RefName);
        const sut = mergeRun;

        // Act
        const result = await sut(ctx, {
          rev: 'orphan',
          allowUnrelatedHistories: true,
          author: t,
          committer: t,
        });

        // Assert
        expect(result).toMatchObject({ kind: 'merge', parents: [head, orphan] });
      });
    });
  });

  describe('Given rel and the orphan and allowUnrelatedHistories', () => {
    describe('When merge runs', () => {
      it("Then the octopus stops at the orphan and leaves git's conflicted merge state", async () => {
        // Arrange
        const ctx = await seedUnrelated();
        const logged: string[] = [];
        const logging = { ...ctx, logger: { error: (line: string) => logged.push(line) } };
        const head = await resolveRef(ctx, 'HEAD' as RefName);
        const rel = await resolveRef(ctx, 'refs/heads/rel' as RefName);
        const orphan = await resolveRef(ctx, 'refs/heads/orphan' as RefName);
        const sut = mergeRun;

        // Act
        const result = await sut(logging, {
          rev: ['rel', 'orphan'],
          allowUnrelatedHistories: true,
          author: t,
          committer: t,
        });

        // Assert
        expect(result).toEqual({ kind: 'conflict', conflicts: [], mergeHead: rel, origHead: head });
        expect(logged).toEqual(['Unable to find common commit with orphan']);
        const gitDir = ctx.layout.gitDir;
        expect(await ctx.fs.readUtf8(`${gitDir}/MERGE_HEAD`)).toBe(`${rel}\n${orphan}\n`);
        expect(await ctx.fs.readUtf8(`${gitDir}/MERGE_MSG`)).toBe(
          "Merge branches 'rel' and 'orphan'\n\n# Conflicts:\n",
        );
        const paths = (await readIndex(ctx)).entries.map((entry) => entry.path);
        expect(paths).toEqual(['a', 'r']);
        expect(await ctx.fs.readUtf8(`${ctx.layout.workDir}/r`)).toBe('r\n');
      });
    });
  });

  describe.each([
    ['never fast-forwarding', { fastForward: 'never' as const }, ['head', 'rel', 'orphan']],
    ['by default', {}, ['rel', 'orphan']],
  ])('Given rel and the orphan merged %s and stopped', (_mode, extra, expected) => {
    describe('When the merge is committed', () => {
      it('Then HEAD stays a parent only under no-ff, and MERGE_MODE goes', async () => {
        // Arrange
        const ctx = await seedUnrelated();
        const tips: Record<string, ObjectId> = {
          head: await resolveRef(ctx, 'HEAD' as RefName),
          rel: await resolveRef(ctx, 'refs/heads/rel' as RefName),
          orphan: await resolveRef(ctx, 'refs/heads/orphan' as RefName),
        };
        const input = { rev: ['rel', 'orphan'], allowUnrelatedHistories: true, ...extra };
        await mergeRun(ctx, { ...input, author: t, committer: t });
        const sut = commit;

        // Act
        const result = await sut(ctx, { message: 'done', author: t, committer: t });

        // Assert
        const committed = await readObject(ctx, result.id);
        const parents = committed.type === 'commit' ? committed.data.parents : [];
        expect(parents).toEqual(expected.map((name) => tips[name]));
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/MERGE_MODE`)).toBe(false);
      });
    });
  });
});

describe('merge — throwaway tags', () => {
  const TAGGER_CONFIG = '[user]\n  name = Grace\n  email = grace@example.com\n';

  /** main at base; `feature` one commit ahead, tagged by an annotated `v1`. */
  const seedTaggedAhead = async (): Promise<{
    ctx: Context;
    base: ObjectId;
    ahead: ObjectId;
    tag: ObjectId;
  }> => {
    const ctx = createMemoryContext();
    await init(ctx, { initialBranch: 'main' });
    const configPath = `${ctx.layout.gitDir}/config`;
    await ctx.fs.writeUtf8(configPath, `${await ctx.fs.readUtf8(configPath)}${TAGGER_CONFIG}`);
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
    await add(ctx, ['a.txt']);
    const base = await commit(ctx, { message: 'base', author });
    await branchCreate(ctx, { name: 'feature' });
    await checkout(ctx, { rev: 'feature' });
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/b.txt`, 'b');
    await add(ctx, ['b.txt']);
    const ahead = await commit(ctx, { message: 'ahead', author });
    const tag = await tagCreate(ctx, { name: 'v1', target: 'feature', message: 'v1' });
    await checkout(ctx, { rev: 'main' });
    return { ctx, base: base.id, ahead: ahead.id, tag: tag.id };
  };

  /** The tag object also reachable as `refs/tags/other`, with `refs/tags/v1` gone. */
  const renameTag = async (ctx: Context, tag: ObjectId): Promise<void> => {
    await seedRef(ctx, 'refs/tags/other' as RefName, tag, { reflogMessage: 'seed' });
    await tagDelete(ctx, { name: 'v1' });
  };

  describe('Given an annotated tag its own name no longer points at', () => {
    describe('When merge could fast-forward to it', () => {
      it('Then it records a merge commit naming the tag instead', async () => {
        // Arrange
        const { ctx, base, ahead, tag } = await seedTaggedAhead();
        await renameTag(ctx, tag);
        const sut = mergeRun;

        // Act
        const result = await sut(ctx, { rev: 'other', author, committer: author });

        // Assert
        expect(result).toMatchObject({ kind: 'merge', parents: [base, ahead] });
        const made = await readObject(ctx, (result as { id: ObjectId }).id);
        expect(made.type === 'commit' && made.data.message).toBe("Merge tag 'other'\n\nv1\n");
      });
    });

    describe('When merge is told fast-forward only', () => {
      it('Then it still fast-forwards', async () => {
        // Arrange
        const { ctx, ahead, tag } = await seedTaggedAhead();
        await renameTag(ctx, tag);
        const sut = mergeRun;

        // Act
        const result = await sut(ctx, { rev: 'other', fastForward: 'only' });

        // Assert
        expect(result).toEqual({ kind: 'fast-forward', id: ahead, branch: 'refs/heads/main' });
      });
    });

    describe('When merge is given it with another branch', () => {
      it('Then the octopus keeps HEAD as its first parent', async () => {
        // Arrange
        const { ctx, base, ahead, tag } = await seedTaggedAhead();
        await renameTag(ctx, tag);
        await branchCreate(ctx, { name: 'other-side', startPoint: 'main' });
        await checkout(ctx, { rev: 'other-side' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/c.txt`, 'c');
        await add(ctx, ['c.txt']);
        const side = await commit(ctx, { message: 'side', author });
        await checkout(ctx, { rev: 'main' });
        const sut = mergeRun;

        // Act
        const result = await sut(ctx, { rev: ['other', 'other-side'], author, committer: author });

        // Assert
        expect(result).toMatchObject({ kind: 'merge', parents: [base, ahead, side.id] });
      });
    });
  });

  describe('Given an annotated tag whose own name is a lightweight tag of the same commit', () => {
    describe('When merge could fast-forward to it', () => {
      it('Then it records a merge commit', async () => {
        // Arrange
        const { ctx, base, ahead } = await seedTaggedAhead();
        const tagObject = await resolveRef(ctx, 'refs/tags/v1' as RefName);
        await seedRef(ctx, 'refs/tags/other' as RefName, tagObject, { reflogMessage: 'seed' });
        await tagCreate(ctx, { name: 'v1', target: 'feature', force: true });
        const sut = mergeRun;

        // Act
        const result = await sut(ctx, { rev: 'other', author, committer: author });

        // Assert
        expect(result).toMatchObject({ kind: 'merge', parents: [base, ahead] });
      });
    });
  });

  describe('Given an annotated tag its own name still points at', () => {
    describe('When merge is given it under another name', () => {
      it('Then it fast-forwards', async () => {
        // Arrange
        const { ctx, ahead, tag } = await seedTaggedAhead();
        await seedRef(ctx, 'refs/tags/other' as RefName, tag, { reflogMessage: 'seed' });
        const sut = mergeRun;

        // Act
        const result = await sut(ctx, { rev: 'other', author, committer: author });

        // Assert
        expect(result).toEqual({ kind: 'fast-forward', id: ahead, branch: 'refs/heads/main' });
      });
    });
  });

  describe('Given an annotated tag whose name climbs out of refs/tags back to itself', () => {
    describe('When merge could fast-forward to it', () => {
      it('Then it records a merge commit, as no refname can carry that name', async () => {
        // Arrange
        const { ctx, base, ahead } = await seedTaggedAhead();
        const tag = await writeObject(ctx, {
          type: 'tag',
          id: '' as ObjectId,
          data: {
            object: ahead,
            objectType: 'commit',
            tagName: '../tags/other',
            tagger: author,
            message: 'climbs\n',
            extraHeaders: [],
          },
        });
        await seedRef(ctx, 'refs/tags/other' as RefName, tag, { reflogMessage: 'seed' });
        const sut = mergeRun;

        // Act
        const result = await sut(ctx, { rev: 'other', author, committer: author });

        // Assert
        expect(result).toMatchObject({ kind: 'merge', parents: [base, ahead] });
      });
    });
  });

  describe('Given a throwaway tag that conflicts with HEAD', () => {
    describe('When merge stops on the conflict', () => {
      it('Then MERGE_MODE records no-ff', async () => {
        // Arrange
        const { ctx, tag } = await seedTaggedAhead();
        await renameTag(ctx, tag);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/b.txt`, 'main b');
        await add(ctx, ['b.txt']);
        await commit(ctx, { message: 'main b', author });
        const sut = mergeRun;

        // Act
        const result = await sut(ctx, { rev: 'other', author, committer: author });

        // Assert
        expect(result.kind).toBe('conflict');
        expect(await ctx.fs.readUtf8(`${ctx.layout.gitDir}/MERGE_MODE`)).toBe('no-ff');
      });
    });
  });
});

describe('merge — rename/rename to two paths', () => {
  const LINES = '1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n';
  const renameAndEdit = async (ctx: Context, to: string, seven: string): Promise<void> => {
    await rm(ctx, ['f']);
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/${to}`, LINES.replace('7\n', `${seven}\n`));
    await add(ctx, [to]);
    await commit(ctx, { message: to, author });
  };

  describe('Given both sides rename one file apart and edit the same line', () => {
    describe('When merge runs', () => {
      it('Then the marked merge is staged at both destinations and written to both', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/f`, LINES);
        await add(ctx, ['f']);
        await commit(ctx, { message: 'base', author });
        await branchCreate(ctx, { name: 'side' });
        await checkout(ctx, { rev: 'side' });
        await renameAndEdit(ctx, 'b', 'SEVEN');
        await checkout(ctx, { rev: 'main' });
        await renameAndEdit(ctx, 'a', 'seven');
        const sut = mergeRun;

        // Act
        const result = await sut(ctx, { rev: 'side', author });

        // Assert
        expect(result.kind).toBe('conflict');
        const marked = await ctx.fs.readUtf8(`${ctx.layout.workDir}/a`);
        expect(marked).toContain('<<<<<<<< HEAD:a\nseven\n========\nSEVEN\n>>>>>>>> side:b\n');
        expect(await ctx.fs.readUtf8(`${ctx.layout.workDir}/b`)).toBe(marked);
        const index = await readIndex(ctx);
        const staged = index.entries.filter((e) => e.path === 'a' || e.path === 'b');
        expect(staged.map((e) => [e.path, e.flags.stage])).toEqual([
          ['a', 2],
          ['b', 3],
        ]);
        expect(staged[0]?.id).toBe(staged[1]?.id);
        expect(new TextDecoder().decode((await readBlob(ctx, staged[0]!.id)).content)).toBe(marked);
      });
    });
  });
});
