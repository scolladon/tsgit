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
) => pairs.map(([name, negated]) => ({ id: ids[name], negated }));

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
      expect(result).toMatchObject({ code: 'OBJECT_NOT_FOUND' });
      expect(errors).toEqual([`object ${ids.tree} is a tree, not a commit`]);
    });
  });

  describe.each([C2_PREFIX, `^${C2_PREFIX}`, `${C2_PREFIX}^{}..side`])(
    'When revParse reads %s, the abbreviated id a blob shares with a commit',
    (arg) => {
      it('Then it refuses the ambiguous name read with no commit-ish hint', async () => {
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
