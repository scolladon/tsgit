import { describe, expect, it } from 'vitest';

import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import {
  closeReachable,
  copyOidsToCommits,
  createCommitGraphParser,
  parsedForWrite,
  rootCommits,
} from '../../../../../src/application/primitives/internal/commit-graph-passes.js';
import { writeObject } from '../../../../../src/application/primitives/write-object.js';
import { computeLooseObjectPath } from '../../../../../src/domain/index.js';
import type { Blob, Commit, ObjectId, Tree } from '../../../../../src/domain/objects/index.js';
import type { Context } from '../../../../../src/ports/context.js';

const AUTHOR = { name: 'A', email: 'a@a', timestamp: 7, timezoneOffset: '+0000' };
const ABSENT = 'c'.repeat(40) as ObjectId;
const NOT_IN_GRAPH = (): boolean => false;

const loggingContext = (): { readonly ctx: Context; readonly logged: string[] } => {
  const logged: string[] = [];
  const ctx = { ...createMemoryContext(), logger: { error: (line: string) => logged.push(line) } };
  return { ctx, logged };
};

const writeBlob = (ctx: Context, text: string): Promise<ObjectId> => {
  const blob: Blob = { type: 'blob', content: new TextEncoder().encode(text), id: '' as ObjectId };
  return writeObject(ctx, blob);
};

const writeEmptyTree = (ctx: Context): Promise<ObjectId> => {
  const tree: Tree = { type: 'tree', entries: [], id: '' as ObjectId };
  return writeObject(ctx, tree);
};

const writeCommit = async (
  ctx: Context,
  parents: ReadonlyArray<ObjectId>,
  message: string,
): Promise<ObjectId> => {
  const commit: Commit = {
    type: 'commit',
    id: '' as ObjectId,
    data: {
      tree: await writeEmptyTree(ctx),
      parents,
      author: AUTHOR,
      committer: AUTHOR,
      message,
      extraHeaders: [],
    },
  };
  return writeObject(ctx, commit);
};

describe('commit-graph passes', () => {
  describe('Given refs peeling to a commit, a blob and an absent object', () => {
    describe('When the roots are typed', () => {
      it('Then only the commit is kept, without a logged line', async () => {
        // Arrange
        const { ctx, logged } = loggingContext();
        const commit = await writeCommit(ctx, [], 'root');
        const blob = await writeBlob(ctx, 'hi');
        const sut = rootCommits;

        // Act
        const result = await sut(createCommitGraphParser(ctx), [blob, commit, ABSENT]);

        // Assert
        expect({ result, logged }).toEqual({ result: [commit], logged: [] });
      });
    });
  });

  describe('Given a commit whose parents are a blob and an absent object', () => {
    describe('When the reachable closure is taken and copied', () => {
      it('Then each pass logs each parent that fails to parse, and the copy keeps every oid once in byte order', async () => {
        // Arrange
        const { ctx, logged } = loggingContext();
        const blob = await writeBlob(ctx, 'hi');
        const tip = await writeCommit(ctx, [blob, ABSENT, blob], 'tip');
        const parser = createCommitGraphParser(ctx);
        const sut = copyOidsToCommits;

        // Act
        const closed = await closeReachable(parser, [tip], NOT_IN_GRAPH);
        const result = await sut(parser, closed, NOT_IN_GRAPH);

        // Assert
        const lineOf = new Map([
          [blob, `Object ${blob} not a commit`],
          [ABSENT, `Could not read ${ABSENT}`],
        ]);
        const sorted = [tip, blob, ABSENT].sort();
        expect({ closed, result, logged }).toEqual({
          closed: [tip, blob, ABSENT],
          result: sorted,
          logged: [
            lineOf.get(blob),
            lineOf.get(ABSENT),
            ...sorted.flatMap((id) => lineOf.get(id) ?? []),
          ],
        });
      });
    });
  });

  describe('Given a parent whose loose object is corrupt', () => {
    describe('When the reachable closure is taken', () => {
      it('Then the read failure propagates instead of reading as a parse failure', async () => {
        // Arrange
        const { ctx, logged } = loggingContext();
        const parent = await writeCommit(ctx, [], 'parent');
        const tip = await writeCommit(ctx, [parent], 'tip');
        const path = `${ctx.layout.gitDir}/objects/${computeLooseObjectPath(parent)}`;
        await ctx.fs.rm(path);
        await ctx.fs.write(path, new Uint8Array([1, 2, 3]));
        const sut = closeReachable;

        // Act
        let caught: unknown;
        try {
          await sut(createCommitGraphParser(ctx), [tip], NOT_IN_GRAPH);
        } catch (error) {
          caught = error;
        }

        // Assert
        expect({
          code: (caught as { data?: { code?: string } }).data?.code,
          logged,
        }).toEqual({
          code: 'DECOMPRESS_FAILED',
          logged: [],
        });
      });
    });
  });

  describe('Given a commit the graph already holds', () => {
    describe('When the reachable closure is taken and copied', () => {
      it('Then neither pass parses it nor follows its parents', async () => {
        // Arrange
        const { ctx, logged } = loggingContext();
        const blob = await writeBlob(ctx, 'hi');
        const held = await writeCommit(ctx, [blob], 'held');
        const tip = await writeCommit(ctx, [held], 'tip');
        const parser = createCommitGraphParser(ctx);
        const inGraph = (id: ObjectId): boolean => id === held;
        const sut = copyOidsToCommits;

        // Act
        const closed = await closeReachable(parser, [tip], inGraph);
        const result = await sut(parser, closed, inGraph);

        // Assert
        expect({ closed, result, logged }).toEqual({
          closed: [tip, held],
          result: [tip],
          logged: [],
        });
      });
    });
  });

  describe('Given commits that all parsed but one', () => {
    describe('When their entries are written', () => {
      it('Then the first that failed refuses COMMIT_PARSE_FAILED after its line', async () => {
        // Arrange
        const { ctx, logged } = loggingContext();
        const blob = await writeBlob(ctx, 'hi');
        const tip = await writeCommit(ctx, [blob], 'tip');
        const parser = createCommitGraphParser(ctx);
        await copyOidsToCommits(parser, [tip, blob], NOT_IN_GRAPH);
        logged.length = 0;
        const sut = parsedForWrite;

        // Act
        let caught: unknown;
        try {
          sut(parser, [tip, blob]);
        } catch (error) {
          caught = error;
        }

        // Assert
        expect({ data: (caught as { data?: unknown }).data, logged }).toEqual({
          data: { code: 'COMMIT_PARSE_FAILED', id: blob },
          logged: [`Object ${blob} not a commit`],
        });
      });
    });
  });

  describe('Given commits that all parsed', () => {
    describe('When their entries are written', () => {
      it('Then each comes back as parsed, in the order given', async () => {
        // Arrange
        const { ctx } = loggingContext();
        const root = await writeCommit(ctx, [], 'root');
        const tip = await writeCommit(ctx, [root], 'tip');
        const parser = createCommitGraphParser(ctx);
        await copyOidsToCommits(parser, [tip, root], NOT_IN_GRAPH);
        const sut = parsedForWrite;

        // Act
        const result = sut(parser, [tip, root]);

        // Assert
        expect(result.map((commit) => [commit.id, commit.parents, commit.committerDate])).toEqual([
          [tip, [root], 7],
          [root, [], 7],
        ]);
      });
    });
  });
});
