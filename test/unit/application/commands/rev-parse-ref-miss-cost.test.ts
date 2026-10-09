import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { resolveRevision } from '../../../../src/application/commands/rev-parse.js';
import type { Context } from '../../../../src/ports/context.js';
import type { FileSystem } from '../../../../src/ports/file-system.js';
import { seedRepo } from './fixtures.js';

const TREE_OID = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

interface Rejection {
  readonly method: string;
  readonly path: unknown;
}

/** `ctx` whose fs records every call that rejects — each one a refusal some adapter built. */
const rejectionRecordingContext = (
  base: Context,
): { readonly ctx: Context; readonly rejections: () => ReadonlyArray<Rejection> } => {
  const log: Rejection[] = [];
  const record = (method: string, path: unknown) => (err: unknown) => {
    log.push({ method, path });
    throw err;
  };
  const fs = new Proxy(base.fs, {
    get(target, key, receiver) {
      const value: unknown = Reflect.get(target, key, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        const out: unknown = value.apply(target, args);
        return out instanceof Promise ? out.catch(record(String(key), args[0])) : out;
      };
    },
  }) as FileSystem;
  return { ctx: { ...base, fs }, rejections: () => log.slice() };
};

describe('Given a configured repository with HEAD on a loose branch and no packed-refs', () => {
  describe('When resolveRevision(HEAD) walks every dwim candidate', () => {
    it('Then no ref probe is answered by a refusal', async () => {
      // Arrange
      const base = createMemoryContext();
      const { commitIds } = await seedRepo(base, { commits: [{ tree: TREE_OID }] });
      await seedRepo(base, { refs: { 'refs/heads/main': commitIds[0] as string } });
      await base.fs.writeUtf8(`${base.layout.gitDir}/config`, '[core]\n');
      const { ctx, rejections } = rejectionRecordingContext(base);

      // Act
      await resolveRevision(ctx, 'HEAD');

      // Assert
      const result = rejections().filter(({ path }) => String(path).startsWith(ctx.layout.gitDir));
      expect(result).toEqual([]);
    });
  });
});
