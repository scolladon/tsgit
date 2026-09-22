/**
 * POSIX-only integration test: a policy-bearing `NodeFileSystem`'s sync fast
 * path for `read`/`readUtf8` must never block the event loop on a FIFO that
 * has no writer yet. The sync probe opens with `O_NONBLOCK`, sees a
 * non-regular file at `fstat`, and defers to the async arm — exactly as it
 * does without a policy — so a same-turn timer still fires while the read is
 * pending, and a later writer resolves it.
 *
 * No Node API creates a named pipe, so the fixture shells out to the POSIX
 * `mkfifo` command.
 */
import { execFileSync } from 'node:child_process';
import * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NodeFileSystem } from '../../../src/adapters/node/node-file-system.js';
import { createSyncIoPolicy } from '../../../src/adapters/node/sync-io-budget.js';

let tempRoot: string | undefined;

afterEach(async () => {
  if (tempRoot === undefined) return;
  await fsPromises.rm(tempRoot, { recursive: true, force: true });
  tempRoot = undefined;
});

async function makeFifo(): Promise<{ readonly rootDir: string; readonly fifo: string }> {
  const dir = await fsPromises.mkdtemp(nodePath.join(os.tmpdir(), 'tsgit-fifo-'));
  tempRoot = dir;
  const rootDir = await fsPromises.realpath(dir);
  const fifo = nodePath.join(rootDir, 'pipe');
  execFileSync('mkfifo', [fifo]);
  return { rootDir, fifo };
}

/** Schedules a macrotask marker and resolves once it fires. */
function nextMacrotask(order: string[]): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(() => {
      order.push('timer');
      resolve();
    }, 0);
  });
}

describe('NodeFileSystem — sync fast path FIFO safety', () => {
  describe('Given a policy-bearing adapter reading a FIFO with no writer yet', () => {
    describe('When readUtf8 is called', () => {
      it('Then a same-turn timer still fires before the read resolves, and a later write resolves it', async () => {
        // Arrange
        const { rootDir, fifo } = await makeFifo();
        const sut = new NodeFileSystem(rootDir, { syncIo: createSyncIoPolicy() });
        const order: string[] = [];

        // Act
        const pending = sut.readUtf8(fifo).then((value) => {
          order.push('read');
          return value;
        });
        await nextMacrotask(order);
        await fsPromises.writeFile(fifo, 'x');
        const result = await pending;

        // Assert
        expect(order).toEqual(['timer', 'read']);
        expect(result).toBe('x');
      });
    });

    describe('When read is called', () => {
      it('Then a same-turn timer still fires before the read resolves, and a later write resolves it', async () => {
        // Arrange
        const { rootDir, fifo } = await makeFifo();
        const sut = new NodeFileSystem(rootDir, { syncIo: createSyncIoPolicy() });
        const order: string[] = [];

        // Act
        const pending = sut.read(fifo).then((value) => {
          order.push('read');
          return value;
        });
        await nextMacrotask(order);
        await fsPromises.writeFile(fifo, 'x');
        const result = await pending;

        // Assert
        expect(order).toEqual(['timer', 'read']);
        expect(result).toEqual(new Uint8Array(Buffer.from('x')));
      });
    });
  });
});
