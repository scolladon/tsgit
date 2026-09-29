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
 *   surface:        diff.ignoreWhitespace, diff.withStat
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

interface RenameNumstatRow {
  readonly added: number;
  readonly deleted: number;
  readonly oldPath: string;
  readonly newPath: string;
}

/** Every `-z` field triple below is one `<added>\t<deleted>\t\0<old-path>\0<new-path>\0`
 *  rename record — the NUL-separated form git always emits for a numstat rename, since
 *  the display-only `{old => new}` path never appears under `-z`. */
const RENAME_RECORD_FIELD_COUNT = 3;

/** Parse `git diff-tree -M --numstat -z` output whose every record is a rename pairing
 *  (an all-renamed directory never mixes in a plain add/delete/modify record). */
const parseRenameNumstatZ = (output: string): ReadonlyArray<RenameNumstatRow> => {
  const fields = output.split('\0');
  const rows: RenameNumstatRow[] = [];
  for (let i = 0; i + 2 < fields.length; i += RENAME_RECORD_FIELD_COUNT) {
    const [added, deleted] = (fields[i] ?? '').split('\t');
    rows.push({
      added: Number(added),
      deleted: Number(deleted),
      oldPath: fields[i + 1] ?? '',
      newPath: fields[i + 2] ?? '',
    });
  }
  return [...rows].sort((a, b) => a.newPath.localeCompare(b.newPath));
};

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

const isRenameStatChange = (
  change: StatDiffChange,
): change is Extract<StatDiffChange, { type: 'rename' }> => change.type === 'rename';

/** Reconstruct `{ added, deleted, oldPath, newPath }` rows from tsgit's rename changes,
 *  peering `parseRenameNumstatZ`'s rows one-for-one. */
const renameNumstatRowsFromStatDiff = (
  changes: ReadonlyArray<StatDiffChange>,
): ReadonlyArray<RenameNumstatRow> =>
  changes
    .filter(isRenameStatChange)
    .map((change) => ({
      added: change.added,
      deleted: change.deleted,
      oldPath: change.oldPath,
      newPath: change.newPath,
    }))
    .sort((a, b) => a.newPath.localeCompare(b.newPath));

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
    }, 60_000);

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

let renameDir = '';
let renameRepo: Awaited<ReturnType<typeof openRepository>>;
let renameFrom = '';
let renameTo = '';
let renameTo2 = '';

describe.skipIf(!GIT_AVAILABLE)(
  'integration — non-recursive diff over an exactly-renamed sub-directory',
  { timeout: 60_000 },
  () => {
    beforeAll(async () => {
      renameDir = await realpath(
        await mkdtemp(path.join(os.tmpdir(), 'tsgit-treeoid-rename-interop-')),
      );
      await runGitAsync(['init', '-q', '-b', 'main', renameDir]);
      await runGitAsync(['-C', renameDir, 'config', 'user.name', 'Ada']);
      await runGitAsync(['-C', renameDir, 'config', 'user.email', 'ada@example.com']);

      await mkdir(path.join(renameDir, 'oldname', 'sub'), { recursive: true });
      await writeFile(path.join(renameDir, 'oldname', 'inner.txt'), 'shared content\n');
      await writeFile(path.join(renameDir, 'oldname', 'sub', 'deep.txt'), 'deep content\n');
      await runGitAsync(['-C', renameDir, 'add', '-A']);
      await runGitAsync(['-C', renameDir, 'commit', '-q', '-m', 'base'], {
        env: { ...runGitEnv(), ...IDENTITY },
      });
      renameFrom = (await runGitAsync(['-C', renameDir, 'rev-parse', 'HEAD'])).trim();

      await runGitAsync(['-C', renameDir, 'mv', 'oldname', 'newname']);
      await runGitAsync(['-C', renameDir, 'commit', '-q', '-m', 'rename'], {
        env: { ...runGitEnv(), ...IDENTITY },
      });
      renameTo = (await runGitAsync(['-C', renameDir, 'rev-parse', 'HEAD'])).trim();

      await writeFile(path.join(renameDir, 'newname', 'inner.txt'), 'shared content\nmore\n');
      await runGitAsync(['-C', renameDir, 'mv', 'newname', 'renamed2']);
      await runGitAsync(['-C', renameDir, 'add', '-A']);
      await runGitAsync(['-C', renameDir, 'commit', '-q', '-m', 'move-and-edit'], {
        env: { ...runGitEnv(), ...IDENTITY },
      });
      renameTo2 = (await runGitAsync(['-C', renameDir, 'rev-parse', 'HEAD'])).trim();

      renameRepo = await openRepository({ cwd: renameDir });
    }, 60_000);

    afterAll(async () => {
      await renameRepo.dispose();
      await rm(renameDir, { recursive: true, force: true });
    });

    describe('Given a base commit and a rename commit that exactly renames a whole sub-directory', () => {
      describe('When diffing non-recursively with detectRenames:true AND ignoreWhitespace:"all", comparing to `git diff-tree --no-ext-diff -w -M` (no -r)', () => {
        it('Then both drop the directory-mode rename entirely (a tree pair cannot be line-diffed)', async () => {
          // Arrange
          const liveRaw = await runGitAsync([
            '-C',
            renameDir,
            'diff-tree',
            '--no-ext-diff',
            '-w',
            '-M',
            renameFrom,
            renameTo,
          ]);

          // Act
          const result = await renameRepo.diff({
            from: renameFrom,
            to: renameTo,
            detectRenames: true,
            ignoreWhitespace: 'all',
          });

          // Assert
          expect(liveRaw.trim()).toBe('');
          expect(result.changes).toHaveLength(0);
        });
      });

      describe('When diffing non-recursively with detectRenames:true AND withStat:true, comparing to `git diff-tree --no-ext-diff -M --numstat -z` (no -r)', () => {
        it('Then both recurse before pairing, matching every leaf by similarity instead of pairing the whole directory', async () => {
          // Arrange
          const liveNumstatZ = await runGitAsync([
            '-C',
            renameDir,
            'diff-tree',
            '--no-ext-diff',
            '-M',
            '--numstat',
            '-z',
            renameFrom,
            renameTo,
          ]);
          const liveRows = parseRenameNumstatZ(liveNumstatZ);

          // Act
          const result = await renameRepo.diff({
            from: renameFrom,
            to: renameTo,
            detectRenames: true,
            withStat: true,
          });

          // Assert
          expect(renameNumstatRowsFromStatDiff(result.changes)).toEqual(liveRows);
          expect(liveRows).toEqual([
            { added: 0, deleted: 0, oldPath: 'oldname/inner.txt', newPath: 'newname/inner.txt' },
            {
              added: 0,
              deleted: 0,
              oldPath: 'oldname/sub/deep.txt',
              newPath: 'newname/sub/deep.txt',
            },
          ]);
        });
      });
    });

    describe('Given a rename commit and a further commit that both moves the directory again and edits one leaf', () => {
      describe('When diffing non-recursively with detectRenames:true AND withStat:true, comparing to `git diff-tree --no-ext-diff -M --numstat -z` (no -r)', () => {
        it('Then both pair leaves by similarity, carrying real line counts on the edited leaf and 0/0 on the untouched one', async () => {
          // Arrange
          const liveNumstatZ = await runGitAsync([
            '-C',
            renameDir,
            'diff-tree',
            '--no-ext-diff',
            '-M',
            '--numstat',
            '-z',
            renameTo,
            renameTo2,
          ]);
          const liveRows = parseRenameNumstatZ(liveNumstatZ);

          // Act
          const result = await renameRepo.diff({
            from: renameTo,
            to: renameTo2,
            detectRenames: true,
            withStat: true,
          });

          // Assert
          expect(renameNumstatRowsFromStatDiff(result.changes)).toEqual(liveRows);
          expect(liveRows).toEqual([
            {
              added: 1,
              deleted: 0,
              oldPath: 'newname/inner.txt',
              newPath: 'renamed2/inner.txt',
            },
            {
              added: 0,
              deleted: 0,
              oldPath: 'newname/sub/deep.txt',
              newPath: 'renamed2/sub/deep.txt',
            },
          ]);
        });
      });

      describe('When diffing non-recursively with --no-renames AND withStat:true, comparing to `git diff-tree --no-ext-diff --no-renames --numstat` (no -r)', () => {
        it('Then both recurse into per-leaf add/delete pairs without any similarity pairing', async () => {
          // Arrange
          const liveNumstat = await runGitAsync([
            '-C',
            renameDir,
            'diff-tree',
            '--no-ext-diff',
            '--no-renames',
            '--numstat',
            renameTo,
            renameTo2,
          ]);
          const liveRows = parseNumstat(liveNumstat);

          // Act
          const result = await renameRepo.diff({ from: renameTo, to: renameTo2, withStat: true });

          // Assert
          expect(numstatRowsFromStatDiff(result.changes)).toEqual(liveRows);
        });
      });
    });
  },
);
