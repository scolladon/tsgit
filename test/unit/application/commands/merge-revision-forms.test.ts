import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { branchCreate } from '../../../../src/application/commands/branch.js';
import { checkout } from '../../../../src/application/commands/checkout.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import { mergeRun } from '../../../../src/application/commands/merge.js';
import { tagCreate } from '../../../../src/application/commands/tag.js';
import * as readObjectModule from '../../../../src/application/primitives/read-object.js';
import { readObject } from '../../../../src/application/primitives/read-object.js';
import { resolveRef } from '../../../../src/application/primitives/resolve-ref.js';
import { permissionDenied, type TsgitError } from '../../../../src/domain/error.js';
import type { AuthorIdentity, ObjectId, RefName } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';
import { writeRawObjectBytes } from '../primitives/fixtures.js';

const author: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

const commitFile = async (ctx: Context, path: string): Promise<void> => {
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/${path}`, `${path}\n`);
  await add(ctx, [path]);
  await commit(ctx, { message: path, author });
};

/** base; side: g, h + annotated tag v1 at its tip; main: m. HEAD on main. */
const seed = async (): Promise<{ ctx: Context; tagOid: ObjectId }> => {
  const ctx = createMemoryContext();
  await init(ctx);
  await ctx.fs.appendUtf8(`${ctx.layout.gitDir}/config`, '\n[user]\n\tname = Ada\n\temail = a@x\n');
  await commitFile(ctx, 'f');
  await branchCreate(ctx, { name: 'side' });
  await checkout(ctx, { rev: 'side' });
  await commitFile(ctx, 'g');
  await commitFile(ctx, 'h');
  await tagCreate(ctx, { name: 'v1', message: 'v1' });
  await checkout(ctx, { rev: 'main' });
  await commitFile(ctx, 'm');
  return { ctx, tagOid: await resolveRef(ctx, 'refs/tags/v1' as RefName) };
};

const subjectOf = async (ctx: Context, id: ObjectId): Promise<string> => {
  const object = await readObject(ctx, id);
  if (object.type !== 'commit') throw new Error(`not a commit: ${id}`);
  return object.data.message.split('\n')[0] ?? '';
};

describe('merge names each revision form as git does', () => {
  describe.each([
    [
      'the full oid of an annotated tag',
      (tag: ObjectId) => tag,
      (tag: ObjectId) => `Merge tag '${tag}'`,
    ],
    [
      'an abbreviated annotated-tag oid',
      (tag: ObjectId) => tag.slice(0, 7),
      (tag: ObjectId) => `Merge tag '${tag.slice(0, 7)}'`,
    ],
    ['<branch>~1', () => 'side~1', () => "Merge branch 'side' (early part)"],
    ['<branch>^', () => 'side^', () => "Merge branch 'side' (early part)"],
    ['<branch>~0', () => 'side~0', () => "Merge branch 'side'"],
    [
      'the tag oid stepped back as <oid>~1',
      (tag: ObjectId) => `${tag}~1`,
      (tag: ObjectId) => `Merge commit '${tag}~1'`,
    ],
  ])('Given %s', (_label, argOf, subject) => {
    describe('When merge', () => {
      it("Then it merges with git's title", async () => {
        // Arrange
        const { ctx, tagOid } = await seed();
        const sut = mergeRun;

        // Act
        const result = await sut(ctx, { rev: argOf(tagOid), author });

        // Assert
        expect(result.kind).toBe('merge');
        if (result.kind !== 'merge') return;
        expect(await subjectOf(ctx, result.id)).toBe(subject(tagOid));
      });
    });
  });

  describe.each(['@{-1}', '-'])('Given the previous branch named as %s', (arg) => {
    describe('When merge', () => {
      it('Then it merges that branch under its name', async () => {
        // Arrange
        const { ctx } = await seed();
        await checkout(ctx, { rev: 'side' });
        await checkout(ctx, { rev: 'main' });
        const sut = mergeRun;

        // Act
        const result = await sut(ctx, { rev: arg, author });

        // Assert
        expect(result.kind).toBe('merge');
        if (result.kind !== 'merge') return;
        expect(await subjectOf(ctx, result.id)).toBe("Merge branch 'side'");
      });
    });
  });

  describe('Given a lone dash among several revisions', () => {
    describe('When merge', () => {
      it('Then the dash is no shorthand and names nothing to merge', async () => {
        // Arrange
        const { ctx } = await seed();
        await checkout(ctx, { rev: 'side' });
        await checkout(ctx, { rev: 'main' });
        const sut = mergeRun;

        // Act
        const result = await sut(ctx, { rev: ['-', 'side'], author }).then(
          () => undefined,
          (e: unknown) => (e as TsgitError).data,
        );

        // Assert
        expect(result).toEqual({ code: 'REF_NOT_FOUND', name: '-' });
      });
    });
  });

  describe('Given the id of a tree', () => {
    describe('When merge', () => {
      it('Then it is not something we can merge', async () => {
        // Arrange
        const { ctx } = await seed();
        const side = await resolveRef(ctx, 'refs/heads/side' as RefName);
        const tree = (await readObject(ctx, side)) as { data: { tree: ObjectId } };
        const sut = mergeRun;

        // Act
        const result = await sut(ctx, { rev: tree.data.tree, author }).then(
          () => undefined,
          (e: unknown) => (e as TsgitError).data,
        );

        // Assert
        expect(result).toEqual({ code: 'REF_NOT_FOUND', name: tree.data.tree });
      });
    });
  });
});

describe.each([
  { variant: 'non-hex', target: 'z'.repeat(40), bare: false },
  { variant: 'truncated', target: 'abc', bare: false },
  { variant: 'absent', target: 'a'.repeat(40), bare: false },
  { variant: 'missing', target: 'b'.repeat(40), bare: true },
])('Given a tag ref x naming a $variant object', ({ target, bare }) => {
  describe.each([{ rev: 'x' }, { rev: ['side', 'x'] }])('When merge takes $rev', ({ rev }) => {
    it('Then it refuses REF_NOT_FOUND { name: x }', async () => {
      // Arrange
      const { ctx } = await seed();
      const body = `object ${target}\ntype commit\ntag x\ntagger A <a@x> 1700000000 +0000\n\nmsg\n`;
      const tagId = await writeRawObjectBytes(ctx, 'tag', new TextEncoder().encode(body));
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/tags/x`, `${bare ? target : tagId}\n`);
      const sut = mergeRun;

      // Act
      const result = await sut(ctx, { rev, author }).then(
        () => undefined,
        (e: unknown) => (e as TsgitError).data,
      );

      // Assert
      expect(result).toEqual({ code: 'REF_NOT_FOUND', name: 'x' });
    });
  });
});

const FANOUT = '/objects/ab';
const UNABLE_TO_OPEN = 'unable to open';
const AMBIGUOUS = 'is ambiguous';
const READ_TWICE = 2;
const READ_THRICE = 3;
const TWO_PARENTS_READ_TWICE_EACH = 5;

interface CountedContext {
  readonly ctx: Context;
  /** Makes the `ab` fanout refuse to list, as a mode-000 directory does, from now on. */
  readonly arm: () => void;
  readonly errors: () => number;
  readonly warnings: () => number;
}

/**
 * A context whose `ab` fanout can be made to refuse listing after seeding (the object store
 * binds the file system on first use) and whose unable-to-open and ambiguity logs are counted.
 */
const countedContext = (): CountedContext => {
  const base = createMemoryContext();
  let armed = false;
  let errors = 0;
  let warnings = 0;
  const ctx: Context = {
    ...base,
    fs: {
      ...base.fs,
      readdir: async (path: string) => {
        if (armed && path.endsWith(FANOUT)) throw permissionDenied(path);
        return base.fs.readdir(path);
      },
    },
    logger: {
      error: (message) => {
        if (message.startsWith(UNABLE_TO_OPEN)) errors += 1;
      },
      warn: (message) => {
        if (message.includes(AMBIGUOUS)) warnings += 1;
      },
    },
  };
  return {
    ctx,
    arm: () => {
      armed = true;
    },
    errors: () => errors,
    warnings: () => warnings,
  };
};

/** main holds f; each named branch adds one commit of its own on top of it. HEAD on main. */
const seedAheadBranches = async (ctx: Context, names: ReadonlyArray<string>): Promise<void> => {
  await init(ctx);
  await ctx.fs.appendUtf8(`${ctx.layout.gitDir}/config`, '\n[user]\n\tname = Ada\n\temail = a@x\n');
  await commitFile(ctx, 'f');
  for (const name of names) {
    await branchCreate(ctx, { name });
    await checkout(ctx, { rev: name });
    await commitFile(ctx, `${name}.txt`);
    await checkout(ctx, { rev: 'main' });
  }
  await expect(ctx.fs.readdir(`${ctx.layout.gitDir}${FANOUT}`)).rejects.toMatchObject({
    data: { code: 'FILE_NOT_FOUND' },
  });
};

/** A counted context seeded with `names` ahead of main, its fanout armed. */
const armedAhead = async (names: ReadonlyArray<string>): Promise<CountedContext> => {
  const counted = countedContext();
  await seedAheadBranches(counted.ctx, names);
  counted.arm();
  return counted;
};

describe('Given a branch abcd ahead of main whose fanout directory cannot be listed', () => {
  describe.each([
    { shape: 'by default', options: {} },
    { shape: 'with fastForward only', options: { fastForward: 'only' as const } },
    { shape: 'with fastForward never', options: { fastForward: 'never' as const } },
    { shape: 'with squash', options: { squash: true } },
  ])('When merge abcd runs without a message, $shape', ({ options }) => {
    it('Then it logs the unable-to-open line three times, once per read git makes', async () => {
      // Arrange
      const { ctx, errors } = await armedAhead(['abcd']);
      const sut = mergeRun;

      // Act
      await sut(ctx, { rev: 'abcd', author, ...options });

      // Assert
      expect(errors()).toBe(READ_THRICE);
    });
  });

  describe('When merge abcd runs with heads a caller described', () => {
    it('Then it logs the unable-to-open line twice, the described parent not read again', async () => {
      // Arrange
      const { ctx, errors } = await armedAhead(['abcd']);
      const id = await resolveRef(ctx, 'refs/heads/abcd' as RefName);
      const sut = mergeRun;

      // Act
      await sut(ctx, { rev: 'abcd', author }, { heads: [{ id, description: "branch 'abcd'" }] });

      // Assert
      expect(errors()).toBe(READ_TWICE);
    });
  });

  describe('When merge abcd runs with a message', () => {
    it('Then it logs the unable-to-open line twice, the name read once', async () => {
      // Arrange
      const { ctx, errors } = await armedAhead(['abcd']);
      const sut = mergeRun;

      // Act
      await sut(ctx, { rev: 'abcd', message: 'm', author });

      // Assert
      expect(errors()).toBe(READ_TWICE);
    });
  });

  describe('When merge abcd abce runs without a message', () => {
    it('Then it logs the unable-to-open line five times, each parent read twice', async () => {
      // Arrange
      const { ctx, errors } = await armedAhead(['abcd', 'abce']);
      const sut = mergeRun;

      // Act
      await sut(ctx, { rev: ['abcd', 'abce'], author });

      // Assert
      expect(errors()).toBe(TWO_PARENTS_READ_TWICE_EACH);
    });
  });
});

describe('Given a branch abcd at main whose fanout directory cannot be listed', () => {
  describe('When merge abcd runs without a message', () => {
    it('Then it logs the unable-to-open line twice, a subsumed parent read once', async () => {
      // Arrange
      const counted = countedContext();
      await seedAheadBranches(counted.ctx, []);
      await branchCreate(counted.ctx, { name: 'abcd' });
      counted.arm();
      const sut = mergeRun;

      // Act
      const result = await sut(counted.ctx, { rev: 'abcd', author });

      // Assert
      expect(result.kind).toBe('up-to-date');
      expect(counted.errors()).toBe(READ_TWICE);
    });
  });
});

describe('Given a branch abcd behind main whose fanout directory cannot be listed', () => {
  describe('When merge abcd runs without a message', () => {
    it('Then it logs the unable-to-open line twice, a subsumed parent read once', async () => {
      // Arrange
      const counted = countedContext();
      await seedAheadBranches(counted.ctx, []);
      await branchCreate(counted.ctx, { name: 'abcd' });
      await commitFile(counted.ctx, 'm');
      counted.arm();
      const sut = mergeRun;

      // Act
      const result = await sut(counted.ctx, { rev: 'abcd', author });

      // Assert
      expect(result.kind).toBe('up-to-date');
      expect(counted.errors()).toBe(READ_TWICE);
    });
  });
});

describe('Given a tag x and a branch x at a commit ahead of main', () => {
  describe('When merge x runs without a message', () => {
    it('Then it warns the ambiguity twice, once per read git makes', async () => {
      // Arrange
      const counted = countedContext();
      await seedAheadBranches(counted.ctx, ['x']);
      await counted.ctx.fs.writeUtf8(
        `${counted.ctx.layout.gitDir}/refs/tags/x`,
        `${await resolveRef(counted.ctx, 'refs/heads/x' as RefName)}\n`,
      );
      const { ctx, warnings } = counted;
      const sut = mergeRun;

      // Act
      await sut(ctx, { rev: 'x', author });

      // Assert
      expect(warnings()).toBe(READ_TWICE);
    });
  });

  describe('When merge x runs with a message', () => {
    it('Then it warns the ambiguity once', async () => {
      // Arrange
      const counted = countedContext();
      await seedAheadBranches(counted.ctx, ['x']);
      await counted.ctx.fs.writeUtf8(
        `${counted.ctx.layout.gitDir}/refs/tags/x`,
        `${await resolveRef(counted.ctx, 'refs/heads/x' as RefName)}\n`,
      );
      const { ctx, warnings } = counted;
      const sut = mergeRun;

      // Act
      await sut(ctx, { rev: 'x', message: 'm', author });

      // Assert
      expect(warnings()).toBe(1);
    });
  });
});

describe('Given a merge parent whose tag object read fails without an error code', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('When merge takes the tag', () => {
    it('Then the failure propagates unchanged', async () => {
      // Arrange
      const { ctx, tagOid } = await seed();
      const failure = new Error('boom');
      const original = readObjectModule.readObject;
      vi.spyOn(readObjectModule, 'readObject').mockImplementation((c, id) =>
        id === tagOid ? Promise.reject(failure) : original(c, id),
      );
      const sut = mergeRun;

      // Act
      const caught = await sut(ctx, { rev: 'v1', author }).catch((error: unknown) => error);

      // Assert
      expect(caught).toBe(failure);
    });
  });
});
