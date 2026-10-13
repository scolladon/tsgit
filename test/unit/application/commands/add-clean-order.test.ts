import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { TsgitError } from '../../../../src/domain/index.js';
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

/** A repo whose `log` clean driver records the content of each file it hears, in call order. */
const repoUnderLogDriver = async (
  workingTree: Readonly<Record<string, string>>,
  attributes: string,
): Promise<Recorded> => {
  const base = createMemoryContext();
  await seedRepo(base, { workingTree });
  await base.fs.writeUtf8(`${base.layout.workDir}/.gitattributes`, attributes);
  await base.fs.writeUtf8(`${base.layout.gitDir}/config`, LOG_DRIVER);
  const cleaned: string[] = [];
  const command = {
    run: async (request: { readonly stdin?: Uint8Array }) => {
      cleaned.push(dec(request.stdin));
      return { exitCode: 0, stdout: request.stdin ?? new Uint8Array() };
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
}

/**
 * Records loose-object writes; the first one lingers until another write starts, or until
 * `holdFirstMs` elapses — a watchdog, not a timing window, so a wrongly serialised add fails
 * instead of racing the scheduler.
 */
const withWriteLog = (ctx: Context, holdFirstMs: number): WriteLog => {
  const events: string[] = [];
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
          events.push(`end ${index}`);
        };
      },
    }),
  };
  return { ctx: wrapped, events };
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
      const { ctx, events } = withWriteLog(await seedTrio('true'), 0);
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
    });
  });
});

describe('Given core.safecrlf warn, core.autocrlf true, a deferred first write', () => {
  describe('When add all', () => {
    it('Then the next write starts while the first is pending and the notice is b2s', async () => {
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
