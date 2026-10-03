import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { evaluateRevision, revParse } from '../../../../src/application/commands/rev-parse.js';
import type { TsgitError } from '../../../../src/domain/error.js';
import { parseCommitContent } from '../../../../src/domain/objects/commit.js';
import type { Commit, ObjectId } from '../../../../src/domain/objects/index.js';
import { computeLooseObjectPath } from '../../../../src/domain/storage/loose-path.js';
import type { Context } from '../../../../src/ports/context.js';
import { writeCommitGraph, writeRawObjectBytes } from '../primitives/fixtures.js';

const ABSENT_OID = '1'.repeat(40) as ObjectId;
const encoder = new TextEncoder();

interface SearchRepo {
  readonly ctx: Context;
  readonly errors: string[];
  readonly ids: Readonly<Record<string, ObjectId>>;
}

const loggingContext = (): { readonly ctx: Context; readonly errors: string[] } => {
  const errors: string[] = [];
  const ctx = {
    ...createMemoryContext(),
    logger: { error: (message: string) => errors.push(message) },
  } as Context;
  return { ctx, errors };
};

/** A commit's raw bytes; `message` undefined writes no blank line at all. */
const commitBytes = (
  tree: ObjectId,
  parents: ReadonlyArray<ObjectId>,
  date: number,
  message: string | undefined,
): Uint8Array => {
  const header = [
    `tree ${tree}\n`,
    ...parents.map((parent) => `parent ${parent}\n`),
    `author A <a@a> ${date} +0000\n`,
    `committer A <a@a> ${date} +0000\n`,
  ].join('');
  const body = message === undefined ? '' : `\n${message}`;
  return encoder.encode(`${header}${body}`);
};

const writeCommit = (
  ctx: Context,
  tree: ObjectId,
  parents: ReadonlyArray<ObjectId>,
  date: number,
  message: string | undefined,
): Promise<ObjectId> =>
  writeRawObjectBytes(ctx, 'commit', commitBytes(tree, parents, date, message));

const writeGraphCommit = async (
  ctx: Context,
  tree: ObjectId,
  parents: ReadonlyArray<ObjectId>,
  date: number,
  message: string,
): Promise<Commit> => {
  const bytes = commitBytes(tree, parents, date, message);
  return parseCommitContent(await writeRawObjectBytes(ctx, 'commit', bytes), bytes);
};

const writeRef = (ctx: Context, name: string, id: ObjectId): Promise<void> =>
  ctx.fs.writeUtf8(`${ctx.layout.gitDir}/${name}`, `${id}\n`);

/**
 * c1 ← c2 ← a ──────────┐
 *        ↖ s1 ← s2 ← m (merge: a, s2)
 * with a and s1 sharing one date, s2 younger; `nobody` (no message) on m,
 * `mp` naming an absent parent then `nobody`, `bp` a blob then c1, `z` a
 * message holding a NUL, `t` an annotated tag of m and `tt` one of the tree.
 */
const searchRepo = async (): Promise<SearchRepo> => {
  const { ctx, errors } = loggingContext();
  const tree = await writeRawObjectBytes(ctx, 'tree', new Uint8Array());
  const blob = await writeRawObjectBytes(ctx, 'blob', encoder.encode('b\n'));
  const c1 = await writeCommit(ctx, tree, [], 1, 'first fix\n');
  const c2 = await writeCommit(ctx, tree, [c1], 2, 'second !bang\n');
  const a = await writeCommit(ctx, tree, [c2], 5, 'main same-date\n');
  const s1 = await writeCommit(ctx, tree, [c2], 5, 'side same-date\n');
  const s2 = await writeCommit(ctx, tree, [s1], 7, 'side newer\n');
  const m = await writeCommit(ctx, tree, [a, s2], 9, 'merge it\n');
  const nobody = await writeCommit(ctx, tree, [m], 20, undefined);
  const mp = await writeCommit(ctx, tree, [ABSENT_OID, nobody], 30, 'missing parent\n');
  const bp = await writeCommit(ctx, tree, [blob, c1], 31, 'blob parent\n');
  const z = await writeCommit(ctx, tree, [c1], 40, 'head\u0000tail\n');
  const t = await writeRawObjectBytes(
    ctx,
    'tag',
    encoder.encode(`object ${m}\ntype commit\ntag t\ntagger A <a@a> 1 +0000\n\nt\n`),
  );
  const tt = await writeRawObjectBytes(
    ctx,
    'tag',
    encoder.encode(`object ${tree}\ntype tree\ntag tt\ntagger A <a@a> 1 +0000\n\ntt\n`),
  );
  await writeRef(ctx, 'refs/heads/main', m);
  await writeRef(ctx, 'refs/tags/t', t);
  await writeRef(ctx, 'refs/tags/tt', tt);
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
  return { ctx, errors, ids: { blob, c1, c2, a, s1, s2, m, nobody, mp, bp, z } };
};

const failureCode = async (run: () => Promise<unknown>): Promise<string | undefined> => {
  try {
    await run();
  } catch (error) {
    return (error as TsgitError).data.code;
  }
  return undefined;
};

describe('Given a history searched by commit message', () => {
  describe.each([
    { arg: 'HEAD^{/same-date}', expected: 'a' },
    { arg: 'HEAD^{/side}', expected: 's2' },
    { arg: 'HEAD^{/^(main|side) same}', expected: 'a' },
    { arg: 'HEAD^{/merge}', expected: 'm' },
    { arg: 'HEAD^{/}', expected: 'm' },
    { arg: 'HEAD^{/!-same}', expected: 'm' },
    { arg: 'HEAD^{/!!bang}', expected: 'c2' },
    { arg: 'HEAD^{/sec}~1', expected: 'c1' },
    { arg: 'HEAD^{/sec}^{/first}', expected: 'c1' },
    { arg: 't^{/second}', expected: 'c2' },
    { arg: 'nobody^{/!-zzz}', expected: 'nobody' },
    { arg: 'nobody^{/.}', expected: 'm' },
    { arg: 'z^{/head}', expected: 'z' },
  ])('When evaluateRevision reads $arg', ({ arg, expected }) => {
    it(`Then it names ${expected}`, async () => {
      // Arrange
      const { ctx, ids } = await searchRepo();
      const expression = arg.replace(/^(nobody|z)\b/, (name) => ids[name] as string);
      const sut = evaluateRevision;

      // Act
      const result = await sut(ctx, expression);

      // Assert
      expect(result).toBe(ids[expected]);
    });
  });

  describe.each([
    { arg: 'HEAD^{/date$}' },
    { arg: 'HEAD^{/!x}' },
    { arg: 'HEAD^{/(}' },
    { arg: 'HEAD^{/nomatch}' },
    { arg: 'z^{/tail}' },
  ])('When evaluateRevision reads $arg', ({ arg }) => {
    it('Then it names no object', async () => {
      // Arrange
      const { ctx, ids } = await searchRepo();
      const expression = arg.replace(/^z\b/, ids.z as string);
      const sut = evaluateRevision;

      // Act
      const result = await failureCode(() => sut(ctx, expression));

      // Assert
      expect(result).toBe('REVPARSE_UNRESOLVED');
    });
  });

  describe('When the search starts from a commit naming an absent parent', () => {
    it('Then git reports the parent it could not read and searches the rest', async () => {
      // Arrange
      const { ctx, errors, ids } = await searchRepo();
      const sut = evaluateRevision;

      // Act
      const result = await sut(ctx, `${ids.mp}^{/second}`);

      // Assert
      expect(result).toBe(ids.c2);
      expect(errors).toEqual([`Could not read ${ABSENT_OID}`]);
    });
  });

  describe('When the search starts from a commit naming a blob as a parent', () => {
    it('Then git reports the parent that is no commit and searches the rest', async () => {
      // Arrange
      const { ctx, errors, ids } = await searchRepo();
      const sut = evaluateRevision;

      // Act
      const result = await sut(ctx, `${ids.bp}^{/first}`);

      // Assert
      expect(result).toBe(ids.c1);
      expect(errors).toEqual([`Object ${ids.blob} not a commit`]);
    });
  });

  describe('When revParse finds no match past an absent parent', () => {
    it('Then each of its two reads reports the parent', async () => {
      // Arrange
      const { ctx, errors, ids } = await searchRepo();
      const sut = revParse;

      // Act
      const result = await failureCode(() => sut(ctx, `${ids.mp}^{/zzz}`));

      // Assert
      expect(result).toBe('REVPARSE_UNRESOLVED');
      expect(errors).toEqual([`Could not read ${ABSENT_OID}`, `Could not read ${ABSENT_OID}`]);
    });
  });

  describe('When the search starts from a tag of a tree', () => {
    it('Then git reports the peel mismatch under the whole operator', async () => {
      // Arrange
      const { ctx, errors } = await searchRepo();
      const sut = evaluateRevision;

      // Act
      const result = await failureCode(() => sut(ctx, 'tt^{/x}'));

      // Assert
      expect(result).toBeDefined();
      expect(errors).toEqual([
        'tt^{/x}: expected commit type, but the object dereferences to tree type',
      ]);
    });
  });
});

describe('Given a commit-graph serving a commit whose object is gone', () => {
  describe('When a message search reaches that commit', () => {
    it('Then it walks past it without matching it', async () => {
      // Arrange
      const { ctx } = loggingContext();
      const tree = await writeRawObjectBytes(ctx, 'tree', new Uint8Array());
      const base = await writeGraphCommit(ctx, tree, [], 1, 'base\n');
      const gone = await writeGraphCommit(ctx, tree, [base.id], 2, 'gone\n');
      const tip = await writeGraphCommit(ctx, tree, [gone.id], 3, 'tip\n');
      await writeCommitGraph(ctx, [[base, gone, tip]]);
      await ctx.fs.rm(`${ctx.layout.gitDir}/objects/${computeLooseObjectPath(gone.id)}`);
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
      const sut = evaluateRevision;

      // Act
      const result = await sut(ctx, `${tip.id}^{/^(gone|base)}`);

      // Assert
      expect(result).toBe(base.id);
    });
  });
});

const GARBAGE = encoder.encode('not a zlib stream');

describe('Given a message search reaching an object that fails to read', () => {
  describe('When the unreadable object is a parent the walk parses', () => {
    it('Then the read failure propagates', async () => {
      // Arrange
      const { ctx } = loggingContext();
      const tree = await writeRawObjectBytes(ctx, 'tree', new Uint8Array());
      const corrupt = '2'.repeat(40) as ObjectId;
      await ctx.fs.write(
        `${ctx.layout.gitDir}/objects/${computeLooseObjectPath(corrupt)}`,
        GARBAGE,
      );
      const tip = await writeCommit(ctx, tree, [corrupt], 3, 'tip\n');
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
      const sut = evaluateRevision;

      // Act
      const result = await failureCode(() => sut(ctx, `${tip}^{/zzz}`));

      // Assert
      expect(result).toBe('DECOMPRESS_FAILED');
    });
  });

  describe('When the unreadable object is a commit the commit-graph served', () => {
    it('Then the read failure propagates', async () => {
      // Arrange
      const { ctx } = loggingContext();
      const tree = await writeRawObjectBytes(ctx, 'tree', new Uint8Array());
      const base = await writeGraphCommit(ctx, tree, [], 1, 'base\n');
      const tip = await writeGraphCommit(ctx, tree, [base.id], 3, 'tip\n');
      await writeCommitGraph(ctx, [[base, tip]]);
      await ctx.fs.write(
        `${ctx.layout.gitDir}/objects/${computeLooseObjectPath(base.id)}`,
        GARBAGE,
      );
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
      const sut = evaluateRevision;

      // Act
      const result = await failureCode(() => sut(ctx, `${tip.id}^{/zzz}`));

      // Assert
      expect(result).toBe('DECOMPRESS_FAILED');
    });
  });
});

describe('Given two branches sharing a parent that names an absent parent', () => {
  describe('When a message search walks through the shared parent', () => {
    it('Then it queues the shared parent once, reporting the absent one once', async () => {
      // Arrange
      const { ctx, errors } = loggingContext();
      const tree = await writeRawObjectBytes(ctx, 'tree', new Uint8Array());
      const shared = await writeCommit(ctx, tree, [ABSENT_OID], 1, 'shared\n');
      const left = await writeCommit(ctx, tree, [shared], 2, 'left\n');
      const right = await writeCommit(ctx, tree, [shared], 3, 'right\n');
      const top = await writeCommit(ctx, tree, [left, right], 4, 'top\n');
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
      const sut = evaluateRevision;

      // Act
      const result = await failureCode(() => sut(ctx, `${top}^{/zzz}`));

      // Assert
      expect(result).toBe('REVPARSE_UNRESOLVED');
      expect(errors).toEqual([`Could not read ${ABSENT_OID}`]);
    });
  });
});

describe('Given a commit naming an absent parent', () => {
  describe('When evaluateRevision reads it with an empty search', () => {
    it('Then it names the commit without walking to the parent', async () => {
      // Arrange
      const { ctx, errors, ids } = await searchRepo();
      const sut = evaluateRevision;

      // Act
      const result = await sut(ctx, `${ids.mp}^{/}`);

      // Assert
      expect(result).toBe(ids.mp);
      expect(errors).toEqual([]);
    });
  });
});

/**
 * c1 ← c2, then three same-date tips on c2: main (HEAD), a and z, plus
 * `head` beside them; `bad` tags an absent commit, `tt` the tree,
 * `dangling` names an absent object, `broken` holds no ref and `stale` points
 * at an absent ref.
 */
const allRefsRepo = async (): Promise<SearchRepo> => {
  const { ctx, errors } = loggingContext();
  const tree = await writeRawObjectBytes(ctx, 'tree', new Uint8Array());
  const c1 = await writeCommit(ctx, tree, [], 1, 'first fix\n');
  const c2 = await writeCommit(ctx, tree, [c1], 2, 'second\n');
  const tips = Object.fromEntries(
    await Promise.all(
      ['main', 'a', 'z', 'head'].map(
        async (name) => [name, await writeCommit(ctx, tree, [c2], 5, `tip ${name}\n`)] as const,
      ),
    ),
  );
  const tag = (target: ObjectId, type: string, name: string) =>
    writeRawObjectBytes(
      ctx,
      'tag',
      encoder.encode(
        `object ${target}\ntype ${type}\ntag ${name}\ntagger A <a@a> 1 +0000\n\n${name}\n`,
      ),
    );
  for (const name of ['main', 'a', 'z'])
    await writeRef(ctx, `refs/heads/${name}`, tips[name] as ObjectId);
  await writeRef(ctx, 'refs/heads/dangling', ABSENT_OID);
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/broken`, 'garbage\n');
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/stale`, 'ref: refs/heads/gone\n');
  await writeRef(ctx, 'refs/tags/bad', await tag(ABSENT_OID, 'commit', 'bad'));
  await writeRef(ctx, 'refs/tags/tt', await tag(tree, 'tree', 'tt'));
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
  return { ctx, errors, ids: { c1, c2, ...tips } };
};

const BAD_TAG_ERROR = "missing object referenced by 'refs/tags/bad'";

describe('Given refs whose histories are searched by commit message', () => {
  describe.each([
    { arg: ':/tip', expected: 'main' },
    { arg: ':/tip (a|z)', expected: 'z' },
    { arg: ':/second', expected: 'c2' },
    { arg: ':/!-tip', expected: 'c2' },
  ])('When evaluateRevision reads $arg', ({ arg, expected }) => {
    it(`Then it names ${expected}, reporting the tag of an absent object`, async () => {
      // Arrange
      const { ctx, errors, ids } = await allRefsRepo();
      const sut = evaluateRevision;

      // Act
      const result = await sut(ctx, arg);

      // Assert
      expect(result).toBe(ids[expected]);
      expect(errors).toEqual([BAD_TAG_ERROR]);
    });
  });

  describe('When HEAD is detached at a commit no ref names', () => {
    it('Then HEAD is searched first', async () => {
      // Arrange
      const { ctx, ids } = await allRefsRepo();
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, `${ids.head}\n`);
      const sut = evaluateRevision;

      // Act
      const result = await sut(ctx, ':/tip');

      // Assert
      expect(result).toBe(ids.head);
    });
  });

  describe.each([{ arg: ':/zzz' }, { arg: ':/!x' }])('When revParse reads $arg', ({ arg }) => {
    it('Then it names no object, reporting the tag once as git does', async () => {
      // Arrange
      const { ctx, errors } = await allRefsRepo();
      const sut = revParse;

      // Act
      const result = await failureCode(() => sut(ctx, arg));

      // Assert
      expect(result).toBe('REVPARSE_UNRESOLVED');
      expect(errors).toEqual([BAD_TAG_ERROR]);
    });
  });
});

describe('Given a ref naming an object that fails to read', () => {
  describe('When evaluateRevision searches every ref', () => {
    it('Then the read failure propagates', async () => {
      // Arrange
      const { ctx } = await allRefsRepo();
      const corrupt = '3'.repeat(40) as ObjectId;
      await ctx.fs.write(
        `${ctx.layout.gitDir}/objects/${computeLooseObjectPath(corrupt)}`,
        GARBAGE,
      );
      await writeRef(ctx, 'refs/heads/corrupt', corrupt);
      const sut = evaluateRevision;

      // Act
      const result = await failureCode(() => sut(ctx, ':/tip'));

      // Assert
      expect(result).toBe('DECOMPRESS_FAILED');
    });
  });
});
