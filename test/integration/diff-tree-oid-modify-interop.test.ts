/**
 * Cross-tool interop — a non-recursive diff can legitimately pair two tree
 * oids for a changed/added/removed sub-directory. Pins two distinct real-git
 * `diff-tree` (no `-r`) behaviours for that pairing:
 *
 *   - a whitespace-ignore flag (`-w`) drops the entry outright from raw
 *     output — git cannot line-diff a tree, so the pair is never even
 *     considered "real";
 *   - any content-bearing format (`--numstat`) implicitly recurses,
 *     surfacing full per-file leaf entries with real line counts instead of
 *     the tree-level entry.
 *
 * `repo.diff({ from, to })` is non-recursive by default (`git diff-tree`
 * without `-r`), so `ignoreWhitespace` must reproduce the drop and
 * `withStat` must reproduce the auto-recurse — never crash on the tree oid.
 *
 * @proves
 *   surface:        diff.ignoreWhitespace / diff.withStat (non-recursive)
 *   bucket:         cross-tool-interop
 *   unique:         a non-recursive diff over a changed/added/removed
 *                    sub-directory matches git's drop-under--w and
 *                    auto-recurse-under---numstat behaviour byte-for-byte,
 *                    instead of crashing on the tree oid
 *   interopSurface: diff
 */
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StatDiffChange } from '../../src/domain/diff/index.js';
import { openRepository } from '../../src/index.node.js';
import { GIT_AVAILABLE, runGitAsync, runGitEnv } from './interop-helpers.js';

const IDENTITY = {
  GIT_AUTHOR_NAME: 'Ada',
  GIT_AUTHOR_EMAIL: 'ada@example.com',
  GIT_COMMITTER_NAME: 'Ada',
  GIT_COMMITTER_EMAIL: 'ada@example.com',
  GIT_AUTHOR_DATE: '1700030000 +0000',
  GIT_COMMITTER_DATE: '1700030000 +0000',
} as const;

interface NumstatRow {
  readonly path: string;
  readonly added: number;
  readonly deleted: number;
}

/** Parse `git diff-tree --numstat` lines (`<added>\t<deleted>\t<path>`) into structured rows. */
const parseNumstat = (output: string): ReadonlyArray<NumstatRow> =>
  output
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      const [added, deleted, filePath] = line.split('\t');
      return { path: filePath ?? '', added: Number(added), deleted: Number(deleted) };
    })
    .sort((a, b) => a.path.localeCompare(b.path));

/** The single display path a `StatDiffChange` carries, regardless of change kind. */
const pathOf = (change: StatDiffChange): string => {
  switch (change.type) {
    case 'add':
      return change.newPath;
    case 'delete':
      return change.oldPath;
    case 'modify':
    case 'type-change':
      return change.path;
    case 'rename':
    case 'copy':
      return change.newPath;
  }
};

/** Reconstruct the same `{ path, added, deleted }` shape from tsgit's structured `StatTreeDiff`. */
const numstatRowsFromStatDiff = (
  changes: ReadonlyArray<StatDiffChange>,
): ReadonlyArray<NumstatRow> =>
  changes
    .map((change) => ({ path: pathOf(change), added: change.added, deleted: change.deleted }))
    .sort((a, b) => a.path.localeCompare(b.path));

let dir = '';
let repo: Awaited<ReturnType<typeof openRepository>>;
let from = '';
let to = '';

describe.skipIf(!GIT_AVAILABLE)(
  'integration — non-recursive diff over a changed/added/removed sub-directory',
  { timeout: 60_000 },
  () => {
    beforeAll(async () => {
      dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-treeoid-modify-interop-')));
      await runGitAsync(['init', '-q', '-b', 'main', dir]);
      await runGitAsync(['-C', dir, 'config', 'user.name', 'Ada']);
      await runGitAsync(['-C', dir, 'config', 'user.email', 'ada@example.com']);

      await mkdir(path.join(dir, 'modsub'));
      await mkdir(path.join(dir, 'delsub'));
      await writeFile(path.join(dir, 'modsub', 'inner.txt'), 'old content\n');
      await writeFile(path.join(dir, 'delsub', 'a.txt'), 'line1\n');
      await writeFile(path.join(dir, 'delsub', 'b.txt'), 'line2\n');
      await runGitAsync(['-C', dir, 'add', '-A']);
      await runGitAsync(['-C', dir, 'commit', '-q', '-m', 'base'], {
        env: { ...runGitEnv(), ...IDENTITY },
      });
      from = (await runGitAsync(['-C', dir, 'rev-parse', 'HEAD'])).trim();

      await writeFile(path.join(dir, 'modsub', 'inner.txt'), 'new content\n');
      await runGitAsync(['-C', dir, 'rm', '-r', '-q', 'delsub']);
      await mkdir(path.join(dir, 'addsub'));
      await writeFile(path.join(dir, 'addsub', 'a.txt'), 'line1\n');
      await writeFile(path.join(dir, 'addsub', 'b.txt'), 'line2\n');
      await runGitAsync(['-C', dir, 'add', '-A']);
      await runGitAsync(['-C', dir, 'commit', '-q', '-m', 'change'], {
        env: { ...runGitEnv(), ...IDENTITY },
      });
      to = (await runGitAsync(['-C', dir, 'rev-parse', 'HEAD'])).trim();

      repo = await openRepository({ cwd: dir });
    });

    afterAll(async () => {
      await repo.dispose();
      await rm(dir, { recursive: true, force: true });
    });

    describe('Given a base commit and a change commit that modify/add/delete whole sub-directories', () => {
      describe('When diffing non-recursively with ignoreWhitespace:"all" and comparing to `git diff-tree --no-ext-diff -w` (no -r)', () => {
        it('Then both drop every directory-mode entry entirely (a tree pair cannot be line-diffed)', async () => {
          // Arrange
          const liveRaw = await runGitAsync([
            '-C',
            dir,
            'diff-tree',
            '--no-ext-diff',
            '-w',
            from,
            to,
          ]);

          // Act
          const result = await repo.diff({ from, to, ignoreWhitespace: 'all' });

          // Assert
          expect(liveRaw.trim()).toBe('');
          expect(result.changes).toHaveLength(0);
        });
      });

      describe('When diffing non-recursively with withStat:true and comparing to `git diff-tree --no-ext-diff --numstat` (no -r)', () => {
        it('Then both auto-recurse into every changed/added/removed sub-directory with matching per-file line counts', async () => {
          // Arrange
          const liveNumstat = await runGitAsync([
            '-C',
            dir,
            'diff-tree',
            '--no-ext-diff',
            '--numstat',
            from,
            to,
          ]);
          const liveRows = parseNumstat(liveNumstat);

          // Act
          const result = await repo.diff({ from, to, withStat: true });

          // Assert
          expect(numstatRowsFromStatDiff(result.changes)).toEqual(liveRows);
          expect(liveRows).toEqual([
            { path: 'addsub/a.txt', added: 1, deleted: 0 },
            { path: 'addsub/b.txt', added: 1, deleted: 0 },
            { path: 'delsub/a.txt', added: 0, deleted: 1 },
            { path: 'delsub/b.txt', added: 0, deleted: 1 },
            { path: 'modsub/inner.txt', added: 1, deleted: 1 },
          ]);
        });
      });

      describe('When diffing non-recursively with ignoreWhitespace:"all" AND withStat:true, comparing to `git diff-tree --no-ext-diff -w --numstat` (no -r)', () => {
        it('Then both auto-recurse and keep every real change (whitespace-ignore never hides a real content difference)', async () => {
          // Arrange
          const liveNumstat = await runGitAsync([
            '-C',
            dir,
            'diff-tree',
            '--no-ext-diff',
            '-w',
            '--numstat',
            from,
            to,
          ]);
          const liveRows = parseNumstat(liveNumstat);

          // Act
          const result = await repo.diff({ from, to, ignoreWhitespace: 'all', withStat: true });

          // Assert
          expect(numstatRowsFromStatDiff(result.changes)).toEqual(liveRows);
        });
      });
    });
  },
);
