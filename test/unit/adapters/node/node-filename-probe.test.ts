import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  filenameProbeOver,
  nodeFilenameProbe,
} from '../../../../src/adapters/node/node-filename-probe.js';
import { nativePolicy } from '../../../../src/adapters/node/path-policy.js';
import type { TsgitError } from '../../../../src/domain/error.js';

const errnoError = (code: string): NodeJS.ErrnoException =>
  Object.assign(new Error(code), { code });

/** Windows resolves `..` by name before the filesystem sees the path, as git for Windows' lstat does. */
const HOPS_RESOLVE_BY_NAME = nativePolicy.windowsSyntax;
/** The directory `dg:a/../../outside` climbs through: Windows forbids `:` in a name and never visits it. */
const HOP_DIRECTORY = HOPS_RESOLVE_BY_NAME ? '' : 'dg:a';

describe('nodeFilenameProbe', () => {
  let base = '';

  beforeEach(async () => {
    base = await realpath(await mkdtemp(nodePath.join(tmpdir(), 'tsgit-filename-probe-')));
    await mkdir(nodePath.join(base, 'repo', HOP_DIRECTORY), { recursive: true });
    await writeFile(nodePath.join(base, 'outside'), '');
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  describe('Given a path whose parent hops climb out of the repository to a file', () => {
    describe('When the probe checks it', () => {
      it('Then it reports the file present', async () => {
        // Arrange
        const sut = nodeFilenameProbe;

        // Act
        const result = await sut(`${base}/repo/dg:a/../../outside`);

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given a parent hop out of a directory that does not exist', () => {
    describe('When the probe checks it', () => {
      it('Then it finds the file past it only where the system resolves the hop by name', async () => {
        // Arrange
        const sut = nodeFilenameProbe;

        // Act
        const result = await sut(`${base}/repo/dg:b/../../outside`);

        // Assert
        expect(result).toBe(HOPS_RESOLVE_BY_NAME);
      });
    });
  });

  describe('Given a parent hop out of a symbolic link to a directory elsewhere', () => {
    describe('When the probe checks it', () => {
      it('Then it resolves the hop from the link target unless the system resolves it by name', async () => {
        // Arrange
        await mkdir(nodePath.join(base, 'deep', 'x'), { recursive: true });
        await writeFile(nodePath.join(base, 'deep', 'beside'), '');
        await symlink(nodePath.join(base, 'deep', 'x'), nodePath.join(base, 'repo', 'link'));
        const sut = nodeFilenameProbe;

        // Act
        const result = await sut(`${base}/repo/link/../beside`);

        // Assert
        expect(result).toBe(!HOPS_RESOLVE_BY_NAME);
      });
    });
  });

  describe('Given a path crossing a regular file', () => {
    describe('When the probe checks it', () => {
      it('Then it reports nothing there', async () => {
        // Arrange
        const sut = nodeFilenameProbe;

        // Act
        const result = await sut(`${base}/outside/below`);

        // Assert
        expect(result).toBe(false);
      });
    });
  });
});

describe('filenameProbeOver', () => {
  describe('Given an lstat refused for a reason other than absence', () => {
    describe('When the probe checks a path', () => {
      it('Then it rejects with the mapped refusal', async () => {
        // Arrange
        const lstat = (): Promise<never> => Promise.reject(errnoError('EACCES'));
        const sut = filenameProbeOver;

        // Act
        const result = await sut({ lstat })('/denied/path').catch(
          (error: TsgitError) => error.data,
        );

        // Assert
        expect(result).toEqual({ code: 'PERMISSION_DENIED', path: '/denied/path' });
      });
    });
  });

  describe('Given an lstat failing without an errno', () => {
    describe('When the probe checks a path', () => {
      it('Then it rejects with that failure untouched', async () => {
        // Arrange
        const failure = new Error('boom');
        const lstat = (): Promise<never> => Promise.reject(failure);
        const sut = filenameProbeOver;

        // Act
        const result = await sut({ lstat })('/any').catch((error: unknown) => error);

        // Assert
        expect(result).toBe(failure);
      });
    });
  });
});
