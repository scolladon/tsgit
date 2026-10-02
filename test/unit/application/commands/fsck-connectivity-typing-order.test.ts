/**
 * A commit only reflogs and a child reach, whose loose copy holds another
 * object's bytes: under `connectivityOnly` git types an object by the first
 * parse that links to it, in its walk order, and walks a typed object through
 * whatever bytes its copy serves — never re-hashing them.
 */
import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { type FsckFinding, fsck } from '../../../../src/application/commands/fsck.js';
import { looseObjectPath } from '../../../../src/application/primitives/path-layout.js';
import { writeCommitGraph } from '../../../../src/application/primitives/write-commit-graph.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { STAGE0_FLAGS } from '../../../../src/domain/git-index/index-entry.js';
import { hexToBytes } from '../../../../src/domain/objects/encoding.js';
import { FILE_MODE } from '../../../../src/domain/objects/file-mode.js';
import type { ObjectId } from '../../../../src/domain/objects/index.js';
import type { FilePath } from '../../../../src/domain/objects/object-id.js';
import { treeEntry } from '../../../../src/domain/objects/tree.js';
import { type Context, createSession } from '../../../../src/ports/context.js';
import { serializeIndexFixtureAsync } from '../primitives/fixtures.js';

const AUTHOR = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};
const ZERO = '0'.repeat(40) as ObjectId;
const enc = new TextEncoder();

interface History {
  readonly ctx: Context;
  readonly c1: ObjectId;
  readonly c2: ObjectId;
  readonly c3: ObjectId;
}

const fileTree = async (ctx: Context, name: string, text: string): Promise<ObjectId> => {
  const blob = await writeObject(ctx, {
    type: 'blob',
    id: '' as ObjectId,
    content: enc.encode(text),
  });
  return writeObject(ctx, {
    type: 'tree',
    id: '' as ObjectId,
    entries: [treeEntry(FILE_MODE.REGULAR, name, blob)],
  });
};

const commitOver = async (
  ctx: Context,
  tree: ObjectId,
  parents: ReadonlyArray<ObjectId>,
  message: string,
): Promise<ObjectId> =>
  writeObject(ctx, {
    type: 'commit',
    id: '' as ObjectId,
    data: { tree, parents, author: AUTHOR, committer: AUTHOR, message, extraHeaders: [] },
  });

const reflogLine = (from: ObjectId, to: ObjectId): string =>
  `${from} ${to} Ada <ada@example.com> 1700000000 +0000\tcommit\n`;

/** `count` commits, each over its own one-file tree and the previous one. */
const commitChain = async (ctx: Context, count: number): Promise<ReadonlyArray<ObjectId>> => {
  const chain: ObjectId[] = [];
  for (let n = 1; n <= count; n++) {
    const tree = await fileTree(ctx, 'f', `v${n}\n`);
    chain.push(await commitOver(ctx, tree, chain.slice(-1), `c${n}`));
  }
  return chain;
};

/** main at `tip`, HEAD and main each logging `moves` in order. */
const pointMain = async (
  ctx: Context,
  tip: ObjectId,
  moves: ReadonlyArray<readonly [ObjectId, ObjectId]>,
): Promise<void> => {
  const gitDir = ctx.layout.gitDir;
  const log = moves.map(([from, to]) => reflogLine(from, to)).join('');
  await ctx.fs.writeUtf8(`${gitDir}/HEAD`, 'ref: refs/heads/main\n');
  await ctx.fs.writeUtf8(`${gitDir}/refs/heads/main`, `${tip}\n`);
  await ctx.fs.writeUtf8(`${gitDir}/logs/HEAD`, log);
  await ctx.fs.writeUtf8(`${gitDir}/logs/refs/heads/main`, log);
};

/** c1 ← c2 ← c3 committed in turn; `resetTo` moves main back with a reset entry. */
const history = async (resetTo?: 'c1'): Promise<History> => {
  const ctx = createMemoryContext();
  const [c1, c2, c3] = (await commitChain(ctx, 3)) as [ObjectId, ObjectId, ObjectId];
  const moves: Array<readonly [ObjectId, ObjectId]> = [
    [ZERO, c1],
    [c1, c2],
    [c2, c3],
  ];
  if (resetTo === 'c1') moves.push([c3, c1]);
  await pointMain(ctx, resetTo === 'c1' ? c1 : c3, moves);
  return { ctx, c1, c2, c3 };
};

/** Overwrite `target`'s loose copy with `source`'s loose bytes. */
const serveBytesOf = async (ctx: Context, target: ObjectId, source: ObjectId): Promise<void> => {
  const gitDir = ctx.layout.gitDir;
  const bytes = await ctx.fs.read(looseObjectPath(gitDir, source));
  await ctx.fs.rm(looseObjectPath(gitDir, target));
  await ctx.fs.write(looseObjectPath(gitDir, target), bytes);
};

const findingsAbout = (findings: ReadonlyArray<FsckFinding>, id: ObjectId) =>
  findings.filter((finding) => 'id' in finding && finding.id === id);

/** What git's walk says about an object it could not walk as typed. */
const typeFindingsAbout = (findings: ReadonlyArray<FsckFinding>, id: ObjectId) =>
  findingsAbout(findings, id).filter(
    (finding) =>
      finding.type === 'unknown-object-type' || finding.type === 'unexpected-object-type',
  );

const CONNECTIVITY_ONLY = { connectivityOnly: true } as const;

describe('Given main at c3 and c2 a reflog root whose copy holds c1', () => {
  describe('When fsck runs connectivity-only', () => {
    it('Then c2 is typed by the parse of the ref tip naming it, and walked', async () => {
      // Arrange
      const { ctx, c1, c2 } = await history();
      await serveBytesOf(ctx, c2, c1);
      const sut = fsck;

      // Act
      const result = await sut(ctx, CONNECTIVITY_ONLY);

      // Assert
      expect(typeFindingsAbout(result.findings, c2)).toEqual([]);
    });
  });
});

describe('Given main reset to c1 and c2 a reflog root whose copy holds c1', () => {
  describe('When fsck runs connectivity-only', () => {
    it('Then c3, popped first, types c2, and c2 is walked', async () => {
      // Arrange
      const { ctx, c1, c2 } = await history('c1');
      await serveBytesOf(ctx, c2, c1);
      const sut = fsck;

      // Act
      const result = await sut(ctx, CONNECTIVITY_ONLY);

      // Assert
      expect(typeFindingsAbout(result.findings, c2)).toEqual([]);
    });
  });
});

describe('Given main reset to c1 and c2 a reflog root whose copy holds a dangling commit', () => {
  describe('When fsck runs connectivity-only', () => {
    it("Then c2 is walked through the bytes it serves, reaching that commit's tree", async () => {
      // Arrange
      const { ctx, c2 } = await history('c1');
      const servedTree = await fileTree(ctx, 'd', 'dd\n');
      const served = await commitOver(ctx, servedTree, [], 'd');
      await serveBytesOf(ctx, c2, served);
      const sut = fsck;

      // Act
      const result = await sut(ctx, CONNECTIVITY_ONLY);

      // Assert
      expect(findingsAbout(result.findings, servedTree)).toEqual([]);
      expect(findingsAbout(result.findings, served).map((finding) => finding.type)).toEqual([
        'unreachable',
        'dangling',
      ]);
    });
  });
});

describe('Given main reset to c1 and c2 a reflog root whose copy holds a blob', () => {
  describe('When fsck runs connectivity-only', () => {
    it('Then c2, typed a commit by c3, is reported not a commit, and the exit code is 0', async () => {
      // Arrange
      const { ctx, c2 } = await history('c1');
      const blob = await writeObject(ctx, {
        type: 'blob',
        id: '' as ObjectId,
        content: enc.encode('v3\n'),
      });
      await serveBytesOf(ctx, c2, blob);
      const sut = fsck;

      // Act
      const result = await sut(ctx, CONNECTIVITY_ONLY);

      // Assert
      expect(findingsAbout(result.findings, c2)).toEqual([
        { type: 'unexpected-object-type', id: c2, expectedType: 'commit' },
      ]);
      expect(result.exitCode).toBe(0);
    });
  });
});

describe('Given reflog roots c3, c2, c4 in that order, c4 over c3 over c2, and c2 holding c1', () => {
  describe('When fsck runs connectivity-only', () => {
    it('Then c3, already pushed when c4 types it, pops after c2, which is popped untyped', async () => {
      // Arrange
      const ctx = createMemoryContext();
      const [c1, c2, c3, c4] = (await commitChain(ctx, 4)) as [
        ObjectId,
        ObjectId,
        ObjectId,
        ObjectId,
      ];
      await pointMain(ctx, c1, [
        [ZERO, c3],
        [c3, c2],
        [c2, c4],
        [c4, c1],
      ]);
      await serveBytesOf(ctx, c2, c1);
      const sut = fsck;

      // Act
      const result = await sut(ctx, CONNECTIVITY_ONLY);

      // Assert
      expect(typeFindingsAbout(result.findings, c2)).toEqual([
        { type: 'unknown-object-type', id: c2 },
      ]);
    });
  });
});

/** An index with no entry whose resolve-undo records `id` as a regular file. */
const writeResolveUndoNaming = async (ctx: Context, id: ObjectId): Promise<void> => {
  const data = Uint8Array.from([
    ...enc.encode('p\u0000100644\u00000\u00000\u0000'),
    ...hexToBytes(id),
  ]);
  const index = {
    version: 2 as const,
    entries: [],
    extensions: [{ signature: 'REUC', data }],
    trailerSha: new Uint8Array(0),
  };
  await ctx.fs.write(`${ctx.layout.gitDir}/index`, await serializeIndexFixtureAsync(index, ctx));
};

describe('Given reflog roots c3 then c2, c3 over c2, c2 holding c1, and a resolve-undo naming c3', () => {
  describe('When fsck runs connectivity-only', () => {
    it('Then the parse of the resolve-undo stage types c2 before it pops', async () => {
      // Arrange
      const ctx = createMemoryContext();
      const [c1, c2, c3] = (await commitChain(ctx, 3)) as [ObjectId, ObjectId, ObjectId];
      await pointMain(ctx, c1, [
        [ZERO, c3],
        [c3, c2],
        [c2, c1],
      ]);
      await serveBytesOf(ctx, c2, c1);
      await writeResolveUndoNaming(ctx, c3);
      const sut = fsck;

      // Act
      const result = await sut(ctx, CONNECTIVITY_ONLY);

      // Assert
      expect(typeFindingsAbout(result.findings, c2)).toEqual([]);
    });
  });
});

describe('Given an index entry naming a commit no ref reaches', () => {
  describe('When fsck runs connectivity-only', () => {
    it('Then the entry types it a blob, so its tree is never reached', async () => {
      // Arrange
      const ctx = createMemoryContext();
      const [c1] = (await commitChain(ctx, 1)) as [ObjectId];
      await pointMain(ctx, c1, [[ZERO, c1]]);
      const staged = await fileTree(ctx, 'd', 'dd\n');
      const commit = await commitOver(ctx, staged, [], 'x');
      const entry = {
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
        id: commit,
        flags: STAGE0_FLAGS,
        path: 'g' as FilePath,
      };
      const index = {
        version: 2 as const,
        entries: [entry],
        extensions: [],
        trailerSha: new Uint8Array(0),
      };
      await ctx.fs.write(
        `${ctx.layout.gitDir}/index`,
        await serializeIndexFixtureAsync(index, ctx),
      );
      const sut = fsck;

      // Act
      const result = await sut(ctx, CONNECTIVITY_ONLY);

      // Assert
      expect(findingsAbout(result.findings, staged).map((finding) => finding.type)).toEqual([
        'unreachable',
        'dangling',
      ]);
      expect(typeFindingsAbout(result.findings, commit)).toEqual([]);
    });
  });
});

describe('Given a tag ref naming c2, an unreferenced commit whose copy holds a blob', () => {
  describe('When fsck runs connectivity-only', () => {
    it("Then c2, typed a commit by the tag's parse, is reported not a commit", async () => {
      // Arrange
      const ctx = createMemoryContext();
      const [c1, c2] = (await commitChain(ctx, 2)) as [ObjectId, ObjectId];
      await pointMain(ctx, c1, [[ZERO, c1]]);
      const tag = await writeObject(ctx, {
        type: 'tag',
        id: '' as ObjectId,
        data: { object: c2, objectType: 'commit', tagName: 't', message: 't\n', extraHeaders: [] },
      });
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/tags/t`, `${tag}\n`);
      const blob = await writeObject(ctx, {
        type: 'blob',
        id: '' as ObjectId,
        content: enc.encode('zz\n'),
      });
      await serveBytesOf(ctx, c2, blob);
      const sut = fsck;

      // Act
      const result = await sut(ctx, CONNECTIVITY_ONLY);

      // Assert
      expect(typeFindingsAbout(result.findings, c2)).toEqual([
        { type: 'unexpected-object-type', id: c2, expectedType: 'commit' },
      ]);
    });
  });
});

describe("Given main at c2 and c2's tree holding a blob", () => {
  describe('When fsck runs connectivity-only', () => {
    it('Then the tree, typed by the commit naming it, is reported not a tree', async () => {
      // Arrange
      const ctx = createMemoryContext();
      const tree = await fileTree(ctx, 'f', 'v2\n');
      const [c1] = (await commitChain(ctx, 1)) as [ObjectId];
      const c2 = await commitOver(ctx, tree, [c1], 'c2');
      await pointMain(ctx, c2, [[ZERO, c2]]);
      const blob = await writeObject(ctx, {
        type: 'blob',
        id: '' as ObjectId,
        content: enc.encode('zz\n'),
      });
      await serveBytesOf(ctx, tree, blob);
      const sut = fsck;

      // Act
      const result = await sut(ctx, CONNECTIVITY_ONLY);

      // Assert
      expect(typeFindingsAbout(result.findings, tree)).toEqual([
        { type: 'unexpected-object-type', id: tree, expectedType: 'tree' },
      ]);
    });
  });
});

describe("Given main at c3, a commit-graph holding c1..c3, and c2's copy holding a blob", () => {
  describe('When fsck runs connectivity-only', () => {
    it('Then c2, typed by c3, is parsed from the graph: no type finding and its tree reached', async () => {
      // Arrange
      const { ctx, c2 } = await history();
      await writeCommitGraph(ctx);
      const c2Tree = await fileTree(ctx, 'f', 'v2\n');
      const blob = await writeObject(ctx, {
        type: 'blob',
        id: '' as ObjectId,
        content: enc.encode('zz\n'),
      });
      await serveBytesOf(ctx, c2, blob);
      const sut = fsck;

      // Act
      const result = await sut({ ...ctx, session: createSession() }, CONNECTIVITY_ONLY);

      // Assert
      expect([
        ...typeFindingsAbout(result.findings, c2),
        ...findingsAbout(result.findings, c2Tree),
      ]).toEqual([]);
    });
  });
});

describe("Given main at c3, a commit-graph holding c1..c3, and c2's copy holding c1", () => {
  describe('When fsck runs connectivity-only', () => {
    it("Then c2 is walked through the graph's tree and parents, never its served bytes", async () => {
      // Arrange
      const { ctx, c1, c2 } = await history();
      await writeCommitGraph(ctx);
      const c2Tree = await fileTree(ctx, 'f', 'v2\n');
      await serveBytesOf(ctx, c2, c1);
      const sut = fsck;

      // Act
      const result = await sut({ ...ctx, session: createSession() }, CONNECTIVITY_ONLY);

      // Assert
      expect(findingsAbout(result.findings, c2Tree)).toEqual([]);
    });
  });
});
