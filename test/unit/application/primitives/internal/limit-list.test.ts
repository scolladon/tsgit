import { describe, expect, it } from 'vitest';
import { createCommit } from '../../../../../src/application/primitives/create-commit.js';
import {
  type LimitListOptions,
  limitList,
  resolveLimitOptions,
  walkLimited,
} from '../../../../../src/application/primitives/internal/limit-list.js';
import { readCommit } from '../../../../../src/application/primitives/internal/read-commit.js';
import { writeObject } from '../../../../../src/application/primitives/write-object.js';
import type { AuthorIdentity, ObjectId, Tree } from '../../../../../src/domain/objects/index.js';
import { computeLooseObjectPath } from '../../../../../src/domain/storage/loose-path.js';
import type { Context } from '../../../../../src/ports/context.js';
import { buildSeededContext, writeCommitGraph } from '../fixtures.js';

const EPOCH = 1_700_000_000;
const AUTHOR: AuthorIdentity = {
  name: 'Alice',
  email: 'a@a.com',
  timestamp: EPOCH,
  timezoneOffset: '+0000',
};

/** `[name, committer-date offset, parent names]`, parents declared first. */
type Spec = ReadonlyArray<readonly [string, number, ReadonlyArray<string>]>;

interface History {
  readonly ctx: Context;
  readonly id: (name: string) => ObjectId;
  readonly name: (id: ObjectId) => string;
}

const buildHistory = async (spec: Spec): Promise<History> => {
  const ctx = await buildSeededContext();
  const empty: Tree = { type: 'tree', entries: [], id: '' as ObjectId };
  const tree = await writeObject(ctx, empty);
  const ids = new Map<string, ObjectId>();
  const id = (name: string): ObjectId => ids.get(name) as ObjectId;
  for (const [name, offset, parents] of spec) {
    const when = { ...AUTHOR, timestamp: EPOCH + offset };
    const commit = await createCommit(ctx, {
      tree,
      parents: parents.map(id),
      author: when,
      committer: when,
      message: name,
    });
    ids.set(name, commit);
  }
  const names = new Map([...ids].map(([key, value]) => [value, key]));
  return { ctx, id, name: (oid) => names.get(oid) as string };
};

const READ = { verifyHash: false, ignoreMissing: false, missing: new Set<string>() };

const graphOver = async (history: History, names: ReadonlyArray<string>): Promise<void> => {
  const shallow = new Set<ObjectId>();
  const commits = await Promise.all(
    names.map(
      async (name) => (await readCommit(history.ctx, history.id(name), { ...READ, shallow }))!,
    ),
  );
  await writeCommitGraph(history.ctx, [commits]);
};

const dropObject = async (history: History, name: string): Promise<void> => {
  const id = history.id(name);
  history.ctx.deltaCache.delete(id);
  await history.ctx.fs.rm(`${history.ctx.layout.gitDir}/objects/${computeLooseObjectPath(id)}`);
};

const optionsFor = (
  history: History,
  from: ReadonlyArray<string>,
  until: ReadonlyArray<string>,
  overrides: Partial<LimitListOptions> = {},
): LimitListOptions => ({
  seeds: [...from, ...until].map(history.id),
  until: new Set(until.map(history.id)),
  firstParent: false,
  ignoreMissing: false,
  verifyHash: false,
  shallow: new Set<ObjectId>(),
  settle: 'slop',
  ...overrides,
});

const shownNames = async (history: History, options: LimitListOptions): Promise<string[]> =>
  (await limitList(history.ctx, options)).shown.map(history.name);

// r ← a1 ← a2, r ← b1 ← b2 (b2 dated before b1), m = merge(a2, b2),
// a1 ← c1, n = merge(m, c1), m2 = merge(b2, a1)
const SKEWED: Spec = [
  ['r', 100, []],
  ['a1', 200, ['r']],
  ['a2', 400, ['a1']],
  ['b1', 300, ['r']],
  ['b2', 150, ['b1']],
  ['m', 500, ['a2', 'b2']],
  ['c1', 450, ['a1']],
  ['n', 600, ['m', 'c1']],
  ['m2', 350, ['b2', 'a1']],
];

// c, d and h share a date. g ← s ← c; g ← k6 … k1 ← p ← h; p ← n ← m ← d,
// p's whole line dated before g.
const TIED_SEEDS: Spec = [
  ['g', 98, []],
  ['k6', 90, ['g']],
  ['k5', 90, ['k6']],
  ['k4', 90, ['k5']],
  ['k3', 90, ['k4']],
  ['k2', 90, ['k3']],
  ['k1', 90, ['k2']],
  ['p', 90, ['k1']],
  ['n', 90, ['p']],
  ['m', 90, ['n']],
  ['d', 100, ['m']],
  ['s', 99, ['g']],
  ['h', 100, ['p']],
  ['c', 100, ['s']],
];

// i ← x, and e reaches x through `length` commits all dated before x.
const olderChain = (length: number): Spec => {
  const chain: Array<readonly [string, number, ReadonlyArray<string>]> = [];
  let tip = 'x';
  for (let step = 1; step <= length; step += 1) {
    chain.push([`e${step}`, 300 - step, [tip]]);
    tip = `e${step}`;
  }
  return [['x', 500, []], ['i', 1000, ['x']], ...chain, ['e', 400, [tip]]];
};

describe('limitList', () => {
  describe('Given a skewed history whose excluded commit shares an ancestor with the tip', () => {
    describe('When n is limited excluding b1', () => {
      it('Then the shared root is excluded although a1 reaches it', async () => {
        // Arrange
        const history = await buildHistory(SKEWED);

        // Act
        const result = await shownNames(history, optionsFor(history, ['n'], ['b1']));

        // Assert
        expect(result).toEqual(['n', 'm', 'c1', 'a2', 'a1', 'b2']);
      });
    });

    describe('When n is limited excluding a1 and b1', () => {
      it('Then both excluded lines and their ancestors are left out', async () => {
        // Arrange
        const history = await buildHistory(SKEWED);

        // Act
        const result = await shownNames(history, optionsFor(history, ['n'], ['a1', 'b1']));

        // Assert
        expect(result).toEqual(['n', 'm', 'c1', 'a2', 'b2']);
      });
    });

    describe('When n is limited first-parent excluding m2', () => {
      it('Then every parent of the excluded merge is excluded, not only its first', async () => {
        // Arrange
        const history = await buildHistory(SKEWED);

        // Act
        const result = await shownNames(
          history,
          optionsFor(history, ['n'], ['m2'], { firstParent: true }),
        );

        // Assert
        expect(result).toEqual(['n', 'm', 'a2']);
      });
    });

    describe('When the tip is also excluded', () => {
      it('Then nothing is shown', async () => {
        // Arrange
        const history = await buildHistory(SKEWED);

        // Act
        const result = await shownNames(history, optionsFor(history, ['n'], ['n']));

        // Assert
        expect(result).toEqual([]);
      });
    });

    describe('When the walk reports its uninteresting set', () => {
      it('Then it holds the excluded commit and the ancestors the walk reached', async () => {
        // Arrange
        const history = await buildHistory(SKEWED);

        // Act
        const result = await limitList(history.ctx, optionsFor(history, ['n'], ['b1']));

        // Assert
        expect([...result.uninteresting].map(history.name).sort()).toEqual(['b1', 'r']);
      });
    });
  });

  describe('Given a tip reached from an excluded commit only through commits dated before it', () => {
    describe.each([
      { length: 3, settle: 'slop', expected: ['i'] },
      { length: 6, settle: 'slop', expected: ['i', 'x'] },
      { length: 6, settle: 'generation', expected: ['i'] },
    ] as const)(
      'When the chain has $length commits and the walk settles by $settle',
      ({ length, settle, expected }) => {
        it('Then the shown commits match git', async () => {
          // Arrange
          const history = await buildHistory(olderChain(length));

          // Act
          const result = await shownNames(history, optionsFor(history, ['i'], ['e'], { settle }));

          // Assert
          expect(result).toEqual(expected);
        });
      },
    );

    describe('When the excluded line first meets a commit dated like the last shown one', () => {
      it('Then that commit does not count against the slop', async () => {
        // Arrange
        const chain = olderChain(6).map(([name, offset, parents]) =>
          name === 'e6' ? ([name, 500, parents] as const) : ([name, offset, parents] as const),
        );
        const history = await buildHistory(chain);

        // Act
        const result = await shownNames(history, optionsFor(history, ['i'], ['e']));

        // Assert
        expect(result).toEqual(['i']);
      });
    });

    describe('When the commits sit in a commit-graph and the walk settles by generation', () => {
      it('Then it walks the excluded line until it is older than every shown commit', async () => {
        // Arrange
        const history = await buildHistory(olderChain(6));
        await graphOver(history, ['x', 'i', 'e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e']);

        // Act
        const result = await shownNames(
          history,
          optionsFor(history, ['i'], ['e'], { settle: 'generation' }),
        );

        // Assert
        expect(result).toEqual(['i']);
      });
    });

    describe('When the graph covers the history but the walk settles by slop', () => {
      it('Then it gives up after five uninteresting commits as git does', async () => {
        // Arrange
        const history = await buildHistory(olderChain(6));
        await graphOver(history, ['x', 'i', 'e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e']);

        // Act
        const result = await shownNames(history, optionsFor(history, ['i'], ['e']));

        // Assert
        expect(result).toEqual(['i', 'x']);
      });
    });
  });

  describe('Given an interesting commit cached while queued that is shown before the slop runs out', () => {
    describe('When the excluded line reaches x after five more uninteresting commits', () => {
      it('Then the cache is dropped with the pop and the walk gives up before x', async () => {
        // Arrange
        const history = await buildHistory([
          ['x', 500, []],
          ['i', 1000, ['x']],
          ['k', 450, []],
          ['j', 460, ['k']],
          ...olderChain(7).slice(2, 9),
          ['f', 475, ['e7']],
          ['e', 480, ['f']],
        ]);

        // Act
        const result = await shownNames(history, optionsFor(history, ['i', 'j'], ['e']));

        // Assert
        expect(result).toEqual(['i', 'x', 'j', 'k']);
      });
    });
  });

  describe('Given an interesting commit cached while queued that the excluded line then reaches', () => {
    describe('When five more uninteresting commits follow before x', () => {
      it('Then the stale cache is scanned again and the walk gives up before x', async () => {
        // Arrange
        const history = await buildHistory([
          ['x', 500, []],
          ['i', 1000, ['x']],
          ['g4', 10, ['x']],
          ['g3', 20, ['g4']],
          ['g2', 30, ['g3']],
          ['g1', 40, ['g2']],
          ['j', 460, ['g1']],
          ['f', 470, ['j']],
          ['h', 475, ['f']],
          ['e', 480, ['h']],
        ]);

        // Act
        const result = await shownNames(history, optionsFor(history, ['i', 'j'], ['e']));

        // Assert
        expect(result).toEqual(['i', 'x']);
      });
    });
  });

  describe('Given an excluded commit whose parent object is missing', () => {
    describe('When the walk marks it uninteresting', () => {
      it('Then the missing parent is skipped as git parses it gently', async () => {
        // Arrange
        const history = await buildHistory([
          ['r', 100, []],
          ['gone', 150, ['r']],
          ['e', 200, ['gone']],
          ['t', 300, ['r']],
        ]);
        await dropObject(history, 'gone');

        // Act
        const result = await shownNames(history, optionsFor(history, ['t'], ['e']));

        // Assert
        expect(result).toEqual(['t', 'r']);
      });
    });
  });

  describe('Given an interesting commit whose parent object is missing', () => {
    describe('When the walk is strict', () => {
      it('Then it refuses on the missing parent', async () => {
        // Arrange
        const history = await buildHistory([
          ['gone', 100, []],
          ['t', 300, ['gone']],
          ['e', 200, []],
        ]);
        await dropObject(history, 'gone');

        // Act
        let caught: unknown;
        try {
          await limitList(history.ctx, optionsFor(history, ['t'], ['e']));
        } catch (error) {
          caught = error;
        }

        // Assert
        expect(caught).toMatchObject({
          data: { code: 'OBJECT_NOT_FOUND', id: history.id('gone') },
        });
      });
    });

    describe('When the walk ignores missing objects', () => {
      it('Then the missing parent is left out', async () => {
        // Arrange
        const history = await buildHistory([
          ['gone', 100, []],
          ['t', 300, ['gone']],
          ['e', 200, []],
        ]);
        await dropObject(history, 'gone');

        // Act
        const result = await shownNames(
          history,
          optionsFor(history, ['t'], ['e'], { ignoreMissing: true }),
        );

        // Assert
        expect(result).toEqual(['t']);
      });
    });
  });

  describe('Given a named commit whose object is missing', () => {
    describe('When the walk ignores missing objects', () => {
      it('Then the missing commit is left out of the walk', async () => {
        // Arrange
        const history = await buildHistory(SKEWED);
        await dropObject(history, 'c1');

        // Act
        const result = await shownNames(
          history,
          optionsFor(history, ['c1', 'm'], ['b1'], { ignoreMissing: true }),
        );

        // Assert
        expect(result).toEqual(['m', 'a2', 'a1', 'b2']);
      });
    });
  });

  describe('Given a shallow boundary on the shown line', () => {
    describe('When the walk reaches it', () => {
      it('Then the boundary is shown but its parents are not walked', async () => {
        // Arrange
        const history = await buildHistory(SKEWED);
        await graphOver(history, ['r', 'a1', 'a2', 'b1', 'b2', 'm', 'c1', 'n', 'm2']);
        const shallow = new Set([history.id('m')]);

        // Act
        const result = await shownNames(history, optionsFor(history, ['n'], ['b1'], { shallow }));

        // Assert
        expect(result).toEqual(['n', 'm', 'c1', 'a1']);
      });
    });
  });

  describe('Given a signal aborted once the named commits are queued', () => {
    describe('When the walk drains its queue', () => {
      it('Then it refuses as an aborted operation', async () => {
        // Arrange
        const history = await buildHistory(SKEWED);
        await graphOver(history, ['r', 'a1', 'a2', 'b1', 'b2', 'm', 'c1', 'n', 'm2']);
        const controller = new AbortController();
        const ctx = { ...history.ctx, signal: controller.signal };
        const pending = limitList(ctx, optionsFor(history, ['n'], ['b1']));
        controller.abort();

        // Act
        let caught: unknown;
        try {
          await pending;
        } catch (error) {
          caught = error;
        }

        // Assert
        expect(caught).toMatchObject({ data: { code: 'OPERATION_ABORTED' } });
      });
    });
  });

  describe('Given an aborted signal', () => {
    describe('When the walk starts', () => {
      it('Then it refuses as an aborted operation', async () => {
        // Arrange
        const history = await buildHistory(SKEWED);
        const controller = new AbortController();
        controller.abort();
        const ctx = { ...history.ctx, signal: controller.signal };

        // Act
        let caught: unknown;
        try {
          await limitList(ctx, optionsFor(history, ['n'], ['b1']));
        } catch (error) {
          caught = error;
        }

        // Assert
        expect(caught).toMatchObject({ data: { code: 'OPERATION_ABORTED' } });
      });
    });
  });
});

describe('walkLimited', () => {
  describe('Given a skewed history whose commits partly sit in a commit-graph', () => {
    describe('When n is walked excluding b1', () => {
      it('Then every shown commit body is yielded in the limited order', async () => {
        // Arrange
        const history = await buildHistory(SKEWED);
        await graphOver(history, ['r', 'a1', 'a2', 'b1', 'b2', 'm']);
        const sut = walkLimited;

        // Act
        const result: string[] = [];
        for await (const commit of sut(history.ctx, optionsFor(history, ['n'], ['b1']))) {
          result.push(commit.data.message);
        }

        // Assert
        expect(result).toEqual(['n', 'm', 'c1', 'a2', 'a1', 'b2']);
      });
    });
  });

  describe('Given a signal aborted after the first shown commit', () => {
    describe('When the walk is resumed', () => {
      it('Then it refuses as an aborted operation', async () => {
        // Arrange
        const history = await buildHistory(SKEWED);
        const controller = new AbortController();
        const ctx = { ...history.ctx, signal: controller.signal };
        const sut = walkLimited;
        const walk = sut(ctx, optionsFor(history, ['n'], ['b1']));
        await walk.next();
        controller.abort();

        // Act
        let caught: unknown;
        try {
          await walk.next();
        } catch (error) {
          caught = error;
        }

        // Assert
        expect(caught).toMatchObject({ data: { code: 'OPERATION_ABORTED' } });
      });
    });
  });

  describe('Given a shown commit whose object vanished after the graph was written', () => {
    describe('When the walk ignores missing objects', () => {
      it('Then the vanished commit is skipped', async () => {
        // Arrange
        const history = await buildHistory(SKEWED);
        await graphOver(history, ['r', 'a1', 'a2', 'b1', 'b2', 'm', 'c1', 'n', 'm2']);
        await dropObject(history, 'a2');
        const sut = walkLimited;
        const options = optionsFor(history, ['n'], ['b1'], { ignoreMissing: true });

        // Act
        const result: string[] = [];
        for await (const commit of sut(history.ctx, options)) result.push(commit.data.message);

        // Assert
        expect(result).toEqual(['n', 'm', 'c1', 'a1', 'b2']);
      });
    });
  });

  describe('Given commits listed before the excluded side reaches them through a later-dated commit', () => {
    describe('When the walk reports what it dropped', () => {
      it('Then it holds those commits in list order, and the shown list leaves them out', async () => {
        // Arrange — o ← d ← w; e reaches d only through s, dated after d and o
        const history = await buildHistory([
          ['o', 700, []],
          ['d', 800, ['o']],
          ['w', 1000, ['d']],
          ['s', 900, ['d']],
          ['e', 500, ['s']],
        ]);

        // Act
        const result = await limitList(history.ctx, optionsFor(history, ['w'], ['e']));

        // Assert
        expect(result.dropped.map(history.name)).toEqual(['d', 'o']);
        expect(result.shown.map(history.name)).toEqual(['w']);
      });
    });
  });

  describe.each([
    { order: ['c', 'd', 'h'], expected: ['c', 'h', 's', 'g'] },
    { order: ['c', 'h', 'd'], expected: ['c', 'h', 's'] },
  ])('Given seeds sharing a commit date queued as $order', ({ order, expected }) => {
    describe('When the walk excludes d', () => {
      it('Then the seed order decides what d has marked when its line gives up', async () => {
        // Arrange
        const history = await buildHistory(TIED_SEEDS);
        const options = optionsFor(history, ['c', 'h'], ['d'], { seeds: order.map(history.id) });

        // Act
        const result = await shownNames(history, options);

        // Assert
        expect(result).toEqual(expected);
      });
    });
  });
});

describe('resolveLimitOptions', () => {
  describe('Given included and excluded commits and no seed order', () => {
    describe('When the options are resolved', () => {
      it('Then the included commits seed the walk before the excluded ones', async () => {
        // Arrange
        const history = await buildHistory(TIED_SEEDS);
        const sut = resolveLimitOptions;
        const until = new Set([history.id('d')]);

        // Act
        const result = await sut(
          history.ctx,
          { from: [history.id('c'), history.id('h')], shallow: new Set() },
          { until, firstParent: false, settle: 'slop' },
        );

        // Assert
        expect(result.seeds.map(history.name)).toEqual(['c', 'h', 'd']);
      });
    });
  });

  describe('Given an explicit seed order', () => {
    describe('When the options are resolved', () => {
      it('Then that order is kept', async () => {
        // Arrange
        const history = await buildHistory(TIED_SEEDS);
        const sut = resolveLimitOptions;
        const seeds = [history.id('d'), history.id('h')];

        // Act
        const result = await sut(
          history.ctx,
          { from: [history.id('h')], shallow: new Set() },
          { seeds, until: new Set([history.id('d')]), firstParent: false, settle: 'slop' },
        );

        // Assert
        expect(result.seeds.map(history.name)).toEqual(['d', 'h']);
      });
    });
  });
});
