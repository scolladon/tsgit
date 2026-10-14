import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import { stashPush } from '../../../../src/application/commands/stash.js';
import { hashBlob } from '../../../../src/application/primitives/hash-blob.js';
import { TsgitError } from '../../../../src/domain/error.js';
import type { AuthorIdentity, ObjectId } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';

const author: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

const T0 = 1_700_000_000_000;
const SETTLE_MS = 10;
const FILE_COUNT = 8;
const AUTOCRLF = '[core]\n\tautocrlf = true\n';
const SAFE_CRLF = `${AUTOCRLF}\tsafecrlf = true\n`;
const OBJECT_FAN_OUT = /^[0-9a-f]{2}$/;

const names = (prefix: string): string[] =>
  Array.from({ length: FILE_COUNT }, (_, i) => `${prefix}${i}.txt`);

const write = (ctx: Context, path: string, content: string): Promise<void> =>
  ctx.fs.writeUtf8(`${ctx.layout.workDir}/${path}`, content);

/** A repo committing every file of `files` with `content`, the clock at T0, then configured. */
const committedRepo = async (
  files: ReadonlyArray<string>,
  content: string,
  config?: string,
): Promise<Context> => {
  vi.setSystemTime(T0);
  const ctx = createMemoryContext();
  await init(ctx);
  for (const file of files) await write(ctx, file, content);
  await add(ctx, [...files]);
  await commit(ctx, { message: 'initial', author });
  if (config !== undefined) await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, config);
  return ctx;
};

/** Holds the first `take` work-tree reads (or lstats) SETTLE_MS each and records the most that overlapped. */
interface Overlap {
  readonly ctx: Context;
  readonly peak: () => number;
  readonly reads: (suffix: string) => number;
}

const observed = (ctx: Context, method: 'read' | 'lstat', take = FILE_COUNT): Overlap => {
  let held = 0;
  let inFlight = 0;
  let peak = 0;
  const counts = new Map<string, number>();
  const proxied = new Proxy(ctx.fs, {
    get(target, prop, receiver) {
      if (prop !== method) return Reflect.get(target, prop, receiver);
      return async (path: string) => {
        counts.set(path, (counts.get(path) ?? 0) + 1);
        if (!path.includes('/.git/') && held < take) {
          held += 1;
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise((r) => setTimeout(r, SETTLE_MS));
          inFlight -= 1;
        }
        return method === 'read' ? target.read(path) : target.lstat(path);
      };
    },
  });
  return {
    ctx: { ...ctx, fs: proxied },
    peak: () => peak,
    reads: (suffix) =>
      [...counts].filter(([path]) => path.endsWith(suffix)).reduce((n, [, c]) => n + c, 0),
  };
};

/** Delays the read of `slowPath`, so its bytes arrive after every other path's. */
const withSlowRead = (ctx: Context, slowPath: string): Context => ({
  ...ctx,
  fs: new Proxy(ctx.fs, {
    get(target, prop, receiver) {
      if (prop !== 'read') return Reflect.get(target, prop, receiver);
      return async (path: string) => {
        if (path.endsWith(slowPath)) await new Promise((r) => setTimeout(r, SETTLE_MS * 5));
        return target.read(path);
      };
    },
  }),
});

const looseObjectIds = async (ctx: Context): Promise<ReadonlySet<ObjectId>> => {
  const objects = `${ctx.layout.gitDir}/objects`;
  const fanOuts = (await ctx.fs.readdir(objects)).filter((e) => OBJECT_FAN_OUT.test(e.name));
  const perFanOut = await Promise.all(
    fanOuts.map(async ({ name }) =>
      (await ctx.fs.readdir(`${objects}/${name}`)).map((e) => `${name}${e.name}` as ObjectId),
    ),
  );
  return new Set(perFanOut.flat());
};

const blobId = (ctx: Context, content: string): Promise<ObjectId> =>
  hashBlob(ctx, new TextEncoder().encode(content), { write: false });

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('stash push work-tree pool', () => {
  describe('Given a stat-clean, non-racy tracked file', () => {
    describe('When stashPush', () => {
      it('Then the file is never read during classification', async () => {
        // Arrange
        vi.useFakeTimers({ toFake: ['Date'] });
        const base = await committedRepo(['a.txt'], 'committed\n');
        vi.setSystemTime(T0 + 10_000);
        await write(base, 'b.txt', 'other\n');
        await add(base, ['b.txt']);
        const watched = observed(base, 'read');
        const sut = stashPush;

        // Act
        await sut(watched.ctx, {});

        // Assert
        expect(watched.reads('/a.txt')).toBe(0);
      });
    });
  });

  describe('Given 8 modified tracked files behind a slow lstat proxy', () => {
    describe('When stashPush', () => {
      it('Then more than one comparison is in flight', async () => {
        // Arrange
        vi.useFakeTimers({ toFake: ['Date'] });
        const files = names('t');
        const base = await committedRepo(files, 'committed\n');
        vi.setSystemTime(T0 + 10_000);
        for (const file of files) await write(base, file, `modified ${file}\n`);
        const watched = observed(base, 'lstat');
        const sut = stashPush;

        // Act
        await sut(watched.ctx, {});

        // Assert
        expect(watched.peak()).toBeGreaterThan(1);
      });
    });
  });

  describe('Given 8 modified tracked files behind a slow read proxy', () => {
    describe('When stashPush projects the working tree', () => {
      it('Then more than one hash is in flight in projectWorkingTree', async () => {
        // Arrange
        vi.useFakeTimers({ toFake: ['Date'] });
        const files = names('t');
        const base = await committedRepo(files, 'committed\n');
        vi.setSystemTime(T0 + 10_000);
        for (const file of files) await write(base, file, `modified ${file}\n`);
        const watched = observed(base, 'read');
        const sut = stashPush;

        // Act
        await sut(watched.ctx, {});

        // Assert
        expect(watched.peak()).toBeGreaterThan(1);
      });
    });
  });

  describe('Given 8 untracked files behind a slow read proxy', () => {
    describe('When stashPush includes untracked', () => {
      it('Then more than one hash is in flight in hashUntracked', async () => {
        // Arrange
        vi.useFakeTimers({ toFake: ['Date'] });
        const base = await committedRepo(['a.txt'], 'committed\n');
        for (const file of names('u')) await write(base, file, `untracked ${file}\n`);
        const watched = observed(base, 'read');
        const sut = stashPush;

        // Act
        await sut(watched.ctx, { includeUntracked: true });

        // Assert
        expect(watched.peak()).toBeGreaterThan(1);
      });
    });
  });
});

describe('stash push refusal order under the pool', () => {
  describe('Given core.safecrlf true and two lossy untracked files, the first read slow', () => {
    describe('When stashPush includes untracked', () => {
      it('Then the refusal names the first file and no object is written for the second', async () => {
        // Arrange
        const base = await committedRepo(['a.txt'], 'a\nb\n', SAFE_CRLF);
        await write(base, 'u0.txt', 'first\n');
        await write(base, 'u1.txt', 'second\n');
        const ctx = withSlowRead(base, '/u0.txt');
        const sut = stashPush;

        // Act
        const error = await sut(ctx, { includeUntracked: true }).then(
          () => undefined,
          (e: unknown) => e,
        );

        // Assert
        expect(error).toBeInstanceOf(TsgitError);
        expect((error as TsgitError).data).toMatchObject({
          code: 'EOL_ROUND_TRIP_UNSAFE',
          path: 'u0.txt',
        });
        expect((await looseObjectIds(base)).has(await blobId(base, 'second\n'))).toBe(false);
      });
    });
  });

  describe('Given core.safecrlf true, a lossy first untracked file read slow and a safe second', () => {
    describe('When stashPush includes untracked', () => {
      it('Then the refusal names the first file and the second is never written', async () => {
        // Arrange
        const base = await committedRepo(['a.txt'], 'a\nb\n', SAFE_CRLF);
        await write(base, 'u0.txt', 'first\n');
        await write(base, 'u1.txt', 'second\r\n');
        const ctx = withSlowRead(base, '/u0.txt');
        const sut = stashPush;

        // Act
        const error = await sut(ctx, { includeUntracked: true }).then(
          () => undefined,
          (e: unknown) => e,
        );

        // Assert
        expect(error).toBeInstanceOf(TsgitError);
        expect((error as TsgitError).data).toMatchObject({
          code: 'EOL_ROUND_TRIP_UNSAFE',
          path: 'u0.txt',
        });
        expect((await looseObjectIds(base)).has(await blobId(base, 'second\n'))).toBe(false);
      });
    });
  });

  describe('Given core.autocrlf true and two LF untracked files, the first read slow', () => {
    describe('When stashPush includes untracked', () => {
      it('Then the eol notices follow the input order', async () => {
        // Arrange
        const base = await committedRepo(['a.txt'], 'a\nb\n', AUTOCRLF);
        await write(base, 'u0.txt', 'first\n');
        await write(base, 'u1.txt', 'second\n');
        const ctx = withSlowRead(base, '/u0.txt');
        const sut = stashPush;

        // Act
        const result = await sut(ctx, { includeUntracked: true });

        // Assert
        if (result.kind !== 'saved') throw new Error('expected saved');
        expect(result.eolNotices.map((n) => n.path)).toEqual(['u0.txt', 'u1.txt']);
      });
    });
  });
});
