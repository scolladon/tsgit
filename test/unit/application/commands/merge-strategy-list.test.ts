import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { branchCreate } from '../../../../src/application/commands/branch.js';
import { checkout } from '../../../../src/application/commands/checkout.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import { mergeRun } from '../../../../src/application/commands/merge.js';
import { readObject } from '../../../../src/application/primitives/read-object.js';
import { readReflog } from '../../../../src/application/primitives/reflog-store.js';
import { resolveRef } from '../../../../src/application/primitives/resolve-ref.js';
import type { TsgitError } from '../../../../src/domain/error.js';
import type { AuthorIdentity, ObjectId, RefName } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';

const author: AuthorIdentity = {
  name: 'a',
  email: 'a@x',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0130',
};
const HEAD = 'HEAD' as RefName;

const write = (ctx: Context, file: string, body: string): Promise<void> =>
  ctx.fs.writeUtf8(`${ctx.layout.workDir}/${file}`, body);

const commitFile = async (
  ctx: Context,
  file: string,
  body: string,
  message: string,
): Promise<ObjectId> => {
  await write(ctx, file, body);
  await add(ctx, [file]);
  return (await commit(ctx, { message, author })).id;
};

interface Repo {
  readonly ctx: Context;
  readonly base: ObjectId;
  readonly main: ObjectId;
}

type Shape = 'clean' | 'conflict' | 'fast-forward';

/** feature adds s (and rewrites f to conflict); main rewrites f too (conflict), adds m (clean) or stays (fast-forward). */
const repo = async (shape: Shape, config = ''): Promise<Repo> => {
  const ctx = createMemoryContext();
  await init(ctx);
  await ctx.fs.appendUtf8(`${ctx.layout.gitDir}/config`, config);
  const base = await commitFile(ctx, 'f', 'base\n', 'base');
  await branchCreate(ctx, { name: 'feature' });
  await checkout(ctx, { rev: 'feature' });
  await commitFile(ctx, 's', 's\n', 'side one');
  if (shape === 'conflict') await commitFile(ctx, 'f', 'feature\n', 'side two');
  await checkout(ctx, { rev: 'main' });
  if (shape === 'fast-forward') return { ctx, base, main: base };
  const main = await commitFile(ctx, shape === 'clean' ? 'm' : 'f', 'main\n', 'main');
  return { ctx, base, main };
};

/** A second head off base, adding o. */
const otherHead = async (ctx: Context, base: ObjectId): Promise<ObjectId> => {
  await branchCreate(ctx, { name: 'other', startPoint: base });
  await checkout(ctx, { rev: 'other' });
  const other = await commitFile(ctx, 'o', 'o\n', 'other');
  await checkout(ctx, { rev: 'main' });
  return other;
};

const lastNote = async (ctx: Context): Promise<string | undefined> =>
  (await readReflog(ctx, HEAD)).at(-1)?.message;

const treeOf = async (ctx: Context, id: ObjectId): Promise<ObjectId | undefined> => {
  const read = await readObject(ctx, id);
  return read.type === 'commit' ? read.data.tree : undefined;
};

const errorData = (run: Promise<unknown>): Promise<unknown> =>
  run.then(
    () => undefined,
    (e: unknown) => (e as TsgitError).data,
  );

describe('merge strategy list', () => {
  describe.each([
    [['octopus', 'ort'], "merge feature: Merge made by the 'ort' strategy."],
    [['resolve', 'octopus'], 'merge feature: In-index merge'],
    [['ort', 'ours'], "merge feature: Merge made by the 'ort' strategy."],
  ] as const)('Given strategies %j over a clean merge', (strategy, note) => {
    describe('When merged', () => {
      it('Then the first strategy that merges cleanly commits', async () => {
        // Arrange
        const { ctx } = await repo('clean');
        const sut = mergeRun;

        // Act
        const result = await sut(ctx, { rev: 'feature', strategy, author });

        // Assert
        expect(result.kind).toBe('merge');
        expect(await lastNote(ctx)).toBe(note);
      });
    });
  });

  describe('Given strategies ours then ort', () => {
    describe('When merged', () => {
      it("Then ours commits HEAD's tree", async () => {
        // Arrange
        const { ctx, main } = await repo('clean');
        const sut = mergeRun;

        // Act
        const result = await sut(ctx, { rev: 'feature', strategy: ['ours', 'ort'], author });

        // Assert
        const merged = result.kind === 'merge' ? result.id : main;
        expect(await treeOf(ctx, merged)).toBe(await treeOf(ctx, main));
        expect(await lastNote(ctx)).toBe("merge feature: Merge made by the 'ours' strategy.");
      });
    });
  });

  describe.each([
    [['ort', 'ours'], 'merge'],
    [['resolve', 'octopus'], 'fast-forward'],
  ] as const)('Given strategies %j over a fast-forwardable head', (strategy, kind) => {
    describe('When merged', () => {
      it('Then any strategy that never fast-forwards forbids it', async () => {
        // Arrange
        const { ctx } = await repo('fast-forward');
        const sut = mergeRun;

        // Act
        const result = await sut(ctx, { rev: 'feature', strategy, author });

        // Assert
        expect(result.kind).toBe(kind);
      });
    });
  });

  describe('Given strategies that all fail the merge', () => {
    describe('When merged', () => {
      it('Then no strategy handled it and HEAD stays', async () => {
        // Arrange
        const { ctx, main } = await repo('conflict');
        const sut = mergeRun;

        // Act
        const result = await errorData(
          sut(ctx, { rev: 'feature', strategy: ['octopus', 'octopus'], author }),
        );

        // Assert
        expect(result).toEqual({
          code: 'NO_MERGE_STRATEGY_HANDLED',
          strategies: ['octopus', 'octopus'],
        });
        expect(await resolveRef(ctx, HEAD)).toBe(main);
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/MERGE_HEAD`)).toBe(false);
      });
    });
  });

  describe('Given a strategy list naming an unknown strategy', () => {
    describe('When merged', () => {
      it('Then it refuses before writing anything', async () => {
        // Arrange
        const { ctx } = await repo('clean');
        const sut = mergeRun;

        // Act
        const result = await errorData(
          sut(ctx, { rev: 'feature', strategy: ['ort', 'bogus'], author }),
        );

        // Assert
        expect(result).toEqual(
          expect.objectContaining({ code: 'UNKNOWN_MERGE_STRATEGY', strategy: 'bogus' }),
        );
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/ORIG_HEAD`)).toBe(false);
      });
    });
  });

  describe.each([
    ['resolve', undefined, 'merge feature: In-index merge'],
    ['ours resolve', undefined, "merge feature: Merge made by the 'ours' strategy."],
    ['ours', 'ort', "merge feature: Merge made by the 'ort' strategy."],
  ] as const)('Given pull.twohead %j', (twohead, strategy, note) => {
    describe(`When merged with strategy ${strategy}`, () => {
      it('Then the configured strategies apply unless the caller names its own', async () => {
        // Arrange
        const { ctx } = await repo('clean', `[pull]\n\ttwohead = ${twohead}\n`);
        const sut = mergeRun;

        // Act
        await sut(ctx, { rev: 'feature', ...(strategy === undefined ? {} : { strategy }), author });

        // Assert
        expect(await lastNote(ctx)).toBe(note);
      });
    });
  });

  describe.each([
    ['bogus', 'bogus'],
    ['""', ''],
    ['" resolve"', ''],
  ] as const)('Given pull.twohead %s', (twohead, strategy) => {
    describe('When merged', () => {
      it('Then each space-separated name must be a strategy git knows', async () => {
        // Arrange
        const { ctx } = await repo('clean', `[pull]\n\ttwohead = ${twohead}\n`);
        const sut = mergeRun;

        // Act
        const result = await errorData(sut(ctx, { rev: 'feature', author }));

        // Assert
        expect(result).toEqual(
          expect.objectContaining({ code: 'UNKNOWN_MERGE_STRATEGY', strategy }),
        );
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/ORIG_HEAD`)).toBe(false);
      });
    });
  });

  describe('Given a valueless pull.twohead', () => {
    describe('When merged', () => {
      it('Then it refuses the missing value', async () => {
        // Arrange
        const { ctx } = await repo('clean', '[pull]\n\ttwohead\n');
        const sut = mergeRun;

        // Act
        const result = await errorData(sut(ctx, { rev: 'feature', strategy: 'ort', author }));

        // Assert
        expect(result).toEqual(
          expect.objectContaining({ code: 'CONFIG_MISSING_VALUE', key: 'pull.twohead' }),
        );
      });
    });
  });

  describe('Given a valueless pull.octopus', () => {
    describe('When one head is merged', () => {
      it('Then it refuses the missing value before merging', async () => {
        // Arrange
        const { ctx } = await repo('clean', '[pull]\n\toctopus\n');
        const sut = mergeRun;

        // Act
        const result = await errorData(sut(ctx, { rev: 'feature', strategy: 'ort', author }));

        // Assert
        expect(result).toEqual(
          expect.objectContaining({ code: 'CONFIG_MISSING_VALUE', key: 'pull.octopus' }),
        );
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/ORIG_HEAD`)).toBe(false);
      });
    });
  });

  describe('Given pull.octopus ours and pull.twohead bogus', () => {
    describe('When two heads are merged', () => {
      it('Then pull.octopus picks the strategy and pull.twohead is not consulted', async () => {
        // Arrange
        const config = '[pull]\n\toctopus = ours\n\ttwohead = bogus\n';
        const { ctx, base, main } = await repo('clean', config);
        await otherHead(ctx, base);
        const sut = mergeRun;

        // Act
        const result = await sut(ctx, { rev: ['feature', 'other'], author });

        // Assert
        const merged = result.kind === 'merge' ? result.id : main;
        expect(await treeOf(ctx, merged)).toBe(await treeOf(ctx, main));
        expect(await lastNote(ctx)).toBe("merge feature other: Merge made by the 'ours' strategy.");
      });
    });
  });
});
