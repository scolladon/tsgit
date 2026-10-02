/**
 * With a promisor remote configured, git's fsck treats every object a
 * `.promisor` pack holds — and every object those point at — as present: the
 * walk stops at one, and nothing it names is reported missing, broken, an
 * invalid pointer or an unreadable special blob. fsck never lazy-fetches.
 */
import { describe, expect, it, vi } from 'vitest';
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
import type { PromisorRemote } from '../../../../src/ports/promisor.js';
import { type EntrySpec, writeSyntheticPack } from '../primitives/pack-fixture.js';

const enc = new TextEncoder();
const EXIT_OK = 0;
const EXIT_MISSING = 2;
const PROMISOR_REMOTE = '[remote "origin"]\n\tpromisor = true\n';
const IDENT = 'Ada <ada@example.com> 1700000000 +0000';
const GITMODULES = enc.encode('[submodule "x"]\n\tpath = x\n\turl = -evil\n');

const initCtx = async (config = PROMISOR_REMOTE): Promise<Context> => {
  const ctx = createMemoryContext();
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, config);
  return ctx;
};

const idOf = async (ctx: Context, type: string, content: Uint8Array): Promise<ObjectId> => {
  const header = enc.encode(`${type} ${content.length}\0`);
  return (await ctx.hash.hashHex(new Uint8Array([...header, ...content]))) as ObjectId;
};

const absentBlob = (ctx: Context, text: string): Promise<ObjectId> =>
  idOf(ctx, 'blob', enc.encode(text));

const commitBody = (tree: ObjectId, parents: ReadonlyArray<ObjectId>): Uint8Array =>
  enc.encode(
    `tree ${tree}\n${parents.map((p) => `parent ${p}\n`).join('')}author ${IDENT}\ncommitter ${IDENT}\n\nc\n`,
  );

const treeBody = (ctx: Context, name: string, id: ObjectId): Uint8Array =>
  serializeTreeContent(
    { type: 'tree', id: '' as ObjectId, entries: [treeEntry(FILE_MODE.REGULAR, name, id)] },
    ctx.hashConfig,
  );

const tagBody = (target: ObjectId): Uint8Array =>
  enc.encode(`object ${target}\ntype commit\ntag v1\ntagger ${IDENT}\n\nt\n`);

const entry = (type: 'blob' | 'tree' | 'commit' | 'tag', content: Uint8Array): EntrySpec => ({
  kind: 'base',
  type,
  content,
});

type PackWriter = (
  ctx: Context,
  entries: ReadonlyArray<EntrySpec>,
) => Promise<ReadonlyArray<ObjectId>>;

const writePlainPack: PackWriter = async (ctx, entries) =>
  (await writeSyntheticPack(ctx, 'promised', entries)) as ReadonlyArray<ObjectId>;

const writePromisorPack: PackWriter = async (ctx, entries) => {
  const ids = await writePlainPack(ctx, entries);
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/objects/pack/pack-promised.promisor`, '');
  return ids;
};

const writeRef = (ctx: Context, name: string, id: ObjectId): Promise<void> =>
  ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/${name}`, `${id}\n`);

/** A packed commit (the `main` tip) on an empty tree, naming the absent `parent`. */
const promisorCommitWithAbsentParent = async (
  ctx: Context,
  writePack: PackWriter = writePromisorPack,
): Promise<{ readonly parent: ObjectId }> => {
  const tree = await idOf(ctx, 'tree', new Uint8Array());
  const parent = await idOf(ctx, 'commit', commitBody(tree, []));
  const [commit] = await writePack(ctx, [
    entry('commit', commitBody(tree, [parent])),
    entry('tree', new Uint8Array()),
    entry('blob', enc.encode('a blob points at nothing')),
  ]);
  await writeRef(ctx, 'main', commit as ObjectId);
  return { parent };
};

const missingOrBroken = (findings: ReadonlyArray<FsckFinding>) =>
  findings.filter((f) => f.type === 'missing' || f.type === 'broken-link');

const badRefTargets = (findings: ReadonlyArray<FsckFinding>) =>
  findings.flatMap((f) => (f.type === 'bad-ref' ? [f.target] : []));

describe('Given a promisor-pack commit whose parent is absent', () => {
  describe.each([
    { remote: 'remote.<name>.promisor', config: PROMISOR_REMOTE },
    {
      remote: 'remote.<name>.partialclonefilter',
      config: '[remote "origin"]\n\tpartialclonefilter = blob:none\n',
    },
    { remote: 'extensions.partialClone', config: '[extensions]\n\tpartialClone = origin\n' },
  ])('When fsck runs with $remote naming a promisor remote', ({ config }) => {
    it('Then the commit is reached without walking below it', async () => {
      // Arrange
      const ctx = await initCtx(config);
      await promisorCommitWithAbsentParent(ctx);
      const sut = fsck;

      // Act
      const result = await sut(ctx);

      // Assert
      expect(missingOrBroken(result.findings)).toEqual([]);
      expect(result.exitCode).toBe(EXIT_OK);
    });
  });

  describe.each([
    { remote: 'no promisor remote', config: '' },
    { remote: 'remote.<name>.promisor = false', config: '[remote "origin"]\n\tpromisor = false\n' },
  ])('When fsck runs with $remote', ({ config }) => {
    it('Then the parent is reported missing', async () => {
      // Arrange
      const ctx = await initCtx(config);
      const { parent } = await promisorCommitWithAbsentParent(ctx);
      const sut = fsck;

      // Act
      const result = await sut(ctx);

      // Assert
      expect(result.findings).toContainEqual({ type: 'missing', id: parent, objectType: 'commit' });
      expect(result.exitCode).toBe(EXIT_MISSING);
    });
  });

  describe('When the pack carries no .promisor marker', () => {
    it('Then the parent is reported missing', async () => {
      // Arrange
      const ctx = await initCtx();
      const { parent } = await promisorCommitWithAbsentParent(ctx, writePlainPack);
      const sut = fsck;

      // Act
      const result = await sut(ctx);

      // Assert
      expect(result.findings).toContainEqual({ type: 'missing', id: parent, objectType: 'commit' });
    });
  });

  describe('When a ref and a reflog entry name the absent parent', () => {
    it('Then neither is reported, as git does', async () => {
      // Arrange
      const ctx = await initCtx();
      const { parent } = await promisorCommitWithAbsentParent(ctx);
      await writeRef(ctx, 'gone', parent);
      await ctx.fs.mkdir(`${ctx.layout.gitDir}/logs/refs/heads`);
      await ctx.fs.writeUtf8(
        `${ctx.layout.gitDir}/logs/refs/heads/main`,
        `${parent} ${parent} ${IDENT}\tx\n`,
      );
      const sut = fsck;

      // Act
      const result = await sut(ctx);

      // Assert
      expect(result.findings.filter((f) => f.type === 'invalid-reflog-entry')).toEqual([]);
      expect(badRefTargets(result.findings)).toEqual([]);
      expect(result.exitCode).toBe(EXIT_OK);
    });
  });

  describe('When fsck runs without --full and a ref names the absent parent', () => {
    it('Then the unverified pack still settles the promisor objects', async () => {
      // Arrange
      const ctx = await initCtx();
      const { parent } = await promisorCommitWithAbsentParent(ctx);
      await writeRef(ctx, 'gone', parent);
      const sut = fsck;

      // Act
      const result = await sut(ctx, { full: false });

      // Assert
      expect(badRefTargets(result.findings)).toEqual([]);
      expect(result.exitCode).toBe(EXIT_OK);
    });
  });
});

describe('Given a ref naming the absent tree of a promisor-pack commit', () => {
  describe('When fsck runs', () => {
    it('Then the ref is not an invalid pointer', async () => {
      // Arrange
      const ctx = await initCtx();
      const tree = await idOf(ctx, 'tree', treeBody(ctx, 'f', await absentBlob(ctx, 'f')));
      const [commit] = await writePromisorPack(ctx, [entry('commit', commitBody(tree, []))]);
      await writeRef(ctx, 'main', commit as ObjectId);
      await writeRef(ctx, 'gone', tree);
      const sut = fsck;

      // Act
      const result = await sut(ctx);

      // Assert
      expect(badRefTargets(result.findings)).toEqual([]);
    });
  });
});

describe('Given a ref naming the absent target of a promisor-pack tag', () => {
  describe('When fsck runs', () => {
    it('Then the ref is not an invalid pointer', async () => {
      // Arrange
      const ctx = await initCtx();
      const target = await idOf(ctx, 'commit', commitBody(await absentBlob(ctx, 't'), []));
      await writePromisorPack(ctx, [entry('tag', tagBody(target))]);
      await writeRef(ctx, 'gone', target);
      const sut = fsck;

      // Act
      const result = await sut(ctx);

      // Assert
      expect(badRefTargets(result.findings)).toEqual([]);
    });
  });
});

describe('Given a loose tree naming a blob absent but named by a promisor-pack tree', () => {
  describe('When fsck runs', () => {
    it('Then the blob is not reported missing', async () => {
      // Arrange
      const ctx = await initCtx();
      const blob = await absentBlob(ctx, 'promised');
      await writePromisorPack(ctx, [entry('tree', treeBody(ctx, 'g', blob))]);
      const tree = await writeObject(ctx, {
        type: 'tree',
        id: '' as ObjectId,
        entries: [treeEntry(FILE_MODE.REGULAR, 'f', blob)],
      });
      const commit = await writeObject(ctx, {
        type: 'commit',
        id: '' as ObjectId,
        data: {
          tree,
          parents: [],
          author: { name: 'Ada', email: 'ada@example.com', timestamp: 1, timezoneOffset: '+0000' },
          committer: {
            name: 'Ada',
            email: 'ada@example.com',
            timestamp: 1,
            timezoneOffset: '+0000',
          },
          message: 'c\n',
          extraHeaders: [],
        },
      });
      await writeRef(ctx, 'main', commit);
      const sut = fsck;

      // Act
      const result = await sut(ctx);

      // Assert
      expect(missingOrBroken(result.findings)).toEqual([]);
    });
  });
});

describe('Given a promisor-pack commit whose loose tree names an absent blob', () => {
  describe('When fsck runs', () => {
    it('Then nothing below the promisor commit is walked', async () => {
      // Arrange
      const ctx = await initCtx();
      const looseTree = {
        type: 'tree' as const,
        id: '' as ObjectId,
        entries: [treeEntry(FILE_MODE.REGULAR, 'f', await absentBlob(ctx, 'never walked'))],
      };
      const tree = await idOf(ctx, 'tree', serializeTreeContent(looseTree, ctx.hashConfig));
      const [commit] = await writePromisorPack(ctx, [entry('commit', commitBody(tree, []))]);
      await writeObject(ctx, looseTree);
      await writeRef(ctx, 'main', commit as ObjectId);
      const sut = fsck;

      // Act
      const result = await sut(ctx);

      // Assert
      expect(missingOrBroken(result.findings)).toEqual([]);
      expect(result.exitCode).toBe(EXIT_OK);
    });
  });
});

describe('Given a promisor-pack tree naming an absent .gitmodules blob', () => {
  describe('When fsck runs', () => {
    it('Then the blob is not reported unreadable', async () => {
      // Arrange
      const ctx = await initCtx();
      const blob = await idOf(ctx, 'blob', GITMODULES);
      const tree = treeBody(ctx, '.gitmodules', blob);
      const treeId = await idOf(ctx, 'tree', tree);
      const [commit] = await writePromisorPack(ctx, [
        entry('commit', commitBody(treeId, [])),
        entry('tree', tree),
      ]);
      await writeRef(ctx, 'main', commit as ObjectId);
      const sut = fsck;

      // Act
      const result = await sut(ctx);

      // Assert
      expect(result.findings.filter((f) => f.type === 'bad-object')).toEqual([]);
      expect(result.exitCode).toBe(EXIT_OK);
    });
  });
});

describe('Given a promisor pack whose objects git meets in pack order', () => {
  const GARBAGE = entry('commit', enc.encode('not a commit'));

  describe('When an unparseable object precedes the tag naming an absent commit', () => {
    it('Then git stops collecting there and the ref to that commit is invalid', async () => {
      // Arrange
      const ctx = await initCtx();
      const target = await idOf(ctx, 'commit', commitBody(await absentBlob(ctx, 'o'), []));
      await writePromisorPack(ctx, [GARBAGE, entry('tag', tagBody(target))]);
      await writeRef(ctx, 'gone', target);
      const sut = fsck;

      // Act
      const result = await sut(ctx);

      // Assert
      expect(badRefTargets(result.findings)).toEqual([target]);
    });
  });

  describe('When the tag precedes the unparseable object', () => {
    it('Then the commit it names is already a promisor object', async () => {
      // Arrange
      const ctx = await initCtx();
      const target = await idOf(ctx, 'commit', commitBody(await absentBlob(ctx, 'o'), []));
      await writePromisorPack(ctx, [entry('tag', tagBody(target)), GARBAGE]);
      await writeRef(ctx, 'gone', target);
      const sut = fsck;

      // Act
      const result = await sut(ctx);

      // Assert
      expect(badRefTargets(result.findings)).toEqual([]);
    });
  });
});

describe('Given a context carrying a promisor remote and an absent .gitmodules blob', () => {
  describe('When fsck reads the objects it audits', () => {
    it('Then it never lazy-fetches, as git does', async () => {
      // Arrange
      const base = await initCtx('');
      const fetch = vi.fn<PromisorRemote['fetch']>(async (oids) => ({
        attempted: true,
        requested: oids.length,
        fetched: 0,
      }));
      const ctx: Context = { ...base, promisor: { fetch } };
      const blob = await idOf(ctx, 'blob', GITMODULES);
      await writeObject(ctx, {
        type: 'tree',
        id: '' as ObjectId,
        entries: [treeEntry(FILE_MODE.REGULAR, '.gitmodules', blob)],
      });
      await writeRef(ctx, 'gone', blob);
      const sut = fsck;

      // Act
      await sut(ctx);

      // Assert
      expect(fetch).not.toHaveBeenCalled();
    });
  });
});
