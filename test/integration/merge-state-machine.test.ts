/**
 * Integration — merge state machine end-to-end. Drives `repo.merge.run` →
 * conflict → `repo.merge.abort` / `repo.merge.continue` through the real
 * `openRepository` facade (against the Node fs adapter, a real tmpdir).
 *
 * @proves
 *   surface: repo.merge.abort
 *   bucket:  coverage-gap
 *   unique:  merge.abort + merge.continue wired through the Tier-1 facade on a real fs
 */
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openRepository } from '../../src/index.node.js';
import type { Repository } from '../../src/repository.js';

const author = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
} as const;

let tmpdir: string;

const writeFileAt = async (dir: string, relpath: string, content: string): Promise<void> => {
  const fp = path.join(dir, relpath);
  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir(path.dirname(fp), { recursive: true });
  await writeFile(fp, content);
};

const setupConflictingMerge = async (repo: Repository, workDir: string): Promise<void> => {
  await repo.init();
  await writeFileAt(workDir, 'file.txt', 'base\n');
  await repo.add(['file.txt']);
  await repo.commit({ message: 'base', author });
  await repo.branch.create({ name: 'feature' });
  await repo.checkout({ target: 'feature' });
  await writeFileAt(workDir, 'file.txt', 'FEATURE\n');
  await repo.add(['file.txt']);
  await repo.commit({ message: 'on-feature', author });
  await repo.checkout({ target: 'main' });
  await writeFileAt(workDir, 'file.txt', 'MAIN\n');
  await repo.add(['file.txt']);
  await repo.commit({ message: 'on-main', author });
};

beforeEach(async () => {
  tmpdir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-msm-'));
});

afterEach(async () => {
  await rm(tmpdir, { recursive: true, force: true });
});

describe('integration — merge state machine via openRepository', () => {
  describe('Given a conflicting merge, When repo.merge.abort runs', () => {
    it('Then HEAD is restored and a re-merge produces the same conflict', async () => {
      // Arrange
      const workDir = await realpath(tmpdir);
      const repo = await openRepository({ cwd: workDir });
      try {
        await setupConflictingMerge(repo, workDir);
        const firstMerge = await repo.merge.run({ rev: 'feature', author });
        if (firstMerge.kind !== 'conflict') throw new Error('expected conflict');

        // Act
        const aborted = await repo.merge.abort();

        // Assert — pointer restored, no merge state left behind.
        expect(aborted.branch).toBe('refs/heads/main');
        const status = await repo.status();
        expect(status.branch).toBe('refs/heads/main');

        // Re-running the same merge produces the same conflict shape.
        const secondMerge = await repo.merge.run({ rev: 'feature', author });
        expect(secondMerge.kind).toBe('conflict');
        if (secondMerge.kind === 'conflict' && firstMerge.kind === 'conflict') {
          expect(secondMerge.mergeHead).toBe(firstMerge.mergeHead);
          expect(secondMerge.origHead).toBe(firstMerge.origHead);
        }
      } finally {
        await repo.dispose();
      }
    });
  });

  describe('Given a resolved conflict, When repo.merge.continue runs', () => {
    it('Then HEAD becomes a two-parent merge commit', async () => {
      // Arrange
      const workDir = await realpath(tmpdir);
      const repo = await openRepository({ cwd: workDir });
      try {
        await setupConflictingMerge(repo, workDir);
        const conflict = await repo.merge.run({ rev: 'feature', author });
        if (conflict.kind !== 'conflict') throw new Error('expected conflict');
        await writeFileAt(workDir, 'file.txt', 'RESOLVED\n');
        await repo.add(['file.txt']);

        // Act
        const result = await repo.merge.continue({
          message: 'resolved',
          author,
          committer: author,
        });

        // Assert — two parents recorded, merge state cleared.
        expect(result.parents).toHaveLength(2);
        expect(result.parents).toContain(conflict.mergeHead);
        expect(result.parents).toContain(conflict.origHead);

        // No state pollution — a follow-up mutation must not trip
        // assertNoPendingOperation. If MERGE_HEAD survived, this add would
        // surface OPERATION_IN_PROGRESS.
        await writeFileAt(workDir, 'follow-up.txt', 'x\n');
        await repo.add(['follow-up.txt']);
      } finally {
        await repo.dispose();
      }
    });
  });

  describe('Given no merge in progress, When repo.merge.abort runs', () => {
    it('Then it throws NO_OPERATION_IN_PROGRESS(merge)', async () => {
      // Arrange
      const workDir = await realpath(tmpdir);
      const repo = await openRepository({ cwd: workDir });
      try {
        await repo.init();
        await writeFileAt(workDir, 'a.txt', 'a');
        await repo.add(['a.txt']);
        await repo.commit({ message: 'first', author });

        // Act
        let caught: unknown;
        try {
          await repo.merge.abort();
        } catch (err) {
          caught = err;
        }

        // Assert
        const data = (caught as { data?: { code?: string; operation?: string } })?.data;
        expect(data?.code).toBe('NO_OPERATION_IN_PROGRESS');
        expect(data?.operation).toBe('merge');
      } finally {
        await repo.dispose();
      }
    });
  });
});
