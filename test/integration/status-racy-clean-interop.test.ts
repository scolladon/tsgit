/**
 * Cross-tool interop — the `ie_match_stat`-faithful stat-cache
 * short-circuit in `status`. tsgit exposes no `update-index` command, so
 * canonical git sets the `assume-unchanged`/`skip-worktree` index flags
 * directly on tsgit's own `.git/index` (a git-faithful on-disk format,
 * readable/writable by either tool).
 *
 * @proves
 *   surface:        status
 *   bucket:         cross-tool-interop
 *   unique:         status honours ie_match_stat (racy re-hash, CE_VALID, skip-worktree)
 *   interopSurface: status
 */
import { execFileSync } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { add } from '../../src/application/commands/add.js';
import { init } from '../../src/application/commands/init.js';
import { status } from '../../src/application/commands/status.js';
import type { Context } from '../../src/ports/context.js';
import { GIT_AVAILABLE, git, makePeerPair, type PeerPair, runGitAsync } from './interop-helpers.js';

describe.skipIf(!GIT_AVAILABLE)('status racy-clean interop', () => {
  let pair: PeerPair;
  let ctx: Context;

  beforeEach(async () => {
    pair = await makePeerPair('status-racy');
    await runGitAsync(['init', '-q', '-b', 'main', pair.peer]);
    ctx = createNodeContext({ workDir: pair.ours });
    await init(ctx);
  });

  afterEach(async () => {
    await pair.dispose();
  });

  describe('Given a tracked file re-edited with same-size content immediately after staging', () => {
    describe('When status compares the working tree to the index', () => {
      it('Then the edit is reported modified, matching canonical git porcelain (racy re-hash)', async () => {
        // Arrange — stage identical content on both sides.
        await writeFile(path.join(pair.peer, 'f.txt'), 'aaaa\n');
        await writeFile(path.join(pair.ours, 'f.txt'), 'aaaa\n');
        await runGitAsync(['-C', pair.peer, 'add', 'f.txt']);
        await add(ctx, ['f.txt']);

        // Act — the SAME same-size edit with no delay: the file's mtime and
        // the just-written index's own mtime commonly land in the same
        // wall-clock second — the racy window canonical git re-hashes
        // through rather than trusting the stat cache.
        await writeFile(path.join(pair.peer, 'f.txt'), 'bbbb\n');
        await writeFile(path.join(pair.ours, 'f.txt'), 'bbbb\n');
        const peerPorcelain = (
          await runGitAsync(['-C', pair.peer, 'status', '--porcelain=v1'])
        ).trim();
        const result = await status(ctx);

        // Assert — canonical git reports `AM` (racy re-hash caught the edit
        // despite matching size); tsgit's structured result agrees.
        expect(peerPorcelain).toBe('AM f.txt');
        const changed = result.changes.find((c) => c.path === 'f.txt');
        expect(changed?.staged).toBe('added');
        expect(changed?.unstaged).toBe('modified');
      });
    });
  });

  describe('Given an assume-unchanged tracked file edited afterward', () => {
    describe('When status compares the working tree to the index', () => {
      it('Then the edit is not reported, matching canonical git porcelain (CE_VALID short-circuits)', async () => {
        // Arrange
        await writeFile(path.join(pair.peer, 'g.txt'), 'aaaa\n');
        await writeFile(path.join(pair.ours, 'g.txt'), 'aaaa\n');
        await runGitAsync(['-C', pair.peer, 'add', 'g.txt']);
        await add(ctx, ['g.txt']);
        await runGitAsync(['-C', pair.peer, 'update-index', '--assume-unchanged', 'g.txt']);
        await runGitAsync(['-C', pair.ours, 'update-index', '--assume-unchanged', 'g.txt']);

        // Act — a genuinely longer edit, which would otherwise always diff.
        const longerBody = 'a much longer edited body that would otherwise diff\n';
        await writeFile(path.join(pair.peer, 'g.txt'), longerBody);
        await writeFile(path.join(pair.ours, 'g.txt'), longerBody);
        const peerPorcelain = (
          await runGitAsync(['-C', pair.peer, 'status', '--porcelain=v1'])
        ).trim();
        const result = await status(ctx);

        // Assert
        expect(peerPorcelain).toBe('A  g.txt');
        const changed = result.changes.find((c) => c.path === 'g.txt');
        expect(changed?.staged).toBe('added');
        expect(changed?.unstaged).toBeUndefined();
      });
    });
  });

  describe('Given a skip-worktree tracked file edited afterward', () => {
    describe('When status compares the working tree to the index', () => {
      it('Then the working-tree side is skipped, matching canonical git porcelain', async () => {
        // Arrange
        await writeFile(path.join(pair.peer, 'h.txt'), 'aaaa\n');
        await writeFile(path.join(pair.ours, 'h.txt'), 'aaaa\n');
        await runGitAsync(['-C', pair.peer, 'add', 'h.txt']);
        await add(ctx, ['h.txt']);
        await runGitAsync(['-C', pair.peer, 'update-index', '--skip-worktree', 'h.txt']);
        await runGitAsync(['-C', pair.ours, 'update-index', '--skip-worktree', 'h.txt']);

        // Act
        const longerBody = 'a much longer edited body that would otherwise diff\n';
        await writeFile(path.join(pair.peer, 'h.txt'), longerBody);
        await writeFile(path.join(pair.ours, 'h.txt'), longerBody);
        const peerPorcelain = (
          await runGitAsync(['-C', pair.peer, 'status', '--porcelain=v1'])
        ).trim();
        const result = await status(ctx);

        // Assert
        expect(peerPorcelain).toBe('A  h.txt');
        const changed = result.changes.find((c) => c.path === 'h.txt');
        expect(changed?.unstaged).toBeUndefined();
      });
    });
  });

  describe('Given an LF blob git checked out CRLF, its entry racily clean', () => {
    const entrySize = (dir: string): string =>
      /size: (\d+)/.exec(git(dir, 'ls-files', '--debug', 'f'))?.[1] ?? '';

    // Equal index and file timestamps make the entry racily clean without a second-boundary race.
    const makeRacy = async (dir: string, autoCrlf: boolean): Promise<void> => {
      await writeFile(path.join(dir, 'f'), 'a\nb\n');
      await runGitAsync(['-C', dir, 'add', 'f']);
      await runGitAsync(['-C', dir, 'commit', '-q', '-m', 'one']);
      await runGitAsync(['-C', dir, 'config', 'core.autocrlf', 'true']);
      await rm(path.join(dir, 'f'));
      await runGitAsync(['-C', dir, 'checkout', '--', 'f']);
      if (!autoCrlf) await runGitAsync(['-C', dir, 'config', '--unset', 'core.autocrlf']);
      execFileSync('touch', ['-r', path.join(dir, 'f'), path.join(dir, '.git', 'index')]);
      await writeFile(path.join(dir, 'g'), 'g\n');
    };

    describe('When the index is rewritten under core.autocrlf=true', () => {
      it('Then the entry keeps size 6 in git and in tsgit', async () => {
        // Arrange
        await makeRacy(pair.peer, true);
        await makeRacy(pair.ours, true);

        // Act
        await runGitAsync(['-C', pair.peer, 'add', 'g']);
        await add(ctx, ['g']);

        // Assert
        expect(entrySize(pair.peer)).toBe('6');
        expect(entrySize(pair.ours)).toBe('6');
      });
    });

    describe('When the index is rewritten without core.autocrlf', () => {
      it('Then the entry is smudged to size 0 in git and in tsgit', async () => {
        // Arrange
        await makeRacy(pair.peer, false);
        await makeRacy(pair.ours, false);

        // Act
        await runGitAsync(['-C', pair.peer, 'add', 'g']);
        await add(ctx, ['g']);

        // Assert
        expect(entrySize(pair.peer)).toBe('0');
        expect(entrySize(pair.ours)).toBe('0');
      });
    });
  });
});
