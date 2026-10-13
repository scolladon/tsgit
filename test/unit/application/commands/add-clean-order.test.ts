import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { serializeAndHash } from '../../../../src/application/primitives/internal/serialize-and-hash.js';
import { TsgitError } from '../../../../src/domain/index.js';
import type { ObjectId } from '../../../../src/domain/objects/object-id.js';
import type { Context } from '../../../../src/ports/context.js';
import { seedRepo } from './fixtures.js';

const LOG_DRIVER = '[filter "log"]\n\tclean = log\n';
const SETTLE_MS = 20;
const WATCHDOG_MS = 2_000;

const dec = (bytes: Uint8Array | undefined): string =>
  new TextDecoder().decode(bytes ?? new Uint8Array());

interface Recorded {
  readonly ctx: Context;
  readonly cleaned: string[];
}

interface Driver {
  readonly config: string;
  readonly exitCode: number;
}

const LOGGING: Driver = { config: LOG_DRIVER, exitCode: 0 };
const REQUIRED_FAILING: Driver = {
  config: '[filter "log"]\n\tclean = log\n\trequired = true\n',
  exitCode: 1,
};

/**
 * A repo whose `log` clean driver records the content of each file it hears, in call order.
 * `tracked` paths are staged first, then rewritten with a `2` suffix so the next add cleans them again.
 */
const repoUnderLogDriver = async (
  workingTree: Readonly<Record<string, string>>,
  attributes: string,
  { driver = LOGGING, tracked = [] }: { driver?: Driver; tracked?: ReadonlyArray<string> } = {},
): Promise<Recorded> => {
  const base = createMemoryContext();
  await seedRepo(base, { workingTree });
  await base.fs.writeUtf8(`${base.layout.workDir}/.gitattributes`, attributes);
  if (tracked.length > 0) await add(base, tracked);
  await base.fs.writeUtf8(`${base.layout.gitDir}/config`, driver.config);
  for (const path of tracked) {
    await base.fs.writeUtf8(`${base.layout.workDir}/${path}`, `${workingTree[path]}2`);
  }
  const cleaned: string[] = [];
  const command = {
    run: async (request: { readonly stdin?: Uint8Array }) => {
      cleaned.push(dec(request.stdin));
      return { exitCode: driver.exitCode, stdout: request.stdin ?? new Uint8Array() };
    },
  };
  return { ctx: { ...base, command }, cleaned };
};

/** Delays the stat of `slowPath`, so its read settles after every other path's. */
const withSlowLstat = (ctx: Context, slowPath: string): Context => ({
  ...ctx,
  fs: new Proxy(ctx.fs, {
    get(target, prop, receiver) {
      if (prop !== 'lstat') return Reflect.get(target, prop, receiver);
      return async (path: string) => {
        if (path.endsWith(slowPath)) await new Promise((r) => setTimeout(r, SETTLE_MS));
        return target.lstat(path);
      };
    },
  }),
});

describe('Given literal paths named out of index order under a clean driver', () => {
  describe('When add stages them', () => {
    it('Then the driver hears them in index order', async () => {
      // Arrange
      const { ctx, cleaned } = await repoUnderLogDriver(
        { 'b.txt': 'B', 'a.txt': 'A' },
        '*.txt filter=log\n',
      );
      const sut = add;

      // Act
      await sut(ctx, ['b.txt', 'a.txt']);

      // Assert
      expect(cleaned).toEqual(['A', 'B']);
    });
  });
});

describe('Given a tracked modified b.txt and untracked a.txt and c.txt under a clean driver, safecrlf unset', () => {
  describe('When add walks the work tree', () => {
    it('Then the driver hears the tracked path first, then the untracked ones in walk order', async () => {
      // Arrange
      const { ctx, cleaned } = await repoUnderLogDriver(
        { 'a.txt': 'A', 'b.txt': 'B', 'c.txt': 'C' },
        '*.txt filter=log\n',
        { tracked: ['b.txt'] },
      );
      const sut = add;

      // Act
      await sut(ctx, [], { all: true });

      // Assert
      expect(cleaned).toEqual(['B2', 'A', 'C']);
    });
  });
});

describe('Given a tracked modified b.txt and untracked a.txt and c.txt under a required failing clean driver', () => {
  describe('When add walks the work tree', () => {
    it('Then the refusal names the tracked b.txt, which git cleans first', async () => {
      // Arrange
      const { ctx } = await repoUnderLogDriver(
        { 'a.txt': 'A', 'b.txt': 'B', 'c.txt': 'C' },
        '*.txt filter=log\n',
        { driver: REQUIRED_FAILING, tracked: ['b.txt'] },
      );
      const sut = add;
      let caught: unknown;

      // Act
      try {
        await sut(ctx, [], { all: true });
      } catch (error) {
        caught = error;
      }

      // Assert
      expect((caught as TsgitError).data).toEqual({
        code: 'CLEAN_FILTER_FAILED',
        path: 'b.txt',
        filter: 'log',
        exitCode: 1,
      });
    });
  });
});

describe('Given a tracked modified b.txt that cannot be read and untracked a.txt and c.txt under a clean driver, safecrlf unset', () => {
  describe('When add walks the work tree', () => {
    it('Then the driver hears no path, as git dies at the first failure', async () => {
      // Arrange
      const { ctx, cleaned } = await repoUnderLogDriver(
        { 'a.txt': 'A', 'b.txt': 'B', 'c.txt': 'C' },
        '*.txt filter=log\n',
        { tracked: ['b.txt'] },
      );
      const unreadable = new Proxy(ctx.fs, {
        get(target, prop, receiver) {
          if (prop !== 'read') return Reflect.get(target, prop, receiver);
          return async (path: string) => {
            if (path.endsWith('/b.txt')) throw new Error('unreadable b.txt');
            return target.read(path);
          };
        },
      });
      const sut = add;

      // Act
      await sut({ ...ctx, fs: unreadable }, [], { all: true }).catch(() => undefined);

      // Assert
      expect(cleaned).toEqual([]);
    });
  });
});

describe('Given core.safecrlf true, a tracked modified b.txt and untracked a.txt and c.txt that convert safely', () => {
  describe('When add walks the work tree', () => {
    it('Then each path is cleaned once, the tracked one first', async () => {
      // Arrange
      const driver: Driver = { config: `${LOG_DRIVER}[core]\n\tsafecrlf = true\n`, exitCode: 0 };
      const { ctx, cleaned } = await repoUnderLogDriver(
        { 'a.txt': 'A', 'b.txt': 'B', 'c.txt': 'C' },
        '*.txt filter=log\n',
        { driver, tracked: ['b.txt'] },
      );
      const sut = add;

      // Act
      await sut(ctx, [], { all: true });

      // Assert
      expect(cleaned).toEqual(['B2', 'A', 'C']);
    });
  });
});

describe('Given a walked tree whose first path reads slowest under a clean driver', () => {
  describe('When add walks the work tree', () => {
    it('Then the driver hears the paths in walk order, not in read order', async () => {
      // Arrange
      const { ctx, cleaned } = await repoUnderLogDriver(
        { 'a.txt': 'A', 'b.txt': 'B' },
        '*.txt filter=log\n',
      );
      const sut = add;

      // Act
      await sut(withSlowLstat(ctx, '/a.txt'), [], { all: true });

      // Assert
      expect(cleaned).toEqual(['A', 'B']);
    });
  });
});

describe('Given a walked path ahead of a filtered one that needs no clean', () => {
  describe('When add walks the work tree', () => {
    it('Then the filtered path is cleaned once the earlier path is done', async () => {
      // Arrange
      const { ctx, cleaned } = await repoUnderLogDriver(
        { 'a.dat': 'A', 'b.txt': 'B' },
        '*.txt filter=log\n',
      );
      const sut = add;

      // Act
      const result = await sut(withSlowLstat(ctx, '/a.dat'), [], { all: true });

      // Assert
      expect(cleaned).toEqual(['B']);
      expect(result.added).toEqual(['.gitattributes', 'a.dat', 'b.txt']);
    });
  });
});

interface WriteLog {
  readonly ctx: Context;
  /** `start`/`end` events of each loose-object write, in the order they happened. */
  readonly events: string[];
  /** Path of every loose object written, in write order. */
  readonly written: string[];
}

/**
 * Records loose-object writes; the first one lingers until another write starts, or until
 * `holdFirstMs` elapses — a watchdog, not a timing window, so a wrongly serialised add fails
 * instead of racing the scheduler.
 */
const withWriteLog = (ctx: Context, holdFirstMs: number): WriteLog => {
  const events: string[] = [];
  const written: string[] = [];
  let writes = 0;
  let releaseFirst = (): void => {};
  const nextWriteStarted = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const watchdog = (): Promise<void> => new Promise((r) => setTimeout(r, holdFirstMs));
  const wrapped: Context = {
    ...ctx,
    fs: new Proxy(ctx.fs, {
      get(target, prop, receiver) {
        if (prop !== 'writeExclusive') return Reflect.get(target, prop, receiver);
        return async (path: string, data: Uint8Array) => {
          if (!path.startsWith(`${ctx.layout.gitDir}/objects/`))
            return target.writeExclusive(path, data);
          const index = writes++;
          events.push(`start ${index}`);
          if (index === 1) releaseFirst();
          if (index === 0 && holdFirstMs > 0) await Promise.race([nextWriteStarted, watchdog()]);
          await target.writeExclusive(path, data);
          written.push(path);
          events.push(`end ${index}`);
        };
      },
    }),
  };
  return { ctx: wrapped, events, written };
};

const seedTrio = async (safecrlf: string): Promise<Context> => {
  const base = createMemoryContext();
  await seedRepo(base, { workingTree: { a1: 'x\r\ny\r\n', b2: 'x\ny\n', c3: 'z\r\nw\r\n' } });
  await base.fs.writeUtf8(
    `${base.layout.gitDir}/config`,
    `[core]\n\tautocrlf = true\n\tsafecrlf = ${safecrlf}\n`,
  );
  return withSlowLstat(base, '/a1');
};

describe('Given core.safecrlf true, core.autocrlf true, a1 CRLF (slow read), b2 LF, c3 CRLF', () => {
  describe('When add all', () => {
    it('Then the refusal is b2 and the loose-object write spy saw a1 only', async () => {
      // Arrange
      const { ctx, events, written } = withWriteLog(await seedTrio('true'), 0);
      const sut = add;
      let caught: unknown;

      // Act
      try {
        await sut(ctx, [], { all: true });
      } catch (error) {
        caught = error;
      }

      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      expect((caught as TsgitError).data).toEqual({
        code: 'EOL_ROUND_TRIP_UNSAFE',
        path: 'b2',
        loss: 'lf-to-crlf',
        crlf: 0,
        loneLf: 2,
      });
      expect(events).toEqual(['start 0', 'end 0']);
      const { id } = await serializeAndHash(ctx, {
        type: 'blob',
        id: '' as ObjectId,
        content: new TextEncoder().encode('x\ny\n'),
      });
      expect(written).toEqual([`${ctx.layout.gitDir}/objects/${id.slice(0, 2)}/${id.slice(2)}`]);
    });
  });
});

describe('Given core.safecrlf warn, core.autocrlf true, a deferred first write', () => {
  describe('When add all', () => {
    it('Then the next write starts while the first is pending and the notice is b2', async () => {
      // Arrange
      const { ctx, events } = withWriteLog(await seedTrio('warn'), WATCHDOG_MS);
      const sut = add;

      // Act
      const result = await sut(ctx, [], { all: true });

      // Assert
      expect(events.indexOf('start 1')).toBeLessThan(events.indexOf('end 0'));
      expect(result.eolNotices).toEqual([{ path: 'b2', loss: 'lf-to-crlf', crlf: 0, loneLf: 2 }]);
    });
  });
});
