/**
 * The clone / fetch / push commands must release their `GitServiceSession`
 * in a `finally` — even when the session fails mid-flight. Proven at the
 * unit tier with a stub ssh transport whose channel serves a broken
 * advertisement, so the commands throw after the channel is open.
 */
import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { clone, fetch, push } from '../../../../src/application/commands/index.js';
import { TsgitError } from '../../../../src/domain/index.js';

const brokenSshTransport = () => {
  const closeSpy = { calls: 0 };
  const open = async () => ({
    stdin: new WritableStream<Uint8Array>({ write: () => undefined }),
    stdout: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('not a pkt-line stream'));
        controller.close();
      },
    }),
    exit: Promise.resolve(0),
    close: async () => {
      closeSpy.calls += 1;
    },
  });
  return { ssh: { open }, closeSpy };
};

const memoryCtxWithOriginRemote = async (url: string) => {
  const ctx = createMemoryContext();
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, `[remote "origin"]\n  url = ${url}\n`);
  return ctx;
};

describe('Given a stub ssh channel serving a broken advertisement', () => {
  describe('When clone fails mid-session', () => {
    it('Then the ssh channel is still closed', async () => {
      // Arrange
      const { ssh, closeSpy } = brokenSshTransport();
      const ctx = { ...createMemoryContext(), ssh };

      // Act
      let caught: unknown;
      try {
        await clone(ctx, { url: 'ssh://git@example.invalid/repo.git' });
      } catch (err) {
        caught = err;
      }

      // Assert — the failure propagates AND the finally released the channel.
      expect(caught).toBeInstanceOf(TsgitError);
      expect(closeSpy.calls).toBe(1);
    });
  });

  describe('When fetch fails mid-session', () => {
    it('Then the ssh channel is still closed', async () => {
      // Arrange
      const { ssh, closeSpy } = brokenSshTransport();
      const ctx = {
        ...(await memoryCtxWithOriginRemote('ssh://git@example.invalid/repo.git')),
        ssh,
      };

      // Act
      let caught: unknown;
      try {
        await fetch(ctx, { remote: 'origin' });
      } catch (err) {
        caught = err;
      }

      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      expect(closeSpy.calls).toBe(1);
    });
  });

  describe('When push fails mid-session', () => {
    it('Then the ssh channel is still closed', async () => {
      // Arrange
      const { ssh, closeSpy } = brokenSshTransport();
      const ctx = {
        ...(await memoryCtxWithOriginRemote('ssh://git@example.invalid/repo.git')),
        ssh,
      };

      // Act
      let caught: unknown;
      try {
        await push(ctx, { remote: 'origin', refspecs: ['refs/heads/main:refs/heads/main'] });
      } catch (err) {
        caught = err;
      }

      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      expect(closeSpy.calls).toBe(1);
    });
  });
});
