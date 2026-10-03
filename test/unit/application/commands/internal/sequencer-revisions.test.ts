import { describe, expect, it } from 'vitest';
import {
  isSequence,
  resolveSequencerRevisions,
} from '../../../../../src/application/commands/internal/sequencer-revisions.js';
import { createCommit } from '../../../../../src/application/primitives/create-commit.js';
import { writeObject } from '../../../../../src/application/primitives/write-object.js';
import type { TsgitError } from '../../../../../src/domain/error.js';
import type { AuthorIdentity, ObjectId, Tree } from '../../../../../src/domain/objects/index.js';
import type { Context } from '../../../../../src/ports/context.js';
import { buildSeededContext } from '../../primitives/fixtures.js';

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

/** x (500) ← i (1000); x ← e1 … e6 (299 … 294, clock-skewed) ← e (400); r ← a1 ← a2, r ← b1 ← b2; r ← q1 ← q3, r ← q2. */
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
