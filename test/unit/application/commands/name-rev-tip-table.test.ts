import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import { nameRev } from '../../../../src/application/commands/name-rev.js';
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

interface Seeded {
  readonly ctx: Context;
  readonly logs: string[];
  readonly head: ObjectId;
}

const seed = async (): Promise<Seeded> => {
  const logs: string[] = [];
  const ctx = {
    ...createMemoryContext(),
    logger: { error: (message: string) => logs.push(`error: ${message}`) },
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

const annotatedTag = async (ctx: Context, name: string, target: ObjectId): Promise<ObjectId> => {
  const data: TagData = {
    object: target,
    objectType: 'commit',
    tagName: name,
    tagger: ident(COMMIT_TIME),
    message: `${name}\n`,
    extraHeaders: [],
  };
  const id = await writeObject(ctx, { type: 'tag', id: '' as ObjectId, data });
  await plantRef(ctx, `refs/tags/${name}`, id);
  return id;
};

const rawTag = (ctx: Context, target: ObjectId, type: string): Promise<ObjectId> =>
  writeRawObjectBytes(ctx, 'tag', encoder.encode(`object ${target}\ntype ${type}\ntag x\n\nx\n`));

/** Plants an unreadable naming ref; answers the `error:` lines its parse logs. */
type Planter = (ctx: Context) => Promise<ReadonlyArray<string>>;

const plantMalformedCommitTag: Planter = async (ctx) => {
  const malformed = await writeRawObjectBytes(ctx, 'commit', encoder.encode('not a commit\n'));
  await plantRef(ctx, 'refs/tags/a-malformed', await rawTag(ctx, malformed, 'commit'));
  return [`error: bad object ${malformed}: INVALID_COMMIT: first line must be tree`];
};

const plantBogusTypeTag: Planter = async (ctx) => {
  const bogus = await rawTag(ctx, MISSING_OID, 'bogus');
  await plantRef(ctx, 'refs/tags/a-bogus', bogus);
  return [`error: bad object ${bogus}: INVALID_TAG: invalid object type: bogus`];
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
