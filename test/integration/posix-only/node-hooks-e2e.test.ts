/**
 * POSIX-only end-to-end test: `openRepository` (Node shim) wires a real
 * `NodeHookRunner`, so a `.git/hooks/pre-commit` shell script actually runs
 * during `repo.commit`. Shell-script hooks are POSIX-bound (ADR-068).
 */
import * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { TsgitError } from '../../../src/domain/error.js';
import { openRepository } from '../../../src/index.node.js';

const author = { name: 'Ada', email: 'ada@example.com', timestamp: 0, timezoneOffset: '+0000' };

describe('Node openRepository — git hooks end to end', () => {
  let root: string;

  beforeEach(async () => {
    root = await fsPromises.realpath(
      await fsPromises.mkdtemp(nodePath.join(os.tmpdir(), 'tsgit-hook-e2e-')),
    );
  });

  afterEach(async () => {
    await fsPromises.rm(root, { recursive: true, force: true });
  });

  const writePreCommit = async (gitDir: string, body: string): Promise<void> => {
    const hooksDir = nodePath.join(gitDir, 'hooks');
    await fsPromises.mkdir(hooksDir, { recursive: true });
    const path = nodePath.join(hooksDir, 'pre-commit');
    await fsPromises.writeFile(path, body);
    await fsPromises.chmod(path, 0o755);
  };

  it('Given a failing .git/hooks/pre-commit, When commit, Then it throws HOOK_FAILED', async () => {
    // Arrange
    const repo = await openRepository({ cwd: root });
    try {
      await repo.init();
      await writePreCommit(repo.ctx.layout.gitDir, '#!/bin/sh\nexit 1\n');
      await fsPromises.writeFile(nodePath.join(root, 'a.txt'), 'a');
      await repo.add(['a.txt']);

      // Act
      let caught: unknown;
      try {
        await repo.commit({ message: 'first', author });
      } catch (err) {
        caught = err;
      }

      // Assert
      expect((caught as TsgitError).data.code).toBe('HOOK_FAILED');
    } finally {
      await repo.dispose();
    }
  });

  it('Given a passing .git/hooks/pre-commit, When commit, Then it succeeds', async () => {
    // Arrange
    const repo = await openRepository({ cwd: root });
    try {
      await repo.init();
      await writePreCommit(repo.ctx.layout.gitDir, '#!/bin/sh\nexit 0\n');
      await fsPromises.writeFile(nodePath.join(root, 'a.txt'), 'a');
      await repo.add(['a.txt']);

      // Act
      const result = await repo.commit({ message: 'first', author });

      // Assert
      expect(result.id).toMatch(/^[0-9a-f]{40}$/);
    } finally {
      await repo.dispose();
    }
  });
});
