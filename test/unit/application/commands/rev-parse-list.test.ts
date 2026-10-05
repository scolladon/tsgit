import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { revParse } from '../../../../src/application/commands/rev-parse.js';
import type { TsgitError } from '../../../../src/domain/error.js';
import type { ObjectId } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';
import { writeRawObjectBytes } from '../primitives/fixtures.js';

const encoder = new TextEncoder();
/** A blob whose id shares its first four hex digits with `c2`'s. */
const C2_PREFIX_BLOB = 'x133570\n';
const C2_PREFIX = '1c63';
/** A tree entry name that makes its one-entry tree's id share `c2`'s prefix. */
const C2_PREFIX_TREE_ENTRY = 't153626';
const EMPTY_BLOB = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391';

interface ListRepo {
  readonly ctx: Context;
  readonly errors: string[];
  readonly ids: Readonly<Record<string, ObjectId>>;
}

const writeCommit = (
  ctx: Context,
  tree: ObjectId,
  parents: ReadonlyArray<ObjectId>,
  date: number,
  message: string,
): Promise<ObjectId> => {
  const header = [
    `tree ${tree}\n`,
    ...parents.map((parent) => `parent ${parent}\n`),
    `author A <a@a> ${date} +0000\n`,
    `committer A <a@a> ${date} +0000\n`,
  ].join('');
  return writeRawObjectBytes(ctx, 'commit', encoder.encode(`${header}\n${message}`));
};

const writeRef = (ctx: Context, name: string, id: ObjectId): Promise<void> =>
  ctx.fs.writeUtf8(`${ctx.layout.gitDir}/${name}`, `${id}\n`);

/**
 * c1 ← c2 (main, HEAD) and c1 ← s1 (side, newer than c2); x1 merges s1 into
 * c2 and x2 c2 into s1, so x1...x2 has both c2 and s1 as merge bases; `t`
 * an annotated tag of c1; a blob sharing c2's abbreviated id.
 */
const listRepo = async (): Promise<ListRepo> => {
  const errors: string[] = [];
  const ctx = {
    ...createMemoryContext(),
    logger: { error: (message: string) => errors.push(message) },
  } as Context;
  const tree = await writeRawObjectBytes(ctx, 'tree', new Uint8Array());
  const c1 = await writeCommit(ctx, tree, [], 1, 'c1\n');
  const c2 = await writeCommit(ctx, tree, [c1], 2, 'c2\n');
  const s1 = await writeCommit(ctx, tree, [c1], 3, 's1\n');
  const x1 = await writeCommit(ctx, tree, [c2, s1], 10, 'x1\n');
  const x2 = await writeCommit(ctx, tree, [s1, c2], 11, 'x2\n');
  const t = await writeRawObjectBytes(
    ctx,
    'tag',
    encoder.encode(`object ${c1}\ntype commit\ntag t\ntagger A <a@a> 1 +0000\n\nt\n`),
  );
  await writeRawObjectBytes(ctx, 'blob', encoder.encode(C2_PREFIX_BLOB));
  await writeRef(ctx, 'refs/heads/main', c2);
  await writeRef(ctx, 'refs/heads/side', s1);
  await writeRef(ctx, 'refs/heads/x1', x1);
  await writeRef(ctx, 'refs/heads/x2', x2);
  await writeRef(ctx, 'refs/tags/t', t);
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
  return { ctx, errors, ids: { tree, c1, c2, s1, x1, x2, t } };
};

const failureData = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    await run();
  } catch (error) {
    return (error as TsgitError).data;
  }
  return undefined;
};

/** `[name, negated]` pairs read back into entries over the fixture's ids. */
const entries = (
  ids: Readonly<Record<string, ObjectId>>,
  pairs: ReadonlyArray<readonly [string, boolean]>,
) => pairs.map(([name, negated]) => ({ kind: 'object', id: ids[name], negated }));

describe('Given a history with two branches, criss-cross merges and a tag', () => {
  describe.each([
    { arg: 'main', expected: [['c2', false]] },
    { arg: '^side', expected: [['s1', true]] },
    {
      arg: 'side..main',
      expected: [
        ['c2', false],
        ['s1', true],
      ],
    },
    {
      arg: '..side',
      expected: [
        ['s1', false],
        ['c2', true],
      ],
    },
    {
      arg: 'side..',
      expected: [
        ['c2', false],
        ['s1', true],
      ],
    },
    {
      arg: 'side...main',
      expected: [
        ['c2', false],
        ['s1', false],
        ['c1', true],
      ],
    },
    {
      arg: '...',
      expected: [
        ['c2', false],
        ['c2', false],
        ['c2', true],
      ],
    },
    {
      arg: 'x1...x2',
      expected: [
        ['x2', false],
        ['x1', false],
        ['s1', true],
        ['c2', true],
      ],
    },
    {
      arg: 't..main',
      expected: [
        ['c2', false],
        ['t', true],
      ],
    },
    {
      arg: 't...main',
      expected: [
        ['c2', false],
        ['t', false],
        ['c1', true],
      ],
    },
    {
      arg: `${C2_PREFIX}..side`,
      expected: [
        ['s1', false],
        ['c2', true],
      ],
    },
  ] as const)('When revParse reads $arg', ({ arg, expected }) => {
    it("Then it answers git's revisions in git's order", async () => {
      // Arrange
      const { ctx, ids } = await listRepo();
      const sut = revParse;

      // Act
      const result = await sut(ctx, arg);

      // Assert
      expect(result).toEqual(entries(ids, expected));
    });
  });

  describe('When revParse reads a symmetric range one side of which is a tree', () => {
    it('Then it reports the tree and refuses the whole argument', async () => {
      // Arrange
      const { ctx, errors, ids } = await listRepo();
      const sut = revParse;

      // Act
      const result = await failureData(() => sut(ctx, `${ids.tree}...main`));

      // Assert
      expect(result).toMatchObject({
        code: 'OBJECT_NOT_FOUND',
        printed: [
          ...entries(ids, [
            ['c2', false],
            ['tree', false],
          ]),
          { kind: 'path', path: `${ids.tree}...main` },
        ],
      });
      expect(errors).toEqual([`object ${ids.tree} is a tree, not a commit`]);
    });
  });

  describe('When revParse reads that symmetric range and a file bears its name', () => {
    it('Then it answers both sides, then the argument as a path', async () => {
      // Arrange
      const { ctx, ids } = await listRepo();
      await ctx.fs.writeUtf8(`${ctx.layout.workDir}/${ids.tree}...main`, '');
      const sut = revParse;

      // Act
      const result = await sut(ctx, `${ids.tree}...main`);

      // Assert
      expect(result).toEqual([
        ...entries(ids, [
          ['c2', false],
          ['tree', false],
        ]),
        { kind: 'path', path: `${ids.tree}...main` },
      ]);
    });
  });

  describe('When revParse reads the abbreviated id a blob shares with a commit', () => {
    it('Then it refuses the ambiguous name read with no commit-ish hint, printing it', async () => {
      // Arrange
      const { ctx } = await listRepo();
      const sut = revParse;

      // Act
      const result = await failureData(() => sut(ctx, C2_PREFIX));

      // Assert
      expect(result).toMatchObject({
        code: 'AMBIGUOUS_OID_PREFIX',
        prefix: C2_PREFIX,
        printed: [{ kind: 'path', path: C2_PREFIX }],
      });
    });
  });

  describe.each([`^${C2_PREFIX}`, `${C2_PREFIX}^{}..side`])(
    'When revParse reads %s, its ambiguous name read with no commit-ish hint',
    (arg) => {
      it('Then the whole argument names no revision and is printed as given', async () => {
        // Arrange
        const { ctx } = await listRepo();
        const sut = revParse;

        // Act
        const result = await failureData(() => sut(ctx, arg));

        // Assert
        expect(result).toMatchObject({
          code: 'REVPARSE_UNRESOLVED',
          printed: [{ kind: 'path', path: arg }],
        });
      });
    },
  );
});

describe('Given a merge of two branches over a root tagged t', () => {
  describe.each([
    {
      arg: 'x1^@',
      expected: [
        ['c2', false],
        ['s1', false],
      ],
    },
    {
      arg: 'x1^!',
      expected: [
        ['x1', false],
        ['c2', true],
        ['s1', true],
      ],
    },
    {
      arg: 'x1^-',
      expected: [
        ['x1', false],
        ['c2', true],
      ],
    },
    {
      arg: 'x1^-2',
      expected: [
        ['x1', false],
        ['s1', true],
      ],
    },
    { arg: 't^!', expected: [['t', false]] },
    { arg: 't^@', expected: [] },
    {
      arg: `${C2_PREFIX}^!`,
      expected: [
        ['c2', false],
        ['c1', true],
      ],
    },
  ] as const)('When revParse reads $arg', ({ arg, expected }) => {
    it("Then it answers git's parent shorthand in git's order", async () => {
      // Arrange
      const { ctx, ids } = await listRepo();
      const sut = revParse;

      // Act
      const result = await sut(ctx, arg);

      // Assert
      expect(result).toEqual(entries(ids, expected));
    });
  });

  describe.each([
    { arg: 'x1^@', expected: [] },
    { arg: 'x1^!', expected: [['x1', false]] },
  ] as const)('When revParse reads $arg with x1 a shallow boundary', ({ arg, expected }) => {
    it('Then it reads the parents the shallow graft leaves', async () => {
      // Arrange
      const { ctx, ids } = await listRepo();
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/shallow`, `${ids.x1}\n`);
      const sut = revParse;

      // Act
      const result = await sut(ctx, arg);

      // Assert
      expect(result).toEqual(entries(ids, expected));
    });
  });

  describe.each(['x1^-3', 't^-', 'nope^!'])('When revParse reads %s', (arg) => {
    it('Then it refuses the argument as one name', async () => {
      // Arrange
      const { ctx } = await listRepo();
      const sut = revParse;

      // Act
      const result = await failureData(() => sut(ctx, arg));

      // Assert
      expect(result).toMatchObject({ code: 'REVPARSE_UNRESOLVED' });
    });
  });

  describe('When revParse reads a parent shorthand of a tree', () => {
    it('Then it reports the tree and refuses the argument', async () => {
      // Arrange
      const { ctx, errors, ids } = await listRepo();
      const sut = revParse;

      // Act
      const result = await failureData(() => sut(ctx, `${ids.tree}^@`));

      // Assert
      expect(result).toMatchObject({ code: 'REVPARSE_UNRESOLVED' });
      expect(errors).toEqual([`object ${ids.tree} is a tree, not a commit`]);
    });
  });
});

const hexBytes = (hex: string): Uint8Array =>
  Uint8Array.from(hex.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));

const writeSharingTree = (ctx: Context): Promise<ObjectId> =>
  writeRawObjectBytes(
    ctx,
    'tree',
    Uint8Array.from([
      ...encoder.encode(`100644 ${C2_PREFIX_TREE_ENTRY}\0`),
      ...hexBytes(EMPTY_BLOB),
    ]),
  );

describe('Given a commit and a blob sharing an abbreviated id', () => {
  describe.each([
    { arg: `${C2_PREFIX}~0`, expected: 'c2' },
    { arg: `${C2_PREFIX}^0`, expected: 'c2' },
    { arg: `${C2_PREFIX}^{commit}`, expected: 'c2' },
    { arg: `${C2_PREFIX}^{/c2}`, expected: 'c2' },
    { arg: `${C2_PREFIX}^{tree}`, expected: 'tree' },
    { arg: `${C2_PREFIX}:`, expected: 'tree' },
  ])('When revParse reads $arg', ({ arg, expected }) => {
    it("Then the operation's own hint names the commit", async () => {
      // Arrange
      const { ctx, ids } = await listRepo();
      const sut = revParse;

      // Act
      const result = await sut(ctx, arg);

      // Assert
      expect(result).toEqual(entries(ids, [[expected, false]]));
    });
  });

  describe.each([`${C2_PREFIX}^{}`, `${C2_PREFIX}^{blob}`, `${C2_PREFIX}^{object}`])(
    'When revParse reads %s',
    (arg) => {
      it('Then the operation gives no hint and the name stays ambiguous', async () => {
        // Arrange
        const { ctx } = await listRepo();
        const sut = revParse;

        // Act
        const result = await failureData(() => sut(ctx, arg));

        // Assert
        expect(result).toMatchObject({ code: 'AMBIGUOUS_OID_PREFIX', prefix: C2_PREFIX });
      });
    },
  );
});

describe('Given a commit, a blob and a tree sharing an abbreviated id', () => {
  describe.each([
    { arg: `${C2_PREFIX}~0^{tree}`, expected: 'tree' },
    { arg: `${C2_PREFIX}^{commit}`, expected: 'c2' },
  ])('When revParse reads $arg', ({ arg, expected }) => {
    it('Then the commit-ish hint of the innermost operation names the commit', async () => {
      // Arrange
      const { ctx, ids } = await listRepo();
      await writeSharingTree(ctx);
      const sut = revParse;

      // Act
      const result = await sut(ctx, arg);

      // Assert
      expect(result).toEqual(entries(ids, [[expected, false]]));
    });
  });

  describe.each([`${C2_PREFIX}^{tree}`, `${C2_PREFIX}:`])('When revParse reads %s', (arg) => {
    it('Then the tree-ish hint keeps both the commit and the tree', async () => {
      // Arrange
      const { ctx } = await listRepo();
      await writeSharingTree(ctx);
      const sut = revParse;

      // Act
      const result = await failureData(() => sut(ctx, arg));

      // Assert
      expect(result).toMatchObject({ code: 'AMBIGUOUS_OID_PREFIX', prefix: C2_PREFIX });
    });
  });
});

describe('Given HEAD on main', () => {
  describe.each([
    { arg: '@', expected: [['c2', false]] },
    { arg: '^@', expected: [['c2', true]] },
    { arg: '@~1', expected: [['c1', false]] },
    { arg: '@^{tree}', expected: [['tree', false]] },
    {
      arg: '@..side',
      expected: [
        ['s1', false],
        ['c2', true],
      ],
    },
  ] as const)('When revParse reads $arg', ({ arg, expected }) => {
    it('Then it reads a lone @ as HEAD', async () => {
      // Arrange
      const { ctx, ids } = await listRepo();
      const sut = revParse;

      // Act
      const result = await sut(ctx, arg);

      // Assert
      expect(result).toEqual(entries(ids, expected));
    });
  });

  describe.each(['@@', 'main@'])('When revParse reads %s', (arg) => {
    it('Then it refuses an @ that is not alone', async () => {
      // Arrange
      const { ctx } = await listRepo();
      const sut = revParse;

      // Act
      const result = await failureData(() => sut(ctx, arg));

      // Assert
      expect(result).toMatchObject({ printed: [{ kind: 'path', path: arg }] });
    });
  });
});

describe('Given a worktree holding f at its root and g under sub', () => {
  const withFiles = async (cwd: string | undefined): Promise<Context> => {
    const { ctx } = await listRepo();
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/f`, '');
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/sub/g`, '');
    return cwd === undefined ? ctx : ({ ...ctx, cwd: `${ctx.layout.workDir}/${cwd}` } as Context);
  };

  describe.each([
    { cwd: undefined, arg: 'f' },
    { cwd: undefined, arg: 'no*' },
    { cwd: undefined, arg: ':(top)nothing' },
    { cwd: undefined, arg: ':/' },
    { cwd: undefined, arg: ':!f' },
    { cwd: undefined, arg: ':^f' },
    { cwd: undefined, arg: ':!' },
    { cwd: 'sub', arg: 'g' },
    { cwd: 'sub', arg: ':!g' },
    { cwd: 'sub', arg: ':/f' },
    { cwd: 'sub', arg: ':/sub/g' },
    { cwd: 'sub', arg: '' },
  ])('When revParse reads $arg from $cwd', ({ cwd, arg }) => {
    it('Then it answers the argument as the path git prints unchanged', async () => {
      // Arrange
      const ctx = await withFiles(cwd);
      const sut = revParse;

      // Act
      const result = await sut(ctx, arg);

      // Assert
      expect(result).toEqual([{ kind: 'path', path: arg }]);
    });
  });

  describe.each([
    { cwd: undefined, arg: 'nope', code: 'OBJECT_NOT_FOUND' },
    { cwd: undefined, arg: '', code: 'REVPARSE_UNRESOLVED' },
    { cwd: undefined, arg: ':/zzz', code: 'REVPARSE_UNRESOLVED' },
    { cwd: 'sub', arg: 'f', code: 'OBJECT_NOT_FOUND' },
    { cwd: 'sub', arg: ':!f', code: 'OBJECT_NOT_FOUND' },
  ])('When revParse reads $arg from $cwd', ({ cwd, arg, code }) => {
    it('Then it refuses, carrying the path line git printed first', async () => {
      // Arrange
      const ctx = await withFiles(cwd);
      const sut = revParse;

      // Act
      const result = await failureData(() => sut(ctx, arg));

      // Assert
      expect(result).toMatchObject({ code, printed: [{ kind: 'path', path: arg }] });
    });
  });
});

describe('Given a branch whose commit names a parent that fails to parse', () => {
  const MISSING = `cd${'0'.repeat(38)}` as ObjectId;

  describe('When revParse reads the symmetric range of main and that branch', () => {
    it('Then it logs the unread parent and refuses it with the two sides it printed', async () => {
      // Arrange
      const { ctx, errors, ids } = await listRepo();
      const broken = await writeCommit(ctx, ids.tree as ObjectId, [MISSING], 5, 'b\n');
      await writeRef(ctx, 'refs/heads/broken', broken);
      const sut = revParse;

      // Act
      const result = await failureData(() => sut(ctx, 'main...broken'));

      // Assert
      expect({ result, errors }).toEqual({
        result: {
          code: 'COMMIT_PARSE_FAILED',
          id: MISSING,
          printed: entries({ ...ids, broken }, [
            ['broken', false],
            ['c2', false],
          ]),
        },
        errors: [`Could not read ${MISSING}`],
      });
    });
  });

  describe('When revParse reads the symmetric range of main and a branch over a corrupt parent', () => {
    it('Then it refuses with the read failure, printing nothing', async () => {
      // Arrange
      const { ctx, ids } = await listRepo();
      await ctx.fs.write(
        `${ctx.layout.gitDir}/objects/cd/${MISSING.slice(2)}`,
        encoder.encode('x'),
      );
      const broken = await writeCommit(ctx, ids.tree as ObjectId, [MISSING], 5, 'b\n');
      await writeRef(ctx, 'refs/heads/broken', broken);
      const sut = revParse;

      // Act
      const result = await failureData(() => sut(ctx, 'main...broken'));

      // Assert
      expect(result).toEqual({
        code: 'DECOMPRESS_FAILED',
        reason: 'unexpected end of deflate stream',
      });
    });
  });
});

describe("Given a commit whose parent names the commit's own tree as its parent", () => {
  describe('When revParse reads two generations back from it', () => {
    it('Then the middle hop fails to parse against the tree its start typed, on each read of the name', async () => {
      // Arrange
      const errors: string[] = [];
      const ctx = {
        ...createMemoryContext(),
        logger: { error: (message: string) => errors.push(message) },
      } as Context;
      const tree = await writeRawObjectBytes(ctx, 'tree', new Uint8Array());
      const blob = await writeRawObjectBytes(ctx, 'blob', encoder.encode('b\n'));
      const otherTree = await writeRawObjectBytes(
        ctx,
        'tree',
        new Uint8Array([...encoder.encode('100644 b\0'), ...hexBytes(blob)]),
      );
      const parent = await writeCommit(ctx, otherTree, [tree], 1, 'p\n');
      const start = await writeCommit(ctx, tree, [parent], 2, 'x\n');
      await writeRef(ctx, 'refs/heads/main', start);
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
      const sut = revParse;

      // Act
      const result = await failureData(() => sut(ctx, `${start}~2`));

      // Assert
      const lines = [
        `object ${tree} is a tree, not a commit`,
        `bad parent ${tree} in commit ${parent}`,
      ];
      expect({ result, errors }).toEqual({
        result: {
          code: 'OBJECT_NOT_FOUND',
          id: parent,
          printed: [{ kind: 'path', path: `${start}~2` }],
        },
        errors: [...lines, ...lines],
      });
    });
  });
});
