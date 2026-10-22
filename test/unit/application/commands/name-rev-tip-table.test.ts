import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { describe as describeCommand } from '../../../../src/application/commands/describe.js';
import { init } from '../../../../src/application/commands/init.js';
import { nameRev } from '../../../../src/application/commands/name-rev.js';
import { evaluateRevision } from '../../../../src/application/commands/rev-parse.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { errorDataCode } from '../../../../src/domain/error-data-code.js';
import type { AuthorIdentity, ObjectId, TagData } from '../../../../src/domain/objects/index.js';
import { RefName } from '../../../../src/domain/objects/object-id.js';
import { computeLooseObjectPath } from '../../../../src/domain/storage/loose-path.js';
import type { Context } from '../../../../src/ports/context.js';
import { writeForgedTagLoop, writeRawObjectBytes } from '../primitives/fixtures.js';

const COMMIT_TIME = 1_700_000_000;
const MISSING_OID = '1234567890123456789012345678901234567890' as ObjectId;
const encoder = new TextEncoder();

const ident = (timestamp: number): AuthorIdentity => ({
  name: 'A U Thor',
  email: 'author@example.com',
  timestamp,
  timezoneOffset: '+0000',
});

/** One logged line: its level, the constant message, the variable parts in its context. */
interface LogRecord {
  readonly level: 'info' | 'error';
  readonly message: string;
  readonly context: Readonly<Record<string, unknown>> | undefined;
}

type LogContext = Readonly<Record<string, unknown>> | undefined;

interface Seeded {
  readonly ctx: Context;
  readonly logs: LogRecord[];
  readonly head: ObjectId;
}

const seed = async (): Promise<Seeded> => {
  const logs: LogRecord[] = [];
  const ctx = {
    ...createMemoryContext(),
    logger: {
      info: (message: string, context?: LogContext) =>
        logs.push({ level: 'info', message, context }),
      error: (message: string, context?: LogContext) =>
        logs.push({ level: 'error', message, context }),
    },
  } as Context;
  await init(ctx);
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a\n');
  await add(ctx, ['a.txt']);
  const result = await commit(ctx, {
    message: 'c1',
    author: ident(COMMIT_TIME),
    committer: ident(COMMIT_TIME),
  });
  return { ctx, logs, head: result.id };
};

/** A ref file written straight to disk, as a corrupt repository can hold it. */
const plantRef = (ctx: Context, name: string, target: ObjectId): Promise<void> =>
  ctx.fs.writeUtf8(`${ctx.layout.gitDir}/${name}`, `${target}\n`);

const writeTag = (
  ctx: Context,
  name: string,
  target: ObjectId,
  objectType: TagData['objectType'],
  taggerTime: number,
): Promise<ObjectId> => {
  const data: TagData = {
    object: target,
    objectType,
    tagName: name,
    tagger: ident(taggerTime),
    message: `${name}\n`,
    extraHeaders: [],
  };
  return writeObject(ctx, { type: 'tag', id: '' as ObjectId, data });
};

const annotatedTag = async (ctx: Context, name: string, target: ObjectId): Promise<ObjectId> => {
  const id = await writeTag(ctx, name, target, 'commit', COMMIT_TIME);
  await plantRef(ctx, `refs/tags/${name}`, id);
  return id;
};

const rawTag = (ctx: Context, target: ObjectId, type: string): Promise<ObjectId> =>
  writeRawObjectBytes(ctx, 'tag', encoder.encode(`object ${target}\ntype ${type}\ntag x\n\nx\n`));

/** Plants an unreadable naming ref; answers the `error:` lines its parse logs. */
type Planter = (ctx: Context) => Promise<ReadonlyArray<LogRecord>>;

const badObject = (id: ObjectId, code: string, reason: string): LogRecord => ({
  level: 'error',
  message: 'bad object',
  context: { id, code, reason },
});

const plantMalformedCommitTag: Planter = async (ctx) => {
  const malformed = await writeRawObjectBytes(ctx, 'commit', encoder.encode('not a commit\n'));
  await plantRef(ctx, 'refs/tags/a-malformed', await rawTag(ctx, malformed, 'commit'));
  return [badObject(malformed, 'INVALID_COMMIT', 'INVALID_COMMIT: first line must be tree')];
};

const plantBogusTypeTag: Planter = async (ctx) => {
  const bogus = await rawTag(ctx, MISSING_OID, 'bogus');
  await plantRef(ctx, 'refs/tags/a-bogus', bogus);
  return [badObject(bogus, 'INVALID_TAG', 'INVALID_TAG: invalid object type: bogus')];
};

const UNREADABLE_TIPS: ReadonlyArray<{ readonly label: string; readonly plant: Planter }> = [
  {
    label: 'a dangling branch',
    plant: async (ctx) => {
      await plantRef(ctx, 'refs/heads/dangling', MISSING_OID);
      return [];
    },
  },
  { label: 'a tag of an unknown type', plant: plantBogusTypeTag },
  { label: 'a tag of a malformed commit', plant: plantMalformedCommitTag },
  {
    label: 'a tag naming itself',
    plant: async (ctx) => {
      await plantRef(ctx, 'refs/tags/a-loop', await writeForgedTagLoop(ctx));
      return [];
    },
  },
];

describe('nameRev tip table', () => {
  describe.each(UNREADABLE_TIPS)('Given $label beside an annotated tag', ({ plant }) => {
    describe('When nameRev names the tagged commit', () => {
      it('Then it skips the unreadable ref and names the commit by the tag', async () => {
        // Arrange
        const { ctx, logs, head } = await seed();
        await annotatedTag(ctx, 'v1', head);
        const expectedLogs = await plant(ctx);
        const sut = nameRev;

        // Act
        const result = await sut(ctx, 'HEAD');

        // Assert
        expect(result).toEqual({
          oid: head,
          ref: RefName.from('refs/tags/v1'),
          tagDeref: true,
          steps: [],
          abbreviated: false,
        });
        expect(logs).toEqual(expectedLogs);
      });
    });
  });

  describe('Given a dated annotated tag and a tagger-less one on the same commit', () => {
    describe('When nameRev names the commit', () => {
      it('Then the tagger-less tag wins as dated before every other tag', async () => {
        // Arrange
        const { ctx, head } = await seed();
        await annotatedTag(ctx, 'a-dated', head);
        await plantRef(ctx, 'refs/tags/b-undated', await rawTag(ctx, head, 'commit'));
        const sut = nameRev;

        // Act
        const result = await sut(ctx, 'HEAD');

        // Assert
        expect(result?.ref).toBe('refs/tags/b-undated');
      });
    });
  });

  describe('Given an annotated tag of a commit', () => {
    describe('When nameRev names the tag object', () => {
      it('Then it names the tag itself by its exact ref, not the commit', async () => {
        // Arrange
        const { ctx, head } = await seed();
        const tag = await annotatedTag(ctx, 'tc', head);
        const sut = nameRev;

        // Act
        const result = await sut(ctx, 'tc');

        // Assert
        expect(result).toEqual({
          oid: tag,
          ref: RefName.from('refs/tags/tc'),
          tagDeref: false,
          steps: [],
          abbreviated: false,
        });
      });
    });
  });

  describe('Given a lightweight tag of a tree', () => {
    describe('When nameRev names the tree by its id', () => {
      it('Then it names the tree by the tag pointing straight at it', async () => {
        // Arrange
        const { ctx } = await seed();
        const tree = await evaluateRevision(ctx, 'HEAD^{tree}');
        await plantRef(ctx, 'refs/tags/lt', tree);
        const sut = nameRev;

        // Act
        const result = await sut(ctx, tree);

        // Assert
        expect(result).toEqual({
          oid: tree,
          ref: RefName.from('refs/tags/lt'),
          tagDeref: false,
          steps: [],
          abbreviated: false,
        });
      });
    });

    describe('When nameRev names it under a refs filter the tag fails', () => {
      it('Then the tree is unnamed, as the filter drops the tag from the tip table', async () => {
        // Arrange
        const { ctx } = await seed();
        const tree = await evaluateRevision(ctx, 'HEAD^{tree}');
        await plantRef(ctx, 'refs/tags/lt', tree);
        const sut = nameRev;

        // Act
        const result = await sut(ctx, tree, { refs: 'refs/heads/*' });

        // Assert
        expect(result).toEqual({
          oid: tree,
          ref: undefined,
          tagDeref: false,
          steps: [],
          abbreviated: false,
        });
      });
    });

    describe('When describe --contains names the tree', () => {
      it('Then it skips the tree with the note git prints for a rev with no commit', async () => {
        // Arrange
        const { ctx, logs } = await seed();
        const tree = await evaluateRevision(ctx, 'HEAD^{tree}');
        await plantRef(ctx, 'refs/tags/lt', tree);
        const sut = describeCommand;

        // Act
        const result = await sut(ctx, 'lt', { contains: true });

        // Assert
        expect(result).toBeUndefined();
        expect(logs).toEqual([
          { level: 'info', message: 'Could not get commit for lt. Skipping.', context: undefined },
        ]);
      });
    });
  });

  describe('Given an annotated tag of HEAD', () => {
    describe('When describe --contains runs with no revision', () => {
      it('Then it names HEAD through the peeled tag', async () => {
        // Arrange
        const { ctx, head } = await seed();
        await annotatedTag(ctx, 'tc', head);
        const sut = describeCommand;

        // Act
        const result = await sut(ctx, undefined, { contains: true });

        // Assert
        expect(result).toEqual({
          oid: head,
          ref: RefName.from('refs/tags/tc'),
          tagDeref: true,
          steps: [],
          abbreviated: false,
        });
      });
    });
  });

  describe('Given a blob no ref points at', () => {
    describe('When nameRev names it', () => {
      it('Then it answers the blob unnamed', async () => {
        // Arrange
        const { ctx } = await seed();
        const blob = await evaluateRevision(ctx, 'HEAD:a.txt');
        const sut = nameRev;

        // Act
        const result = await sut(ctx, blob);

        // Assert
        expect(result).toEqual({
          oid: blob,
          ref: undefined,
          tagDeref: false,
          steps: [],
          abbreviated: false,
        });
      });
    });
  });

  describe('Given a tag whose outer tagger is oldest but whose innermost tagger is newest', () => {
    describe('When nameRev names the commit both tag chains reach', () => {
      it('Then it ranks the chain by its innermost tagger date, as git does', async () => {
        // Arrange
        const { ctx, head } = await seed();
        const inner = await writeTag(ctx, 'inner', head, 'commit', 5000);
        await plantRef(ctx, 'refs/tags/A', await writeTag(ctx, 'A', inner, 'tag', 1000));
        await plantRef(ctx, 'refs/tags/B', await writeTag(ctx, 'B', head, 'commit', 3000));
        const sut = nameRev;

        // Act
        const result = await sut(ctx, 'HEAD');

        // Assert
        expect(result?.ref).toBe('refs/tags/B');
      });
    });
  });

  describe('Given a naming ref whose loose object is not zlib data', () => {
    describe('When nameRev names a commit', () => {
      it('Then it refuses as git dies on a corrupt loose object', async () => {
        // Arrange
        const { ctx } = await seed();
        await ctx.fs.write(
          `${ctx.layout.gitDir}/objects/${computeLooseObjectPath(MISSING_OID)}`,
          encoder.encode('garbage'),
        );
        await plantRef(ctx, 'refs/heads/corrupt', MISSING_OID);
        const sut = nameRev;

        // Act
        const error = await sut(ctx, 'HEAD').catch((caught: unknown) => caught);

        // Assert
        expect(errorDataCode(error)).toBe('DECOMPRESS_FAILED');
      });
    });
  });
});
