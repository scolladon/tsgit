import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { branchCreate } from '../../../../src/application/commands/branch.js';
import { checkout } from '../../../../src/application/commands/checkout.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import { type MergeRunInput, mergeRun } from '../../../../src/application/commands/merge.js';
import { tagCreate } from '../../../../src/application/commands/tag.js';
import { readObject } from '../../../../src/application/primitives/read-object.js';
import type { TsgitError } from '../../../../src/domain/error.js';
import type { AuthorIdentity, ObjectId } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';

const author: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

const USER_CONFIG = '[user]\n  name = Grace\n  email = grace@example.com\n';

const commitFile = async (ctx: Context, file: string, message: string): Promise<ObjectId> => {
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/${file}`, file);
  await add(ctx, [file]);
  return (await commit(ctx, { message, author })).id;
};

/** main and feature diverge from `base`: feature adds `one` then `two`, main adds `on-main`. */
const divergedRepo = async (config = ''): Promise<Context> => {
  const ctx = createMemoryContext();
  await init(ctx);
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, `${USER_CONFIG}${config}`);
  await commitFile(ctx, 'a.txt', 'base');
  await branchCreate(ctx, { name: 'feature' });
  await checkout(ctx, { rev: 'feature' });
  await commitFile(ctx, 'one.txt', 'one');
  await commitFile(ctx, 'two.txt', 'two');
  await checkout(ctx, { rev: 'main' });
  await commitFile(ctx, 'c.txt', 'on-main');
  return ctx;
};

const mergedMessage = async (ctx: Context, input: MergeRunInput): Promise<string> => {
  const result = await mergeRun(ctx, { author, ...input });
  if (result.kind !== 'merge') throw new Error(`expected a merge, got ${result.kind}`);
  const merged = await readObject(ctx, result.id);
  if (merged.type !== 'commit') throw new Error('not a commit');
  return merged.data.message;
};

const SHORTLOG = "Merge branch 'feature'\n\n* feature:\n  two\n  one\n";
const PLAIN = "Merge branch 'feature'\n";

describe('merge log', () => {
  describe.each([
    ['merge.log = true', '[merge]\n  log = true\n'],
    ['a valueless merge.log', '[merge]\n  log\n'],
    ['merge.summary = yes', '[merge]\n  summary = yes\n'],
    ['merge.log = 1k', '[merge]\n  log = 1k\n'],
  ])('Given %s and a branch with two commits', (_label, config) => {
    describe('When merged without a message', () => {
      it("Then the message carries git's shortlog of the merged branch", async () => {
        // Arrange
        const ctx = await divergedRepo(config);
        const sut = mergedMessage;

        // Act
        const result = await sut(ctx, { rev: 'feature' });

        // Assert
        expect(result).toBe(SHORTLOG);
      });
    });
  });

  describe.each([
    ['merge.log = 1', '[merge]\n  log = 1\n', {}],
    ['log: 1', '', { log: 1 }],
    ['log: -1 over merge.log = 1', '[merge]\n  log = 1\n', { log: -1 }],
  ])('Given %s and a branch with two commits', (_label, config, options) => {
    describe('When merged', () => {
      it('Then the shortlog counts both commits and elides the second', async () => {
        // Arrange
        const ctx = await divergedRepo(config);
        const sut = mergedMessage;

        // Act
        const result = await sut(ctx, { rev: 'feature', ...options });

        // Assert
        expect(result).toBe("Merge branch 'feature'\n\n* feature: (2 commits)\n  two\n  ...\n");
      });
    });
  });

  describe.each([
    ['log: false over merge.log = true', '[merge]\n  log = true\n', { log: false }],
    ['log: 0 over merge.log = true', '[merge]\n  log = true\n', { log: 0 }],
    ['merge.summary = 1 then merge.log = 0', '[merge]\n  summary = 1\n  log = 0\n', {}],
    ['merge.log = false', '[merge]\n  log = false\n', {}],
    [
      'merge.branchdesc without a log',
      '[merge]\n  branchdesc\n[branch "feature"]\n  description = d\n',
      {},
    ],
  ])('Given %s', (_label, config, options) => {
    describe('When merged', () => {
      it('Then the message is the bare title', async () => {
        // Arrange
        const ctx = await divergedRepo(config);
        const sut = mergedMessage;

        // Act
        const result = await sut(ctx, { rev: 'feature', ...options });

        // Assert
        expect(result).toBe(PLAIN);
      });
    });
  });

  describe('Given log: 1 and a branch with three commits', () => {
    describe('When merged', () => {
      it('Then all three are counted and only the newest is listed', async () => {
        // Arrange
        const ctx = await divergedRepo();
        await checkout(ctx, { rev: 'feature' });
        await commitFile(ctx, 'three.txt', 'three');
        await checkout(ctx, { rev: 'main' });
        const sut = mergedMessage;

        // Act
        const result = await sut(ctx, { rev: 'feature', log: 1 });

        // Assert
        expect(result).toBe("Merge branch 'feature'\n\n* feature: (3 commits)\n  three\n  ...\n");
      });
    });
  });

  describe('Given merge.branchdesc and no description of the merged branch', () => {
    describe('When merged with log: true', () => {
      it('Then the shortlog lists the subjects alone', async () => {
        // Arrange
        const ctx = await divergedRepo('[merge]\n  branchdesc = true\n');
        const sut = mergedMessage;

        // Act
        const result = await sut(ctx, { rev: 'feature', log: true });

        // Assert
        expect(result).toBe(SHORTLOG);
      });
    });
  });

  describe('Given log: true and a message', () => {
    describe('When merged', () => {
      it('Then the shortlog follows the caller message', async () => {
        // Arrange
        const ctx = await divergedRepo();
        const sut = mergedMessage;

        // Act
        const result = await sut(ctx, { rev: 'feature', message: 'custom', log: true });

        // Assert
        expect(result).toBe('custom\n\n* feature:\n  two\n  one\n');
      });
    });
  });

  describe('Given merge.branchdesc and a two-line description of the merged branch', () => {
    describe('When merged with log: true', () => {
      it('Then each description line precedes the subjects', async () => {
        // Arrange
        const ctx = await divergedRepo(
          '[merge]\n  branchdesc = true\n[branch "feature"]\n  description = line1\\nline2\n',
        );
        const sut = mergedMessage;

        // Act
        const result = await sut(ctx, { rev: 'feature', log: true });

        // Assert
        expect(result).toBe(
          "Merge branch 'feature'\n\n* feature:\n  : line1\n  : line2\n  two\n  one\n",
        );
      });
    });
  });

  describe('Given an annotated tag on the merged branch', () => {
    describe('When the tag is merged with log: true', () => {
      it('Then the shortlog names the tag after its message', async () => {
        // Arrange
        const ctx = await divergedRepo();
        await tagCreate(ctx, { name: 'v1', target: 'feature', message: 'tag msg' });
        const sut = mergedMessage;

        // Act
        const result = await sut(ctx, { rev: 'v1', log: true });

        // Assert
        expect(result).toBe("Merge tag 'v1'\n\ntag msg\n\n* tag 'v1':\n  two\n  one\n");
      });
    });
  });

  describe('Given the merged branch carries a merge commit and an empty-subject commit', () => {
    describe('When merged with log: true', () => {
      it("Then the merge is skipped and the empty subject is spelt as the commit's id", async () => {
        // Arrange
        const ctx = await divergedRepo();
        await checkout(ctx, { rev: 'feature' });
        await branchCreate(ctx, { name: 'inner' });
        await checkout(ctx, { rev: 'inner' });
        await commitFile(ctx, 'x.txt', 'xx');
        await checkout(ctx, { rev: 'feature' });
        await mergeRun(ctx, { rev: 'inner', fastForward: 'never', message: 'inner merge', author });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/y.txt`, 'y');
        await add(ctx, ['y.txt']);
        const empty = (await commit(ctx, { message: '', allowEmptyMessage: true, author })).id;
        await checkout(ctx, { rev: 'main' });
        const sut = mergedMessage;

        // Act
        const result = await sut(ctx, { rev: 'feature', log: true });

        // Assert
        expect(result).toBe(
          `Merge branch 'feature'\n\n* feature:\n  ${empty}\n  two\n  xx\n  one\n`,
        );
      });
    });
  });

  describe('Given two branches merged as an octopus with log: true', () => {
    describe('When merged', () => {
      it('Then each head gets its own shortlog block', async () => {
        // Arrange
        const ctx = await divergedRepo();
        await branchCreate(ctx, { name: 'other', startPoint: 'feature~1' });
        await checkout(ctx, { rev: 'other' });
        await commitFile(ctx, 'o.txt', 'oo');
        await checkout(ctx, { rev: 'main' });
        const sut = mergedMessage;

        // Act
        const result = await sut(ctx, { rev: ['feature', 'other'], log: true });

        // Assert
        expect(result).toBe(
          "Merge branches 'feature' and 'other'\n\n* feature:\n  two\n  one\n\n* other:\n  oo\n  one\n",
        );
      });
    });
  });

  describe('Given a merge that conflicts and log: true', () => {
    describe('When merged', () => {
      it('Then MERGE_MSG carries the shortlog before the conflicts block', async () => {
        // Arrange
        const ctx = await divergedRepo();
        await checkout(ctx, { rev: 'feature' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'theirs');
        await add(ctx, ['a.txt']);
        await commit(ctx, { message: 'conflicting', author });
        await checkout(ctx, { rev: 'main' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'ours');
        await add(ctx, ['a.txt']);
        await commit(ctx, { message: 'ours', author });
        const sut = mergeRun;

        // Act
        await sut(ctx, { rev: 'feature', log: true, author });

        // Assert
        const result = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/MERGE_MSG`);
        expect(result).toBe(
          "Merge branch 'feature'\n\n* feature:\n  conflicting\n  two\n  one\n\n# Conflicts:\n#\ta.txt\n",
        );
      });
    });
  });

  describe.each([
    [
      'merge.log = -1',
      '[merge]\n  log = -1\n',
      { code: 'CONFIG_NEGATIVE_LENGTH', key: 'merge.log', value: '-1', line: 5 },
    ],
    [
      'merge.summary = -2',
      '[merge]\n  summary = -2\n',
      { code: 'CONFIG_NEGATIVE_LENGTH', key: 'merge.summary', value: '-2', line: 5 },
    ],
    [
      'a negative merge.log before a valid one',
      '[merge]\n  log = -1\n  log = 3\n',
      { code: 'CONFIG_NEGATIVE_LENGTH', key: 'merge.log', value: '-1', line: 5 },
    ],
    [
      'merge.log = foo',
      '[merge]\n  log = foo\n',
      { code: 'CONFIG_BAD_NUMERIC_VALUE', key: 'merge.log', value: 'foo', reason: 'invalid unit' },
    ],
    [
      'merge.log beyond a C int',
      '[merge]\n  log = 4294967296\n',
      {
        code: 'CONFIG_BAD_NUMERIC_VALUE',
        key: 'merge.log',
        value: '4294967296',
        reason: 'out of range',
      },
    ],
    [
      'merge.branchdesc = maybe',
      '[merge]\n  branchdesc = maybe\n',
      { code: 'CONFIG_BAD_BOOLEAN_VALUE', key: 'merge.branchdesc', value: 'maybe' },
    ],
  ])('Given %s', (_label, config, expected) => {
    describe('When merged', () => {
      it('Then it refuses before merging, as git does', async () => {
        // Arrange
        const ctx = await divergedRepo(config);
        const sut = mergeRun;

        // Act
        const error = await sut(ctx, { rev: 'feature', author }).catch((e: unknown) => e);

        // Assert
        expect((error as TsgitError).data).toMatchObject(expected);
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/ORIG_HEAD`)).toBe(false);
      });
    });
  });

  describe('Given merge.branchdesc and a valueless description of the merged branch', () => {
    describe('When merged with log: true', () => {
      it('Then it refuses with the missing value, as git does', async () => {
        // Arrange
        const ctx = await divergedRepo(
          '[merge]\n  branchdesc\n[branch "feature"]\n  description\n',
        );
        const sut = mergeRun;

        // Act
        const error = await sut(ctx, { rev: 'feature', log: true, author }).catch(
          (e: unknown) => e,
        );

        // Assert
        expect((error as TsgitError).data).toMatchObject({
          code: 'CONFIG_MISSING_VALUE',
          key: 'branch.feature.description',
          line: 7,
        });
      });
    });
  });
});
