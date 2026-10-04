import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import {
  expandRevisionArgument,
  expandRevisionArguments,
} from '../../../../../src/application/commands/internal/revision-argument.js';
import { createObjectTypeTable } from '../../../../../src/application/primitives/internal/object-type-table.js';
import type { TsgitError } from '../../../../../src/domain/error.js';
import type { ObjectId } from '../../../../../src/domain/objects/index.js';
import type { Context } from '../../../../../src/ports/context.js';
import { seedRepo } from '../fixtures.js';

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

type Name = 'root' | 'side' | 'main' | 'merge';

interface History {
  readonly ctx: Context;
  readonly ids: Readonly<Record<Name, ObjectId>>;
}

const commitOn = async (
  ctx: Context,
  message: string,
  parents: ReadonlyArray<ObjectId>,
): Promise<ObjectId> => {
  const { commitIds } = await seedRepo(ctx, {
    commits: [{ tree: EMPTY_TREE, parents: [...parents], message }],
  });
  return commitIds[0] as ObjectId;
};

/** root ← side, root ← main, and merge (refs/heads/main) of main and side; `base` names root. */
const history = async (): Promise<History> => {
  const ctx = createMemoryContext();
  const root = await commitOn(ctx, 'root', []);
  const side = await commitOn(ctx, 'side', [root]);
  const main = await commitOn(ctx, 'main', [root]);
  const merge = await commitOn(ctx, 'merge', [main, side]);
  const refs = { 'refs/heads/main': merge, 'refs/heads/side': side, 'refs/heads/base': root };
  await seedRepo(ctx, { refs });
  return { ctx, ids: { root, side, main, merge } };
};

const spelt = (ids: History['ids'], tips: ReadonlyArray<string>) =>
  tips.map((name) => {
    const negated = name.startsWith('^');
    return { id: ids[(negated ? name.slice(1) : name) as Name], negated };
  });

describe('expandRevisionArgument', () => {
  describe('Given a merge of main and side over a root', () => {
    describe.each([
      { arg: 'side..main', source: 'command-line', tips: ['^side', 'merge'] },
      { arg: 'side...main', source: 'command-line', tips: ['^side', 'side', 'merge'] },
      { arg: '..', source: 'stdin', tips: ['^merge', 'merge'] },
      { arg: 'main^@', source: 'command-line', tips: ['main', 'side'] },
      { arg: 'main^!', source: 'command-line', tips: ['^main', '^side', 'merge'] },
      { arg: '^main^!', source: 'command-line', tips: ['main', 'side', '^merge'] },
      { arg: 'main^-', source: 'command-line', tips: ['^main', 'merge'] },
      { arg: 'main^-2', source: 'stdin', tips: ['^side', 'merge'] },
      { arg: 'base^!', source: 'command-line', tips: ['root'] },
      { arg: '^side', source: 'stdin', tips: ['^side'] },
      { arg: 'side', source: 'command-line', tips: ['side'] },
    ] as const)('When $arg is expanded from the $source', ({ arg, source, tips }) => {
      it("Then it yields git's tips in git's order", async () => {
        // Arrange
        const { ctx, ids } = await history();
        const sut = expandRevisionArgument;

        // Act
        const result = await sut(ctx, createObjectTypeTable(), arg, source);

        // Assert
        expect(result).toEqual(spelt(ids, tips));
      });
    });

    describe.each([
      { arg: 'nope..main', code: 'OBJECT_NOT_FOUND' },
      { arg: 'side..nope', code: 'OBJECT_NOT_FOUND' },
      { arg: 'nope^@', code: 'REVPARSE_UNRESOLVED' },
      { arg: 'main^@x', code: 'REVPARSE_UNRESOLVED' },
      { arg: 'main^!x', code: 'REVPARSE_UNRESOLVED' },
      { arg: 'main^-3', code: 'REVPARSE_UNRESOLVED' },
      { arg: 'base^-', code: 'REVPARSE_UNRESOLVED' },
      { arg: 'main^-0', code: 'REVPARSE_UNRESOLVED' },
      { arg: 'main^-x', code: 'REVPARSE_UNRESOLVED' },
      { arg: '..', code: 'OBJECT_NOT_FOUND' },
    ])('When $arg is expanded from the command line', ({ arg, code }) => {
      it('Then the whole argument is refused as one name', async () => {
        // Arrange
        const { ctx } = await history();
        const sut = expandRevisionArgument;

        // Act
        const result = await sut(ctx, createObjectTypeTable(), arg, 'command-line').catch(
          (error: TsgitError) => error.data.code,
        );

        // Assert
        expect(result).toBe(code);
      });
    });
  });
});

describe('expandRevisionArgument symmetric walk', () => {
  const MISSING = `cd${'0'.repeat(38)}` as ObjectId;

  describe.each(['command-line', 'stdin'] as const)(
    'Given a branch whose commit names a parent the store lacks, read from the %s',
    (source) => {
      describe('When main...broken walks to that parent', () => {
        it("Then it logs both of git's lines and refuses the whole argument as one name", async () => {
          // Arrange
          const { ctx: base } = await history();
          const logged: string[] = [];
          const ctx: Context = { ...base, logger: { error: (line: string) => logged.push(line) } };
          const broken = await commitOn(ctx, 'broken', [MISSING]);
          await seedRepo(ctx, { refs: { 'refs/heads/broken': broken } });
          const sut = expandRevisionArgument;

          // Act
          const result = await sut(ctx, createObjectTypeTable(), 'main...broken', source).catch(
            (error: TsgitError) => error.data,
          );

          // Assert
          expect({ result, logged }).toEqual({
            result: { code: 'OBJECT_NOT_FOUND', id: 'main...broken' },
            logged: [`Could not read ${MISSING}`, `could not parse commit ${MISSING}`],
          });
        });
      });
    },
  );
});

describe('expandRevisionArguments', () => {
  describe('Given a want and a range to exclude', () => {
    describe('When both are expanded', () => {
      it("Then the excluded range's tips are flipped", async () => {
        // Arrange
        const { ctx, ids } = await history();
        const sut = expandRevisionArguments;

        // Act
        const result = await sut(
          ctx,
          createObjectTypeTable(),
          { wants: ['base'], not: ['side..main'] },
          'stdin',
        );

        // Assert
        expect(result).toEqual({
          wants: [ids.root, ids.side],
          not: [ids.merge],
          tips: [
            { id: ids.root, excluded: false },
            { id: ids.side, excluded: false },
            { id: ids.merge, excluded: true },
          ],
        });
      });
    });
  });
});
