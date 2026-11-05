import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isSequence,
  resolveSequencerRevisions,
} from '../../../../../src/application/commands/internal/sequencer-revisions.js';
import * as revParseModule from '../../../../../src/application/commands/rev-parse.js';
import { createCommit } from '../../../../../src/application/primitives/create-commit.js';
import * as peelRefModule from '../../../../../src/application/primitives/internal/peel-ref-to-commit.js';
import * as readObjectModule from '../../../../../src/application/primitives/read-object.js';
import { writeObject } from '../../../../../src/application/primitives/write-object.js';
import type { TsgitError } from '../../../../../src/domain/error.js';
import type { AuthorIdentity, ObjectId, Tree } from '../../../../../src/domain/objects/index.js';
import type { Context } from '../../../../../src/ports/context.js';
import { buildSeededContext, writeRawObjectBytes } from '../../primitives/fixtures.js';

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
  readonly names: (ids: ReadonlyArray<ObjectId>) => ReadonlyArray<string>;
}

const buildHistory = async (spec: Spec): Promise<History> => {
  const ctx = await buildSeededContext();
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
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
  const byId = new Map([...ids].map(([key, value]) => [value, key]));
  return { ctx, id, names: (oids) => oids.map((oid) => byId.get(oid) as string) };
};

/** x (500) ← i (1000); x ← e1 … e6 (299 … 294, clock-skewed) ← e (400); r ← a1 ← a2, r ← b1 ← b2; r ← q1 ← q3, r ← q2; r ← s1, and mg merges a2 and s1. */
const SPEC: Spec = [
  ['x', 500, []],
  ['i', 1000, ['x']],
  ['e1', 299, ['x']],
  ['e2', 298, ['e1']],
  ['e3', 297, ['e2']],
  ['e4', 296, ['e3']],
  ['e5', 295, ['e4']],
  ['e6', 294, ['e5']],
  ['e', 400, ['e6']],
  ['r', 100, []],
  ['a1', 200, ['r']],
  ['a2', 400, ['a1']],
  ['b1', 300, ['r']],
  ['b2', 150, ['b1']],
  ['q1', 300, ['r']],
  ['q2', 300, ['r']],
  ['q3', 300, ['q1']],
  ['s1', 250, ['r']],
  ['mg', 600, ['a2', 's1']],
];

/**
 * c, d (excluded) and h share a date. g ← s ← c; g ← k6 … k1 ← p ← h and
 * p ← n ← m ← d, all of p's line dated before g. Popping d before h marks p
 * before it is shown, so the walk gives up before k6 reaches g; popping h
 * first shows p, whose date keeps the walk going until g is excluded.
 */
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

describe('resolveSequencerRevisions', () => {
  describe.each([
    { args: ['e..i'], kind: 'walked', commits: ['i', 'x'] },
    { args: ['e3..i'], kind: 'walked', commits: ['i'] },
    { args: ['r..a2', 'r..b2'], kind: 'walked', commits: ['a2', 'a1', 'b2', 'b1'] },
    { args: ['r..b2', 'r..a2'], kind: 'walked', commits: ['a2', 'a1', 'b2', 'b1'] },
    { args: ['b2', 'r..a2'], kind: 'walked', commits: ['a2', 'a1', 'b2', 'b1'] },
    { args: ['r..q3', 'r..q2'], kind: 'walked', commits: ['q3', 'q2', 'q1'] },
    { args: ['r..q2', 'r..q3'], kind: 'walked', commits: ['q2', 'q3', 'q1'] },
    { args: ['r..a2', 'a1..a2'], kind: 'walked', commits: ['a2'] },
    { args: ['a2', 'b1', 'a1'], kind: 'listed', commits: ['a2', 'b1', 'a1'] },
    { args: ['b1', 'b1'], kind: 'listed', commits: ['b1'] },
    { args: ['a2^'], kind: 'listed', commits: ['a1'] },
    { args: ['^r', 'a2'], kind: 'walked', commits: ['a2', 'a1'] },
    { args: ['a2', '^a1'], kind: 'walked', commits: ['a2'] },
  ])('Given the history and the arguments $args', ({ args, kind, commits }) => {
    describe('When the sequencer resolves them', () => {
      it(`Then it ${kind === 'walked' ? 'walks them together, newest first' : 'lists each commit once, in argument order'}`, async () => {
        // Arrange
        const history = await buildHistory(SPEC);
        const sut = resolveSequencerRevisions;
        const named = args.map((arg) => arg.replace(/[a-z]\d*/g, history.id));

        // Act
        const result = await sut(history.ctx, named);

        // Assert
        expect({ kind: result.kind, commits: history.names(result.commits) }).toEqual({
          kind,
          commits,
        });
      });
    });
  });

  describe.each([
    { args: ['c', 'd..h'], commits: ['c', 'h', 's', 'g'] },
    { args: ['c', 'h', '^d'], commits: ['c', 'h', 's'] },
  ])('Given seeds sharing a commit date and the arguments $args', ({ args, commits }) => {
    describe('When the sequencer resolves them', () => {
      it('Then the seeds enter the walk in argument order, as git queues them', async () => {
        // Arrange
        const history = await buildHistory(TIED_SEEDS);
        const sut = resolveSequencerRevisions;
        const named = args.map((arg) => arg.replace(/[a-z]\d*/g, history.id));

        // Act
        const result = await sut(history.ctx, named);

        // Assert
        expect(history.names(result.commits)).toEqual(commits);
      });
    });
  });

  describe('Given a range that names no commit', () => {
    describe('When the sequencer resolves it', () => {
      it('Then it refuses with EMPTY_COMMIT_SET', async () => {
        // Arrange
        const history = await buildHistory(SPEC);
        const sut = resolveSequencerRevisions;

        // Act
        let caught: unknown;
        try {
          await sut(history.ctx, [`${history.id('a1')}..${history.id('a1')}`]);
        } catch (error) {
          caught = error;
        }

        // Assert
        expect((caught as TsgitError).data).toEqual({ code: 'EMPTY_COMMIT_SET' });
      });
    });
  });

  describe.each([
    { args: ['r..'], commits: ['a2', 'a1'] },
    { args: ['..b2'], commits: ['b2', 'b1'] },
  ])('Given HEAD on a2 and a range $args with one side left out', ({ args, commits }) => {
    describe('When the sequencer resolves it', () => {
      it('Then the missing side means HEAD, as git reads it', async () => {
        // Arrange
        const history = await buildHistory(SPEC);
        await history.ctx.fs.writeUtf8(
          `${history.ctx.layout.gitDir}/refs/heads/main`,
          `${history.id('a2')}\n`,
        );
        const sut = resolveSequencerRevisions;
        const named = args.map((arg) => arg.replace(/[a-z]\d*/g, history.id));

        // Act
        const result = await sut(history.ctx, named);

        // Assert
        expect(history.names(result.commits)).toEqual(commits);
      });
    });
  });

  describe.each([
    { label: 'a peeled tree', arg: (id: string) => `${id}^{tree}`, type: 'tree' },
    { label: 'a tree path', arg: (id: string) => `${id}:`, type: 'tree' },
    {
      label: 'a range side naming a tree',
      arg: (id: string) => `r..${id}:`,
      type: 'tree',
      side: true,
    },
  ])('Given an argument naming $label', ({ arg, type, side }) => {
    describe('When the sequencer resolves it after a commit', () => {
      it('Then it refuses the non-commit by the name it was given', async () => {
        // Arrange
        const history = await buildHistory(SPEC);
        const sut = resolveSequencerRevisions;
        const named = arg(history.id('a2')).replace(/^r\.\./, `${history.id('r')}..`);

        // Act
        let caught: unknown;
        try {
          await sut(history.ctx, [history.id('a1'), named]);
        } catch (error) {
          caught = error;
        }

        // Assert
        const revision = side === true ? named.slice(named.indexOf('..') + 2) : named;
        expect((caught as TsgitError).data).toEqual({
          code: 'CANNOT_PICK_NON_COMMIT',
          revision,
          type,
        });
      });
    });
  });

  describe.each([
    { form: 'a range', args: (id: string) => [`${id}:..${id}`] },
    { form: 'a caret', args: (id: string) => [`^${id}:`, id] },
  ])('Given $form excluding a tree', ({ args }) => {
    describe('When the sequencer resolves it', () => {
      it('Then it refuses the excluded tree by the name it was given', async () => {
        // Arrange
        const history = await buildHistory(SPEC);
        const sut = resolveSequencerRevisions;
        const a1 = history.id('a1');

        // Act
        let caught: unknown;
        try {
          await sut(history.ctx, args(a1));
        } catch (error) {
          caught = error;
        }

        // Assert
        expect((caught as TsgitError).data).toEqual({
          code: 'CANNOT_PICK_NON_COMMIT',
          revision: `${a1}:`,
          type: 'tree',
        });
      });
    });
  });

  describe('Given a range whose tip merges a side branch', () => {
    describe('When the sequencer resolves it', () => {
      it('Then it walks the side branch too, not only the first parents', async () => {
        // Arrange
        const history = await buildHistory(SPEC);
        const sut = resolveSequencerRevisions;
        const range = `${history.id('r')}..${history.id('mg')}`;

        // Act
        const result = await sut(history.ctx, [range]);

        // Assert
        expect(history.names(result.commits)).toEqual(['mg', 'a2', 's1', 'a1']);
      });
    });
  });

  describe('Given a blob id and then an unknown revision', () => {
    describe('When the sequencer resolves them', () => {
      it('Then the unknown revision refuses first, as git resolves every argument before checking types', async () => {
        // Arrange
        const history = await buildHistory(SPEC);
        const blob = await writeObject(history.ctx, {
          type: 'blob',
          id: '' as ObjectId,
          content: new TextEncoder().encode('x'),
        });
        const sut = resolveSequencerRevisions;

        // Act
        let caught: unknown;
        try {
          await sut(history.ctx, [blob, `${history.id('a2')}~9`]);
        } catch (error) {
          caught = error;
        }

        // Assert
        expect((caught as TsgitError).data.code).not.toBe('CANNOT_PICK_NON_COMMIT');
      });
    });
  });

  describe('Given a blob id', () => {
    describe('When the sequencer resolves it', () => {
      it('Then it refuses the blob', async () => {
        // Arrange
        const history = await buildHistory(SPEC);
        const blob = await writeObject(history.ctx, {
          type: 'blob',
          id: '' as ObjectId,
          content: new TextEncoder().encode('x'),
        });
        const sut = resolveSequencerRevisions;

        // Act
        let caught: unknown;
        try {
          await sut(history.ctx, [blob]);
        } catch (error) {
          caught = error;
        }

        // Assert
        expect((caught as TsgitError).data).toEqual({
          code: 'CANNOT_PICK_NON_COMMIT',
          revision: blob,
          type: 'blob',
        });
      });
    });
  });

  describe('Given a symmetric range', () => {
    describe('When the sequencer resolves it', () => {
      it('Then it refuses the unsupported form', async () => {
        // Arrange
        const history = await buildHistory(SPEC);
        const sut = resolveSequencerRevisions;
        const arg = `${history.id('a1')}...${history.id('b1')}`;

        // Act
        let caught: unknown;
        try {
          await sut(history.ctx, [arg]);
        } catch (error) {
          caught = error;
        }

        // Assert
        expect((caught as TsgitError).data).toEqual({
          code: 'INVALID_OPTION',
          option: 'commits',
          reason: `unsupported revision form '${arg}' (use a commit-ish or A..B)`,
        });
      });
    });
  });
});

describe('isSequence', () => {
  describe.each([
    { args: ['c'], kind: 'listed', expected: false },
    { args: ['c', 'c'], kind: 'listed', expected: true },
    { args: ['b..c'], kind: 'walked', expected: true },
  ] as const)('Given the arguments $args resolved as $kind', ({ args, kind, expected }) => {
    describe('When asked whether they run as a sequence', () => {
      it(`Then it answers ${expected}`, () => {
        // Arrange
        const sut = isSequence;

        // Act
        const result = sut(args, { kind, commits: [] });

        // Assert
        expect(result).toBe(expected);
      });
    });
  });
});

const AMBIGUOUS_X = "refname 'x' is ambiguous.";

/** Branch x and main on `a2`, plus a tag ref x on the given object. */
const plantTagAheadOfBranch = async (
  history: History,
  tagTarget: ObjectId | string,
): Promise<void> => {
  const gitDir = history.ctx.layout.gitDir;
  const tip = `${history.id('a2')}\n`;
  await history.ctx.fs.writeUtf8(`${gitDir}/refs/heads/x`, tip);
  await history.ctx.fs.writeUtf8(`${gitDir}/refs/heads/main`, tip);
  await history.ctx.fs.writeUtf8(`${gitDir}/refs/tags/x`, `${tagTarget}\n`);
};

const rawTagNaming = (history: History, object: string, type: string): Promise<ObjectId> =>
  writeRawObjectBytes(
    history.ctx,
    'tag',
    new TextEncoder().encode(
      `object ${object}\ntype ${type}\ntag x\ntagger A <a@x> 1 +0000\n\nmsg\n`,
    ),
  );

const refusalOf = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    await run();
    return undefined;
  } catch (error) {
    return (error as TsgitError).data;
  }
};

describe('resolveSequencerRevisions — a corrupt name', () => {
  describe.each([
    { variant: 'non-hex', body: 'z'.repeat(40) },
    { variant: 'M', body: undefined },
  ])('Given a tag ref x naming a $variant object ahead of branch x', ({ body }) => {
    describe('When the sequencer resolves x', () => {
      it("Then it refuses BAD_OBJECT { revision: 'x' }", async () => {
        // Arrange
        const history = await buildHistory(SPEC);
        const target =
          body === undefined ? 'b'.repeat(40) : await rawTagNaming(history, body, 'commit');
        await plantTagAheadOfBranch(history, target);
        const sut = resolveSequencerRevisions;

        // Act
        const result = await refusalOf(() => sut(history.ctx, ['x']));

        // Assert
        expect(result).toEqual({ code: 'BAD_OBJECT', revision: 'x' });
      });
    });
  });

  describe.each([
    { variant: 'absent', object: 'a'.repeat(40), type: 'commit' },
    { variant: 'tree', object: undefined, type: 'tree' },
  ])('Given a tag ref x naming a $variant object', ({ object, type }) => {
    describe("When the sequencer resolves the tag's name", () => {
      it("Then it refuses CANNOT_PICK_NON_COMMIT with type 'tag'", async () => {
        // Arrange
        const history = await buildHistory(SPEC);
        const named =
          object ??
          (await writeObject(history.ctx, {
            type: 'tree',
            id: '' as ObjectId,
            entries: [],
          } as Tree));
        await plantTagAheadOfBranch(history, await rawTagNaming(history, named, type));
        const sut = resolveSequencerRevisions;

        // Act
        const result = await refusalOf(() => sut(history.ctx, ['x']));

        // Assert
        expect(result).toEqual({ code: 'CANNOT_PICK_NON_COMMIT', revision: 'x', type: 'tag' });
      });
    });
  });

  describe.each([{ args: ['x'] }, { args: ['x..main'] }, { args: ['^x', 'main'] }])(
    'Given a valid x ambiguous between a lightweight tag and a branch',
    ({ args }) => {
      describe(`When the sequencer resolves ${JSON.stringify(args)}`, () => {
        it('Then it warns the ambiguity twice, once per read git makes', async () => {
          // Arrange
          const history = await buildHistory(SPEC);
          await plantTagAheadOfBranch(history, history.id('a2'));
          const warnings: string[] = [];
          const ctx = { ...history.ctx, logger: { warn: (m: string) => void warnings.push(m) } };
          const sut = resolveSequencerRevisions;

          // Act
          await sut(ctx, args).catch(() => undefined);

          // Assert
          expect(warnings).toEqual([AMBIGUOUS_X, AMBIGUOUS_X]);
        });
      });
    },
  );
});

describe('resolveSequencerRevisions — a corrupt side', () => {
  describe.each([
    { variant: 'non-hex', body: 'z'.repeat(40) },
    { variant: 'M', body: undefined },
  ])('Given a tag ref x naming a $variant object ahead of branch x', ({ body }) => {
    const plant = async (): Promise<History> => {
      const history = await buildHistory(SPEC);
      const target =
        body === undefined ? 'b'.repeat(40) : await rawTagNaming(history, body, 'commit');
      await plantTagAheadOfBranch(history, target);
      return history;
    };

    describe('When the sequencer excludes x', () => {
      it("Then it refuses BAD_OBJECT { revision: 'x' } on the first read", async () => {
        // Arrange
        const history = await plant();
        const sut = resolveSequencerRevisions;

        // Act
        const result = await refusalOf(() => sut(history.ctx, ['^x', 'main']));

        // Assert
        expect(result).toEqual({ code: 'BAD_OBJECT', revision: 'x' });
      });
    });

    describe.each(['x..main', 'main..x'])('When the sequencer takes the range %s', (range) => {
      it('Then it refuses INVALID_REVISION_RANGE naming the range', async () => {
        // Arrange
        const history = await plant();
        const sut = resolveSequencerRevisions;

        // Act
        const result = await refusalOf(() => sut(history.ctx, [range]));

        // Assert
        expect(result).toEqual({ code: 'INVALID_REVISION_RANGE', expression: range });
      });
    });
  });
});

describe('resolveSequencerRevisions — the two reads of a name', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Given a branch x whose second read answers another commit', () => {
    describe('When the sequencer resolves x', () => {
      it('Then it picks the commit of the first read, as git picks from its pending list', async () => {
        // Arrange
        const history = await buildHistory(SPEC);
        await history.ctx.fs.writeUtf8(
          `${history.ctx.layout.gitDir}/refs/heads/x`,
          `${history.id('a2')}\n`,
        );
        vi.spyOn(revParseModule, 'evaluateRevision').mockResolvedValueOnce(history.id('a1'));
        const sut = resolveSequencerRevisions;

        // Act
        const result = await sut(history.ctx, ['x']);

        // Assert
        expect(history.names(result.commits)).toEqual(['a2']);
      });
    });
  });

  describe('Given a peel that fails without an error code', () => {
    describe('When the sequencer resolves x', () => {
      it('Then the failure propagates unchanged', async () => {
        // Arrange
        const history = await buildHistory(SPEC);
        await history.ctx.fs.writeUtf8(
          `${history.ctx.layout.gitDir}/refs/heads/x`,
          `${history.id('a2')}\n`,
        );
        const failure = new Error('boom');
        vi.spyOn(peelRefModule, 'peelRefToCommit').mockRejectedValueOnce(failure);
        const sut = resolveSequencerRevisions;

        // Act
        const caught = await sut(history.ctx, ['x']).catch((error: unknown) => error);

        // Assert
        expect(caught).toBe(failure);
      });
    });
  });
});

describe('Given a range side whose read fails without an error code', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe.each(['x..main', 'main..x'])('When the sequencer takes the range %s', (range) => {
    it('Then the failure propagates unchanged', async () => {
      // Arrange
      const history = await buildHistory(SPEC);
      const gitDir = history.ctx.layout.gitDir;
      await history.ctx.fs.writeUtf8(`${gitDir}/refs/heads/x`, `${history.id('a1')}\n`);
      await history.ctx.fs.writeUtf8(`${gitDir}/refs/heads/main`, `${history.id('a2')}\n`);
      const failure = new Error('boom');
      const original = readObjectModule.readObject;
      vi.spyOn(readObjectModule, 'readObject').mockImplementation((ctx, id) =>
        id === history.id('a1') ? Promise.reject(failure) : original(ctx, id),
      );
      const sut = resolveSequencerRevisions;

      // Act
      const caught = await sut(history.ctx, [range]).catch((error: unknown) => error);

      // Assert
      expect(caught).toBe(failure);
    });
  });
});

describe('Given a branch x whose first read is a tag of a tree and whose second read is a commit', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('When the sequencer resolves x', () => {
    it("Then it refuses CANNOT_PICK_NON_COMMIT with the first read's unpeeled type", async () => {
      // Arrange
      const history = await buildHistory(SPEC);
      const tip = await readObjectModule.readObject(history.ctx, history.id('a2'));
      if (tip.type !== 'commit') throw new Error('expected a commit');
      const treeTag = await rawTagNaming(history, tip.data.tree, 'tree');
      await history.ctx.fs.writeUtf8(`${history.ctx.layout.gitDir}/refs/heads/x`, `${treeTag}\n`);
      vi.spyOn(revParseModule, 'evaluateRevision').mockResolvedValueOnce(history.id('a2'));
      const sut = resolveSequencerRevisions;

      // Act
      const result = await refusalOf(() => sut(history.ctx, ['x']));

      // Assert
      expect(result).toEqual({ code: 'CANNOT_PICK_NON_COMMIT', revision: 'x', type: 'tag' });
    });
  });
});
