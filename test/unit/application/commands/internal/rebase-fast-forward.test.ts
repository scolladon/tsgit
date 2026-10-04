import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import {
  branchBaseOf,
  canFastForward,
  isLinearHistory,
} from '../../../../../src/application/commands/internal/rebase-fast-forward.js';
import type { TsgitError } from '../../../../../src/domain/error.js';
import type { ObjectId } from '../../../../../src/domain/objects/index.js';
import type { Context } from '../../../../../src/ports/context.js';
import { seedRepo } from '../fixtures.js';

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const MISSING = `cd${'0'.repeat(38)}` as ObjectId;

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

interface History {
  readonly ctx: Context;
  readonly root: ObjectId;
  readonly line: ObjectId;
  readonly side: ObjectId;
  readonly merge: ObjectId;
  readonly crossA: ObjectId;
  readonly crossB: ObjectId;
  readonly broken: ObjectId;
}

/** root ← line; root ← side; merge of line and side; crossA, crossB criss-cross line and side; broken names a missing parent. */
const history = async (): Promise<History> => {
  const ctx = createMemoryContext();
  const root = await commitOn(ctx, 'root', []);
  const line = await commitOn(ctx, 'line', [root]);
  const side = await commitOn(ctx, 'side', [root]);
  const merge = await commitOn(ctx, 'merge', [line, side]);
  const crossA = await commitOn(ctx, 'crossA', [line, side]);
  const crossB = await commitOn(ctx, 'crossB', [side, line]);
  const broken = await commitOn(ctx, 'broken', [MISSING]);
  return { ctx, root, line, side, merge, crossA, crossB, broken };
};

const refusalOf = (run: () => Promise<unknown>): Promise<unknown> =>
  run().then(
    () => undefined,
    (error: TsgitError) => error.data,
  );

describe('branchBaseOf', () => {
  describe.each([
    { label: 'a sole merge base', onto: 'root', head: 'line', expected: 'root' },
    { label: 'two merge bases', onto: 'crossA', head: 'crossB', expected: undefined },
  ] as const)('Given onto and head with $label', ({ onto, head, expected }) => {
    describe('When the branch base is filled', () => {
      it('Then it is the sole merge base, or none', async () => {
        // Arrange
        const h = await history();
        const sut = branchBaseOf;

        // Act
        const result = await sut(h.ctx, h[onto], h[head]);

        // Assert
        expect(result).toBe(expected === undefined ? undefined : h[expected]);
      });
    });
  });
});

describe('canFastForward', () => {
  describe.each([
    { label: 'a linear head over onto', onto: 'root', upstream: 'root', head: 'line', ff: true },
    {
      label: 'an upstream whose base is not onto',
      onto: 'root',
      upstream: 'line',
      head: 'line',
      ff: false,
    },
    {
      label: 'a merge between onto and head',
      onto: 'root',
      upstream: 'root',
      head: 'merge',
      ff: false,
    },
  ] as const)('Given $label', ({ onto, upstream, head, ff }) => {
    describe('When asked whether the rebase can fast-forward', () => {
      it("Then it answers as git's can_fast_forward does", async () => {
        // Arrange
        const h = await history();
        const sut = canFastForward;

        // Act
        const result = await sut(h.ctx, {
          onto: h[onto],
          upstream: h[upstream],
          head: h[head],
          branchBase: h[onto],
        });

        // Assert
        expect(result).toBe(ff);
      });
    });
  });

  describe.each([
    { label: 'no branch base', branchBase: undefined },
    { label: 'a branch base other than onto', branchBase: 'line' },
  ] as const)('Given $label and an upstream whose walk fails', ({ branchBase }) => {
    describe('When asked whether the rebase can fast-forward', () => {
      it('Then it answers no without walking the upstream', async () => {
        // Arrange
        const h = await history();
        const sut = canFastForward;

        // Act
        const result = await sut(h.ctx, {
          onto: h.root,
          upstream: h.broken,
          head: h.line,
          branchBase: branchBase === undefined ? undefined : h[branchBase],
        });

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given onto as branch base and an upstream whose walk fails', () => {
    describe('When asked whether the rebase can fast-forward', () => {
      it('Then it refuses the parent the upstream walk could not parse', async () => {
        // Arrange
        const h = await history();
        const sut = canFastForward;

        // Act
        const result = await refusalOf(() =>
          sut(h.ctx, { onto: h.root, upstream: h.broken, head: h.line, branchBase: h.root }),
        );

        // Assert
        expect(result).toEqual({ code: 'COMMIT_PARSE_FAILED', id: MISSING });
      });
    });
  });
});

describe('isLinearHistory', () => {
  describe.each([
    { label: 'reaching from through single parents', from: 'root', to: 'line', linear: true },
    { label: 'reaching the root before from', from: 'side', to: 'line', linear: true },
    { label: 'crossing a merge', from: 'root', to: 'merge', linear: false },
  ] as const)('Given a first-parent chain $label', ({ from, to, linear }) => {
    describe('When its linearity is checked', () => {
      it("Then it answers as git's is_linear_history does", async () => {
        // Arrange
        const h = await history();
        const sut = isLinearHistory;

        // Act
        const result = await sut(h.ctx, h[from], h[to]);

        // Assert
        expect(result).toBe(linear);
      });
    });
  });
});
