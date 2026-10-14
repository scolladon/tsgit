import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import { stashPush } from '../../../../src/application/commands/stash.js';
import type { AuthorIdentity } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';

const AUTHOR: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};
const LOG_DRIVER = '[filter "log"]\n\tclean = log\n';
const SETTLE_MS = 20;

const dec = (bytes: Uint8Array | undefined): string =>
  new TextDecoder().decode(bytes ?? new Uint8Array());

/** Two committed files under a recording clean driver, each rewritten at the same size. */
const modifiedUnderLogDriver = async (): Promise<{
  readonly ctx: Context;
  readonly cleaned: string[];
}> => {
  const base = createMemoryContext();
  await init(base);
  await base.fs.writeUtf8(`${base.layout.workDir}/.gitattributes`, '*.txt filter=log\n');
  await base.fs.writeUtf8(`${base.layout.workDir}/a.txt`, 'A');
  await base.fs.writeUtf8(`${base.layout.workDir}/b.txt`, 'B');
  await add(base, ['.gitattributes', 'a.txt', 'b.txt']);
  await commit(base, { message: 'first', author: AUTHOR });
  await base.fs.writeUtf8(`${base.layout.gitDir}/config`, LOG_DRIVER);
  await base.fs.writeUtf8(`${base.layout.workDir}/a.txt`, 'X');
  await base.fs.writeUtf8(`${base.layout.workDir}/b.txt`, 'Y');
  const cleaned: string[] = [];
  const command = {
    run: async (request: { readonly stdin?: Uint8Array }) => {
      cleaned.push(dec(request.stdin));
      return { exitCode: 0, stdout: request.stdin ?? new Uint8Array() };
    },
  };
  return { ctx: { ...base, command }, cleaned };
};

/** Delays the stat of `slowPath`, so its comparison settles after every other path's. */
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

describe('Given two modified tracked files under a clean driver, the first stat slow', () => {
  describe('When stashPush classifies them', () => {
    it('Then the driver hears them in index order and every path is released', async () => {
      // Arrange
      const { ctx, cleaned } = await modifiedUnderLogDriver();
      const sut = stashPush;

      // Act
      await sut(withSlowLstat(ctx, '/a.txt'), {});

      // Assert
      expect(cleaned.slice(0, 2)).toEqual(['X', 'Y']);
    });
  });
});
