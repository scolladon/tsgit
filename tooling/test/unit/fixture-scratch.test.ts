import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, rmSync: vi.fn(actual.rmSync) };
});

const { rmSync } = await import('node:fs');
const { removeSync } = await import('../../../test/bench/support/fixture-scratch.ts');

describe('removeSync', () => {
  describe('Given a scratch directory that removes cleanly', () => {
    describe('When removeSync removes it', () => {
      it('Then the directory is gone and nothing is written to stderr', async () => {
        // Arrange
        const parent = await mkdtemp(path.join(os.tmpdir(), 'tsgit-fixture-scratch-test-'));
        const dir = path.join(parent, 'small-v3.scratch.1.abc123');
        await mkdir(dir);
        await writeFile(path.join(dir, 'f'), 'x');
        const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        const sut = removeSync;

        // Act
        sut(dir);
        const written = stderrSpy.mock.calls.map((call) => String(call[0])).join('');
        stderrSpy.mockRestore();

        // Assert
        await expect(readdir(parent)).resolves.toEqual([]);
        expect(written).toBe('');
        const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');
        actualFs.rmSync(parent, { recursive: true, force: true });
      });
    });
  });

  describe('Given a removal the filesystem refuses', () => {
    describe('When removeSync runs inside a bench teardown', () => {
      it('Then it does not throw and reports the exact failure on stderr', async () => {
        // Arrange
        const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');
        const mockedRmSync = vi.mocked(rmSync);
        mockedRmSync.mockImplementation(() => {
          throw Object.assign(new Error('resource busy'), { code: 'EBUSY' });
        });
        const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        const sut = removeSync;

        // Act
        let caught: unknown;
        let written: string;
        try {
          sut('/cache/tsgit-bench/small-v3.scratch.7.abc');
        } catch (err) {
          caught = err;
        } finally {
          written = stderrSpy.mock.calls.map((call) => String(call[0])).join('');
          stderrSpy.mockRestore();
          mockedRmSync.mockImplementation(actualFs.rmSync);
        }

        // Assert
        expect(caught).toBeUndefined();
        expect(written).toBe(
          '[bench] could not remove /cache/tsgit-bench/small-v3.scratch.7.abc: resource busy\n',
        );
      });
    });
  });
});
