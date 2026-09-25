/**
 * Shared row-table harness for the rename interop suites (exact pass,
 * similarity pass): fixture shapes, one-repo-per-row building (including
 * gitlink entries), `--name-status` reconstruction and the `diff()` call.
 *
 * Holds no test registration — each suite declares its own `ROWS`, builds
 * its own fixtures in its own `beforeAll`/`afterAll`, and runs its own
 * `it.each` block.
 */
import { chmod, mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { createNodeContext } from '../../src/adapters/node/index.js';
import { diff } from '../../src/application/commands/diff.js';
import type { DiffChange, RenameDetectOptions, TreeDiff } from '../../src/domain/diff/index.js';
import { toSimilarityPercent } from '../../src/domain/diff/similarity.js';
import { git, runGit, runGitEnv } from './interop-helpers.js';

const DEFAULT_CONTENT = 'x\n';
const GITLINK_MODE = '160000';
const PERCENT_WIDTH = 3;

export interface FileSpec {
  readonly path: string;
  readonly content: string;
  readonly kind?: 'exec' | 'symlink' | 'gitlink';
}

export interface RenameRow {
  readonly label: string;
  readonly before: ReadonlyArray<FileSpec>;
  readonly after: ReadonlyArray<FileSpec>;
  readonly gitFlags?: ReadonlyArray<string>;
  readonly renameOptions?: RenameDetectOptions;
  readonly recursive?: boolean;
  readonly gitCommand?: 'diff' | 'diff-tree';
  /** Defaults to true (peer gets `-M`); false makes the peer pass `--no-renames`
   *  and the tsgit call omit `detectRenames`. */
  readonly detectRenames?: boolean;
}

/** Zero-padded so path-byte order matches numeric order: a/F001..a/F101. */
export const manyFiles = (count: number, content = DEFAULT_CONTENT): FileSpec[] =>
  Array.from({ length: count }, (_, i) => ({
    path: `a/F${String(i + 1).padStart(3, '0')}.meta`,
    content,
  }));

const dateEnv = (epoch: number): NodeJS.ProcessEnv => ({
  ...runGitEnv(),
  GIT_AUTHOR_NAME: 'Ada',
  GIT_AUTHOR_EMAIL: 'ada@example.com',
  GIT_COMMITTER_NAME: 'Ada',
  GIT_COMMITTER_EMAIL: 'ada@example.com',
  GIT_AUTHOR_DATE: `${epoch} +0000`,
  GIT_COMMITTER_DATE: `${epoch} +0000`,
});

async function writeFiles(dir: string, specs: ReadonlyArray<FileSpec>): Promise<void> {
  for (const spec of specs) {
    if (spec.kind === 'gitlink') continue;
    const full = path.join(dir, spec.path);
    await mkdir(path.dirname(full), { recursive: true });
    if (spec.kind === 'symlink') {
      await symlink(spec.content, full);
      continue;
    }
    await writeFile(full, spec.content);
    if (spec.kind === 'exec') await chmod(full, 0o755);
  }
}

/** `content` is a 40-hex oid for a `kind: 'gitlink'` spec — staged directly
 *  into the index (there is no working-tree file to write). */
function addGitlinks(dir: string, specs: ReadonlyArray<FileSpec>): void {
  for (const spec of specs) {
    if (spec.kind !== 'gitlink') continue;
    runGit([
      '-C',
      dir,
      'update-index',
      '--add',
      '--cacheinfo',
      `${GITLINK_MODE},${spec.content},${spec.path}`,
    ]);
  }
}

let epoch = 1_700_020_000;
const nextEpoch = (): number => (epoch += 1);

/** One throwaway repo per row: a before commit, then a full replace + after commit. */
export async function buildRenameRow(
  row: RenameRow,
  tmpPrefix: string,
): Promise<{ readonly dir: string }> {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), tmpPrefix)));
  runGit(['init', '-q', '-b', 'main', dir]);
  runGit(['-C', dir, 'config', 'user.name', 'Ada']);
  runGit(['-C', dir, 'config', 'user.email', 'ada@example.com']);

  await writeFiles(dir, row.before);
  git(dir, 'add', '-A');
  addGitlinks(dir, row.before);
  runGit(['-C', dir, 'commit', '-q', '-m', 'before'], { env: dateEnv(nextEpoch()) });

  git(dir, 'rm', '-r', '-q', '.');
  await writeFiles(dir, row.after);
  git(dir, 'add', '-A');
  addGitlinks(dir, row.after);
  runGit(['-C', dir, 'commit', '-q', '-m', 'after'], { env: dateEnv(nextEpoch()) });

  return { dir };
}

function scoreLabel(kind: 'R' | 'C' | 'M', score: number): string {
  return `${kind}${String(toSimilarityPercent(score)).padStart(PERCENT_WIDTH, '0')}`;
}

/** Reconstruct a `--name-status` line per change. R/C print the similarity
 *  percent (exact pairs still print R100/C100); a kept-broken modify prints
 *  its dissimilarity percent, an ordinary modify stays bare `M`. */
function nameStatusLine(change: DiffChange): string {
  switch (change.type) {
    case 'add':
      return `A\t${change.newPath}`;
    case 'delete':
      return `D\t${change.oldPath}`;
    case 'rename':
      return `${scoreLabel('R', change.similarity.score)}\t${change.oldPath}\t${change.newPath}`;
    case 'copy':
      return `${scoreLabel('C', change.similarity.score)}\t${change.oldPath}\t${change.newPath}`;
    case 'modify':
      return change.broken !== undefined
        ? `${scoreLabel('M', change.broken.score)}\t${change.path}`
        : `M\t${change.path}`;
    case 'type-change':
      return `T\t${change.path}`;
  }
}

export function nameStatusFrom(treeDiff: TreeDiff): string {
  return treeDiff.changes.map(nameStatusLine).join('\n');
}

export function gitPeerNameStatus(dir: string, row: RenameRow): string {
  const flags = row.gitFlags ?? [];
  const renameFlag = row.detectRenames === false ? '--no-renames' : '-M';
  if (row.gitCommand === 'diff-tree') {
    return git(
      dir,
      'diff-tree',
      '--no-ext-diff',
      renameFlag,
      ...flags,
      '--name-status',
      'HEAD~1',
      'HEAD',
    ).trim();
  }
  return git(
    dir,
    'diff',
    '--no-ext-diff',
    '--name-status',
    renameFlag,
    ...flags,
    'HEAD~1',
    'HEAD',
  ).trim();
}

/** Runs both sides of one row over its already-built repo. */
export async function runRenameRow(
  row: RenameRow,
  dir: string,
): Promise<{ readonly ours: string; readonly peer: string }> {
  const ctx = createNodeContext({ workDir: dir });
  const peer = gitPeerNameStatus(dir, row);
  const result = await diff(ctx, {
    from: 'HEAD~1',
    to: 'HEAD',
    recursive: row.recursive ?? true,
    ...(row.detectRenames !== false ? { detectRenames: true } : {}),
    ...(row.renameOptions !== undefined ? { renameOptions: row.renameOptions } : {}),
  });
  const ours = nameStatusFrom(result);
  return { ours, peer };
}
