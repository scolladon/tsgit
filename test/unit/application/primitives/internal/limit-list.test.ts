import { describe, expect, it, vi } from 'vitest';
import { createCommit } from '../../../../../src/application/primitives/create-commit.js';
import {
  type LimitListOptions,
  limitList,
  resolveLimitOptions,
  walkLimited,
} from '../../../../../src/application/primitives/internal/limit-list.js';
import { createObjectTypeTable } from '../../../../../src/application/primitives/internal/object-type-table.js';
import { readCommit } from '../../../../../src/application/primitives/internal/read-commit.js';
import * as shallowSetModule from '../../../../../src/application/primitives/internal/shallow-set.js';
import { writeObject } from '../../../../../src/application/primitives/write-object.js';
import type { AuthorIdentity, ObjectId, Tree } from '../../../../../src/domain/objects/index.js';
import { computeLooseObjectPath } from '../../../../../src/domain/storage/loose-path.js';
import type { Context } from '../../../../../src/ports/context.js';
import type { Logger } from '../../../../../src/ports/logger.js';
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

  describe('Given a double-skewed history whose excluded line reaches the shown line late', () => {
    // K ← Y ← A, Y dated before K; Y ← W640 … W700 ← V ← X, V dated before the W line.
    const DOUBLE_SKEW: Spec = [
      ['K', 950, []],
      ['Y', 500, ['K']],
      ['A', 1000, ['Y']],
      ['W640', 640, ['Y']],
      ['W650', 650, ['W640']],
      ['W660', 660, ['W650']],
      ['W670', 670, ['W660']],
      ['W680', 680, ['W670']],
      ['W690', 690, ['W680']],
      ['W700', 700, ['W690']],
      ['V', 100, ['W700']],
      ['X', 2000, ['V']],
    ];

    describe.each([
      { before: 900, expected: [] },
      { before: 950, expected: ['Y', 'K'] },
      { before: 1000, expected: ['A', 'Y', 'K'] },
    ])('When A is limited excluding X, commits after $before left out', ({ before, expected }) => {
      it('Then a left-out commit never moves the date the excluded line is weighed against', async () => {
        // Arrange
        const history = await buildHistory(DOUBLE_SKEW);
        const options = optionsFor(history, ['A'], ['X'], { minAge: EPOCH + before });
        const sut = limitList;

        // Act
        const result = await sut(history.ctx, options);

        // Assert
        expect(result.shown.map(history.name)).toEqual(expected);
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

describe('limitList body retention', () => {
  const CHAIN: Spec = [
    ['c0', 0, []],
    ['c1', 10, ['c0']],
    ['c2', 20, ['c1']],
  ];

  describe('Given a chain walked for its heads only', () => {
    describe('When it is limited', () => {
      it('Then every commit is shown and no body is retained', async () => {
        // Arrange
        const history = await buildHistory(CHAIN);
        const sut = limitList;

        // Act
        const result = await sut(
          history.ctx,
          optionsFor(history, ['c2'], [], { bodyRetention: 'none' }),
        );

        // Assert
        expect(result.shown.map(history.name)).toEqual(['c2', 'c1', 'c0']);
        expect(result.bodies.size).toBe(0);
      });
    });
  });

  describe('Given a chain typed and walked for its heads only', () => {
    describe('When it is limited', () => {
      it('Then only the untyped seed keeps its body', async () => {
        // Arrange
        const history = await buildHistory(CHAIN);
        const objectTypes = createObjectTypeTable();
        const sut = limitList;

        // Act
        const result = await sut(
          history.ctx,
          optionsFor(history, ['c2'], [], { bodyRetention: 'none', objectTypes }),
        );

        // Assert
        expect(result.shown.map(history.name)).toEqual(['c2', 'c1', 'c0']);
        expect([...result.bodies.keys()].map(history.name)).toEqual(['c2']);
        expect(objectTypes.get(history.id('c0'))).toBe('commit');
      });
    });
  });

  describe('Given a chain walked for its shown bodies', () => {
    describe('When it is limited', () => {
      it('Then every shown body is retained', async () => {
        // Arrange
        const history = await buildHistory(CHAIN);
        const sut = limitList;

        // Act
        const result = await sut(history.ctx, optionsFor(history, ['c2'], []));

        // Assert
        expect([...result.bodies.keys()].map(history.name).sort()).toEqual(['c0', 'c1', 'c2']);
      });
    });
  });
});

describe('limitList seeding', () => {
  describe('Given an included commit whose parent is excluded and older than it', () => {
    describe('When the walk is limited', () => {
      it('Then the shared parent is never taken into the list', async () => {
        // Arrange
        const history = await buildHistory([
          ['p', 500, []],
          ['t', 1000, ['p']],
          ['e', 400, ['p']],
        ]);
        const sut = limitList;

        // Act
        const result = await sut(history.ctx, optionsFor(history, ['t'], ['e']));

        // Assert
        expect(result.shown.map(history.name)).toEqual(['t']);
        expect(result.dropped).toEqual([]);
      });
    });
  });

  describe('Given two named commits where the second is the first one’s parent', () => {
    describe('When the walk is limited', () => {
      it('Then the parent is listed once', async () => {
        // Arrange
        const history = await buildHistory([
          ['p', 500, []],
          ['t', 1000, ['p']],
        ]);
        const sut = limitList;

        // Act
        const result = await sut(history.ctx, optionsFor(history, ['t', 'p'], []));

        // Assert
        expect(result.shown.map(history.name)).toEqual(['t', 'p']);
      });
    });
  });

  describe('Given an excluded commit parsed from its object', () => {
    describe('When the walk is limited', () => {
      it('Then its body is not handed over', async () => {
        // Arrange
        const history = await buildHistory([
          ['t', 300, []],
          ['e', 200, []],
        ]);
        const sut = limitList;

        // Act
        const result = await sut(history.ctx, optionsFor(history, ['t'], ['e']));

        // Assert
        expect([...result.bodies.keys()].map(history.name)).toEqual(['t']);
      });
    });
  });
});

describe('limitList cached interest', () => {
  describe('Given an interesting commit queued behind a long excluded line', () => {
    describe('When the excluded line outlasts the slop before reaching it', () => {
      it('Then the queued interesting commit keeps the walk going and is shown', async () => {
        // Arrange
        const line: Spec = [
          ['f8', 820, []],
          ['f7', 830, ['f8']],
          ['f6', 840, ['f7']],
          ['f5', 850, ['f6']],
          ['f4', 860, ['f5']],
          ['f3', 870, ['f4']],
          ['f2', 880, ['f3']],
          ['f1', 890, ['f2']],
        ];
        const history = await buildHistory([
          ['x', 500, []],
          ['i', 1000, ['x']],
          ...line,
          ['e', 900, ['f1']],
        ]);

        // Act
        const result = await shownNames(history, optionsFor(history, ['i'], ['e']));

        // Assert
        expect(result).toEqual(['i', 'x']);
      });
    });
  });
});

describe('limitList settling by generation', () => {
  describe('Given an included commit built on the tip of a long excluded line', () => {
    describe('When the walk settles by generation', () => {
      it('Then it stops once the queued excluded commits are older than the shown one', async () => {
        // Arrange
        const chain: Spec = [
          ['r0', 100, []],
          ['r1', 110, ['r0']],
          ['r2', 120, ['r1']],
          ['r3', 130, ['r2']],
          ['r4', 140, ['r3']],
          ['r5', 150, ['r4']],
        ];
        const history = await buildHistory([...chain, ['i', 1000, ['r5']]]);
        await graphOver(history, ['r0', 'r1', 'r2', 'r3', 'r4', 'r5', 'i']);
        const options = optionsFor(history, ['i'], ['r5'], { settle: 'generation' });
        const sut = limitList;

        // Act
        const result = await sut(history.ctx, options);

        // Assert
        expect([...result.uninteresting].map(history.name).sort()).toEqual(['r3', 'r4', 'r5']);
      });
    });
  });

  describe('Given queued excluded commits of which only some are older than the shown one', () => {
    describe('When the walk settles by generation', () => {
      it('Then it keeps walking until every queued one is older', async () => {
        // Arrange
        const history = await buildHistory([
          ['z', 100, []],
          ['s', 1030, ['z']],
          ['q', 1040, ['s']],
          ['p', 1050, ['q']],
          ['x0', 800, []],
          ['c', 900, ['p']],
          ['i', 1000, []],
        ]);
        await graphOver(history, ['z', 's', 'q', 'p', 'x0', 'c', 'i']);
        const options = optionsFor(history, ['i'], ['c', 'x0'], { settle: 'generation' });
        const sut = limitList;

        // Act
        const result = await sut(history.ctx, options);

        // Assert
        expect([...result.uninteresting].map(history.name).sort()).toEqual([
          'c',
          'p',
          'q',
          's',
          'x0',
          'z',
        ]);
      });
    });
  });
});

describe('limitList typed bodies', () => {
  const CHAIN: Spec = [
    ['c0', 0, []],
    ['c1', 10, ['c0']],
    ['c2', 20, ['c1']],
  ];

  describe('Given a typed chain walked for its shown bodies', () => {
    describe('When it is limited', () => {
      it('Then every shown body is retained after its pointers are typed', async () => {
        // Arrange
        const history = await buildHistory(CHAIN);
        const objectTypes = createObjectTypeTable();
        const sut = limitList;

        // Act
        const result = await sut(history.ctx, optionsFor(history, ['c2'], [], { objectTypes }));

        // Assert
        expect([...result.bodies.keys()].map(history.name).sort()).toEqual(['c0', 'c1', 'c2']);
      });
    });
  });
});

describe('resolveLimitOptions defaults', () => {
  describe('Given a walk that sets neither ignoreMissing nor verifyHash', () => {
    describe('When the options are resolved', () => {
      it('Then both default to off', async () => {
        // Arrange
        const history = await buildHistory(TIED_SEEDS);
        const sut = resolveLimitOptions;

        // Act
        const result = await sut(
          history.ctx,
          { from: [history.id('c')], shallow: new Set() },
          { until: new Set(), firstParent: false, settle: 'slop' },
        );

        // Assert
        expect(result.ignoreMissing).toBe(false);
        expect(result.verifyHash).toBe(false);
      });
    });
  });
});

describe('limitList parent diagnostics', () => {
  const loggedHistory = async (): Promise<{
    readonly history: History;
    readonly error: ReturnType<typeof vi.fn>;
    readonly ctx: Context;
  }> => {
    const history = await buildHistory([['t', 300, []]]);
    const error = vi.fn();
    const logger: Logger = { error };
    return { history, error, ctx: { ...history.ctx, logger } };
  };

  describe('Given a typed walk over a commit whose parent object is missing', () => {
    describe('When the walk refuses', () => {
      it('Then it logs the unreadable parent with its id', async () => {
        // Arrange
        const history = await buildHistory([
          ['gone', 100, []],
          ['t', 300, ['gone']],
        ]);
        await dropObject(history, 'gone');
        const error = vi.fn();
        const ctx = { ...history.ctx, logger: { error } as Logger };
        const objectTypes = createObjectTypeTable();
        const sut = limitList;

        // Act
        let caught: unknown;
        try {
          await sut(ctx, optionsFor(history, ['t'], [], { objectTypes }));
        } catch (thrown) {
          caught = thrown;
        }

        // Assert
        expect(caught).toMatchObject({
          data: { code: 'REVISION_WALK_FAILED', commit: history.id('t') },
        });
        expect(error).toHaveBeenCalledWith(`Could not read ${history.id('gone')}`, {
          id: history.id('gone'),
        });
      });
    });
  });

  describe('Given a typed walk over a commit whose parent is not a commit', () => {
    describe('When the walk refuses', () => {
      it('Then it logs the object that is not a commit with its id', async () => {
        // Arrange
        const { history, error, ctx } = await loggedHistory();
        const blob = await writeObject(ctx, {
          type: 'blob',
          content: new Uint8Array([1]),
          id: '' as ObjectId,
        });
        const tree = await writeObject(ctx, { type: 'tree', entries: [], id: '' as ObjectId });
        const tip = await createCommit(ctx, {
          tree,
          parents: [blob],
          author: AUTHOR,
          committer: AUTHOR,
          message: 'tip',
        });
        const objectTypes = createObjectTypeTable();
        const sut = limitList;

        // Act
        let caught: unknown;
        try {
          await sut(ctx, { ...optionsFor(history, [], []), seeds: [tip], objectTypes });
        } catch (thrown) {
          caught = thrown;
        }

        // Assert
        expect(caught).toMatchObject({ data: { code: 'REVISION_WALK_FAILED', commit: tip } });
        expect(error).toHaveBeenCalledWith(`Object ${blob} not a commit`, { id: blob });
      });
    });
  });

  describe('Given an untyped walk over a commit whose parent is not a commit', () => {
    describe('When the walk is limited', () => {
      it('Then the parent is skipped without a diagnostic', async () => {
        // Arrange
        const { history, error, ctx } = await loggedHistory();
        const blob = await writeObject(ctx, {
          type: 'blob',
          content: new Uint8Array([1]),
          id: '' as ObjectId,
        });
        const tree = await writeObject(ctx, { type: 'tree', entries: [], id: '' as ObjectId });
        const tip = await createCommit(ctx, {
          tree,
          parents: [blob],
          author: AUTHOR,
          committer: AUTHOR,
          message: 'tip',
        });
        const sut = limitList;

        // Act
        const result = await sut(ctx, { ...optionsFor(history, [], []), seeds: [tip] });

        // Assert
        expect(result.shown).toEqual([tip]);
        expect(error).not.toHaveBeenCalled();
      });
    });
  });
});

/** `ctx` whose object reads are counted per id — every read consults the delta cache once. */
const countingReads = (ctx: Context): { ctx: Context; reads: Map<ObjectId, number> } => {
  const reads = new Map<ObjectId, number>();
  const deltaCache = new Proxy(ctx.deltaCache, {
    get: (target, key, receiver) => {
      const value = Reflect.get(target, key, receiver);
      if (key !== 'get' || typeof value !== 'function') return value;
      return (id: ObjectId, ...rest: unknown[]) => {
        reads.set(id, (reads.get(id) ?? 0) + 1);
        return value.call(target, id, ...rest);
      };
    },
  });
  return { ctx: { ...ctx, deltaCache }, reads };
};

const linear = (length: number): Spec =>
  Array.from({ length }, (_, at) => [`k${at}`, 100 + at, at === 0 ? [] : [`k${at - 1}`]] as const);

describe('walkLimited reads', () => {
  describe('Given more shown commits in the commit-graph than the read-ahead window', () => {
    describe('When the first body is taken', () => {
      it('Then exactly the window of bodies is read ahead', async () => {
        // Arrange
        const spec = linear(12);
        const history = await buildHistory(spec);
        await graphOver(
          history,
          spec.map(([name]) => name),
        );
        const counted = countingReads(history.ctx);
        const sut = walkLimited;
        const walk = sut(counted.ctx, optionsFor(history, ['k11'], []));

        // Act
        await walk.next();
        await new Promise((resolve) => setTimeout(resolve, 30));

        // Assert
        const readNames = [...counted.reads.keys()].map(history.name).sort();
        expect(readNames).toEqual(['k10', 'k11', 'k4', 'k5', 'k6', 'k7', 'k8', 'k9']);
      });
    });
  });

  describe('Given a diamond history outside the commit-graph', () => {
    describe('When it is walked to the end', () => {
      it('Then every commit object is read once', async () => {
        // Arrange
        const history = await buildHistory([
          ['r', 100, []],
          ['a', 200, ['r']],
          ['b', 210, ['r']],
          ['t', 300, ['a', 'b']],
        ]);
        const counted = countingReads(history.ctx);
        const sut = walkLimited;

        // Act
        const shown: string[] = [];
        for await (const commit of sut(counted.ctx, optionsFor(history, ['t'], []))) {
          shown.push(commit.data.message);
        }

        // Assert
        expect(shown).toEqual(['t', 'b', 'a', 'r']);
        expect(
          Object.fromEntries([...counted.reads].map(([id, n]) => [history.name(id), n])),
        ).toEqual({
          r: 1,
          a: 1,
          b: 1,
          t: 1,
        });
      });
    });
  });
});

describe('limitList excluded diamonds', () => {
  describe('Given an excluded merge whose two parents share a parent', () => {
    describe('When the excluded line outlasts the slop', () => {
      it('Then the shared parent is walked once', async () => {
        // Arrange
        const history = await buildHistory([
          ['d5', 630, []],
          ['d4', 640, ['d5']],
          ['d3', 650, ['d4']],
          ['d2', 660, ['d3']],
          ['d1', 670, ['d2']],
          ['c', 680, ['d1']],
          ['b', 690, ['c']],
          ['a', 700, ['c']],
          ['v', 900, ['a', 'b']],
          ['i', 1000, []],
        ]);
        const sut = limitList;

        // Act
        const result = await sut(history.ctx, optionsFor(history, ['i'], ['v']));

        // Assert
        expect([...result.uninteresting].map(history.name).sort()).toEqual([
          'a',
          'b',
          'c',
          'd1',
          'd2',
          'd3',
          'v',
        ]);
      });
    });
  });
});

describe('limitList stale interest', () => {
  describe('Given the only queued interesting commit is taken right after it was cached', () => {
    describe('When the excluded line then outlasts the slop', () => {
      it('Then the walk gives up and leaves the deep excluded commits unmarked', async () => {
        // Arrange
        const history = await buildHistory([
          ['u10', 620, []],
          ['u9', 630, ['u10']],
          ['u8', 640, ['u9']],
          ['u7', 650, ['u8']],
          ['u6', 660, ['u7']],
          ['u5', 670, ['u6']],
          ['u4', 680, ['u5']],
          ['u3', 690, ['u4']],
          ['u2', 700, ['u3']],
          ['u1', 900, ['u2']],
          ['x', 800, []],
          ['i', 1000, []],
        ]);
        const options = optionsFor(history, ['i', 'x'], ['u1']);
        const sut = limitList;

        // Act
        const result = await sut(history.ctx, options);

        // Assert
        expect([...result.uninteresting].map(history.name).sort()).toEqual([
          'u1',
          'u2',
          'u3',
          'u4',
          'u5',
          'u6',
          'u7',
          'u8',
        ]);
      });
    });
  });
});

describe('limitList typed excluded seeds', () => {
  describe('Given an excluded seed popped before the included commit built on it', () => {
    describe('When a typed walk reaches the seed through that commit', () => {
      it('Then the seed is not typed again from the commit-graph', async () => {
        // Arrange
        const history = await buildHistory([
          ['r', 100, []],
          ['e', 900, ['r']],
          ['t', 500, ['e']],
        ]);
        const objectTypes = createObjectTypeTable();
        objectTypes.set(history.id('r'), 'blob');
        const sut = limitList;

        // Act
        const result = await sut(history.ctx, optionsFor(history, ['t'], ['e'], { objectTypes }));

        // Assert
        expect(result.shown.map(history.name)).toEqual(['t']);
      });
    });
  });
});

describe('limitList excluded parents reached late', () => {
  describe('Given an excluded commit that an included commit reaches before the line marking it', () => {
    describe('When its parent is dated before the line marking it', () => {
      it('Then the parent is already excluded when it is queued, so it is never taken', async () => {
        // Arrange
        const history = await buildHistory([
          ['c', 750, []],
          ['b', 800, ['c']],
          ['a', 700, ['b']],
          ['e', 900, ['a']],
          ['t', 880, ['b']],
        ]);
        const sut = limitList;

        // Act
        const result = await sut(history.ctx, optionsFor(history, ['t'], ['e']));

        // Assert
        expect(result.shown.map(history.name)).toEqual(['t']);
        expect(result.dropped).toEqual([]);
      });
    });
  });
});

describe('limitList typing cost', () => {
  const CHAIN: Spec = [
    ['c0', 0, []],
    ['c1', 10, ['c0']],
    ['c2', 20, ['c1']],
  ];

  describe('Given a chain the walk types as it parses', () => {
    describe('When it is limited', () => {
      it("Then the repository's shallow set is loaded once for the whole walk", async () => {
        // Arrange
        const history = await buildHistory(CHAIN);
        const objectTypes = createObjectTypeTable();
        const load = vi.spyOn(shallowSetModule, 'loadShallowSet');
        const sut = limitList;

        // Act
        const result = await sut(history.ctx, optionsFor(history, ['c2'], [], { objectTypes }));

        // Assert
        expect(result.shown.map(history.name)).toEqual(['c2', 'c1', 'c0']);
        expect(load).toHaveBeenCalledTimes(1);
      });
    });
  });
});
