/**
 * Cross-tool interop — `whatchanged`. Builds one repository with canonical git
 * (deterministic dates, signing off) containing a root, a modify+add, a rename,
 * an empty commit, and a `--no-ff` merge, then opens the SAME repo through
 * `openRepository` and proves `repo.whatchanged` is byte-faithful to
 * `git whatchanged` (≡ `git log --raw --no-merges`):
 *
 *   1. walk + no-merges  — the emitted oids equal `git log --no-merges --format=%H`
 *      (merge dropped, side-branch ancestor kept);
 *   2. raw lines          — each entry's structured `changes` reconstructs git's
 *      `:<mode> <mode> <sha> <sha> <status>\t<path>` raw lines byte-for-byte
 *      (root vs empty tree, modify+add, exact rename `R100`, empty change set);
 *   3. first-parent       — `order: 'first-parent'` equals
 *      `git log --first-parent --no-merges --format=%H`.
 *
 * The library emits no raw line — faithfulness is reconstructed here from the
 * structured fields and compared to real `git`.
 *
 * @proves
 *   surface:        whatchanged
 *   bucket:         cross-tool-interop
 *   unique:         whatchanged data reconstructs git log --raw --no-merges
 *   interopSurface: whatchanged
 */
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DiffChange } from '../../src/domain/diff/index.js';
import { openRepository } from '../../src/index.node.js';
import { GIT_AVAILABLE, git, runGit, runGitEnv } from './interop-helpers.js';

const SETUP_TIMEOUT = 60_000;
const ZERO_OID = '0'.repeat(40);

const IDENTITY = {
  GIT_AUTHOR_NAME: 'Ada',
  GIT_AUTHOR_EMAIL: 'ada@example.com',
  GIT_COMMITTER_NAME: 'Ada',
  GIT_COMMITTER_EMAIL: 'ada@example.com',
} as const;

const dateEnv = (epoch: number): NodeJS.ProcessEnv => ({
  ...runGitEnv(),
  ...IDENTITY,
  GIT_AUTHOR_DATE: `${epoch} +0000`,
  GIT_COMMITTER_DATE: `${epoch} +0000`,
});

const nonEmptyLines = (out: string): ReadonlyArray<string> =>
  out.split('\n').filter((line) => line.length > 0);

/** Reconstruct git's `--raw` line for one structured change. */
const rawLine = (c: DiffChange): string => {
  switch (c.type) {
    case 'add':
      return `:000000 ${c.newMode} ${ZERO_OID} ${c.newId} A\t${c.newPath}`;
    case 'delete':
      return `:${c.oldMode} 000000 ${c.oldId} ${ZERO_OID} D\t${c.oldPath}`;
    case 'modify':
      return `:${c.oldMode} ${c.newMode} ${c.oldId} ${c.newId} M\t${c.path}`;
    case 'type-change':
      return `:${c.oldMode} ${c.newMode} ${c.oldId} ${c.newId} T\t${c.path}`;
    case 'rename':
      return `:${c.mode} ${c.mode} ${c.id} ${c.id} R100\t${c.oldPath}\t${c.newPath}`;
  }
};

/** git's own raw lines for a single commit (recursive, rename-aware, full oids). */
const gitRawLines = (dir: string, oid: string): ReadonlyArray<string> =>
  nonEmptyLines(git(dir, 'diff-tree', '-r', '-M', '--root', '--no-commit-id', '--abbrev=40', oid));

let dir = '';
let repo: Awaited<ReturnType<typeof openRepository>>;

describe.skipIf(!GIT_AVAILABLE)('whatchanged interop', () => {
  beforeAll(async () => {
    dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-whatchanged-')));
    runGit(['init', '-q', '-b', 'main', dir]);

    const commit = async (epoch: number, message: string): Promise<void> => {
      git(dir, 'add', '-A');
      runGit(['-C', dir, 'commit', '-q', '-m', message], { env: dateEnv(epoch) });
    };

    await writeFile(path.join(dir, 'a.txt'), 'a\n');
    await commit(1_700_000_001, 'root');
    await writeFile(path.join(dir, 'a.txt'), 'a2\n');
    await writeFile(path.join(dir, 'b.txt'), 'b\n');
    await commit(1_700_000_002, 'modify a, add b');
    git(dir, 'mv', 'a.txt', 'c.txt');
    await commit(1_700_000_003, 'rename a to c');
    runGit(['-C', dir, 'commit', '-q', '--allow-empty', '-m', 'empty'], {
      env: dateEnv(1_700_000_004),
    });
    runGit(['-C', dir, 'checkout', '-q', '-b', 'side', 'HEAD~3']);
    await writeFile(path.join(dir, 's.txt'), 's\n');
    await commit(1_700_000_005, 'side');
    git(dir, 'checkout', '-q', 'main');
    runGit(['-C', dir, 'merge', '-q', '--no-ff', '-m', 'merge side', 'side'], {
      env: dateEnv(1_700_000_006),
    });

    repo = await openRepository({ cwd: dir });
  }, SETUP_TIMEOUT);

  afterAll(async () => {
    await repo.dispose();
    await rm(dir, { recursive: true, force: true });
  });

  it('Then the emitted oids equal git log --no-merges (merge dropped, ancestors kept)', async () => {
    // Arrange
    const peer = nonEmptyLines(git(dir, 'log', '--no-merges', '--format=%H'));

    // Act
    const ours = (await repo.whatchanged()).map((e) => e.id);

    // Assert
    expect(ours).toEqual(peer);
  });

  it('Then each entry reconstructs git whatchanged raw lines byte-for-byte', async () => {
    // Act
    const entries = await repo.whatchanged();

    // Assert — every commit's structured changes equal git's raw lines
    for (const entry of entries) {
      expect(entry.changes.changes.map(rawLine)).toEqual(gitRawLines(dir, entry.id));
    }
  });

  it('Then the first-parent walk equals git log --first-parent --no-merges', async () => {
    // Arrange
    const peer = nonEmptyLines(git(dir, 'log', '--first-parent', '--no-merges', '--format=%H'));

    // Act
    const ours = (await repo.whatchanged({ order: 'first-parent' })).map((e) => e.id);

    // Assert
    expect(ours).toEqual(peer);
  });
});
