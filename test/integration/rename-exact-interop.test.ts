/**
 * Cross-tool interop — the exact rename pass (`detectRenames`) against real
 * `git diff -M`/`diff-tree -M`.
 *
 * Builds one throwaway repo per row (before/after commit pair) and compares
 * tsgit's structured `TreeDiff`, reconstructed as a `--name-status` line, to
 * live git byte-for-byte: one-shot source consumption, basename preference,
 * the exec-bit/mode rule, the 100-candidate cap, and limit-freedom.
 *
 * @proves
 *   surface:        diff.renames
 *   bucket:         cross-tool-interop
 *   unique:         exact rename pairing (one-shot source, basename preference, mode rule, 100-candidate cap, limit-free) matches git diff --name-status
 *   interopSurface: diff
 */
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/index.js';
import { diff } from '../../src/application/commands/diff.js';
import type { RenameDetectOptions, TreeDiff } from '../../src/domain/diff/index.js';
import { GIT_AVAILABLE, git, runGit, runGitEnv } from './interop-helpers.js';

// ~20 throwaway repos, each spawning several git processes — the shared type
// change interop suite needs the same headroom under the full validate run's
// parallel git load.
const SETUP_TIMEOUT = 120_000;
const DEFAULT_CONTENT = 'x\n';

interface FileSpec {
  readonly path: string;
  readonly content: string;
  readonly kind?: 'exec' | 'symlink';
}

interface Row {
  readonly label: string;
  readonly before: ReadonlyArray<FileSpec>;
  readonly after: ReadonlyArray<FileSpec>;
  readonly gitFlags?: ReadonlyArray<string>;
  readonly renameOptions?: RenameDetectOptions;
  readonly recursive?: boolean;
  readonly gitCommand?: 'diff' | 'diff-tree';
}

/** Zero-padded so path-byte order matches numeric order: a/F001..a/F101. */
const manyFiles = (count: number, content = DEFAULT_CONTENT): FileSpec[] =>
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

let epoch = 1_700_020_000;
const nextEpoch = (): number => (epoch += 1);

/** One throwaway repo per row: a before commit, then a full replace + after commit. */
async function buildRow(row: Row): Promise<{ readonly dir: string }> {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-rename-exact-')));
  runGit(['init', '-q', '-b', 'main', dir]);
  runGit(['-C', dir, 'config', 'user.name', 'Ada']);
  runGit(['-C', dir, 'config', 'user.email', 'ada@example.com']);

  await writeFiles(dir, row.before);
  git(dir, 'add', '-A');
  runGit(['-C', dir, 'commit', '-q', '-m', 'before'], { env: dateEnv(nextEpoch()) });

  git(dir, 'rm', '-r', '-q', '.');
  await writeFiles(dir, row.after);
  git(dir, 'add', '-A');
  runGit(['-C', dir, 'commit', '-q', '-m', 'after'], { env: dateEnv(nextEpoch()) });

  return { dir };
}

/** Reconstruct a `--name-status -M` line per change; every rename/copy in this
 *  suite is an exact (100%) pair. */
function nameStatusFrom(treeDiff: TreeDiff): string {
  return treeDiff.changes
    .map((c) => {
      if (c.type === 'add') return `A\t${c.newPath}`;
      if (c.type === 'delete') return `D\t${c.oldPath}`;
      if (c.type === 'rename') return `R100\t${c.oldPath}\t${c.newPath}`;
      if (c.type === 'copy') return `C100\t${c.oldPath}\t${c.newPath}`;
      if (c.type === 'modify') return `M\t${c.path}`;
      return `T\t${c.path}`;
    })
    .join('\n');
}

function gitPeerNameStatus(dir: string, row: Row): string {
  const flags = row.gitFlags ?? [];
  if (row.gitCommand === 'diff-tree') {
    return git(
      dir,
      'diff-tree',
      '--no-ext-diff',
      '-M',
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
    '-M',
    ...flags,
    'HEAD~1',
    'HEAD',
  ).trim();
}

const ROWS: ReadonlyArray<Row> = [
  {
    label: '1 source, 2 identical adds — first in path order folds (R Foo→Bar ; A Baz) [#1]',
    before: [{ path: 'a/Foo.meta', content: DEFAULT_CONTENT }],
    after: [
      { path: 'b/Bar.meta', content: DEFAULT_CONTENT },
      { path: 'b/Baz.meta', content: DEFAULT_CONTENT },
    ],
  },
  {
    label:
      'basename-matching add processed second — path order still wins (R Foo→Bar ; A b/Foo) [#2]',
    before: [{ path: 'a/Foo.meta', content: DEFAULT_CONTENT }],
    after: [
      { path: 'b/Bar.meta', content: DEFAULT_CONTENT },
      { path: 'b/Foo.meta', content: DEFAULT_CONTENT },
    ],
  },
  {
    label:
      '2 sources sharing an id, no basename match — first in path order folds (D Qux ; R Foo→Bar) [#3]',
    before: [
      { path: 'a/Foo.meta', content: DEFAULT_CONTENT },
      { path: 'a/Qux.meta', content: DEFAULT_CONTENT },
    ],
    after: [{ path: 'b/Bar.meta', content: DEFAULT_CONTENT }],
  },
  {
    label: '2 sources sharing an id, basename = second delete (D Foo ; R Qux→Qux) [#4]',
    before: [
      { path: 'a/Foo.meta', content: DEFAULT_CONTENT },
      { path: 'a/Qux.meta', content: DEFAULT_CONTENT },
    ],
    after: [{ path: 'b/Qux.meta', content: DEFAULT_CONTENT }],
  },
  {
    label: '2 sources, 2 adds, no basename overlap (R Foo→Bar ; R Qux→Baz) [#5]',
    before: [
      { path: 'a/Foo.meta', content: DEFAULT_CONTENT },
      { path: 'a/Qux.meta', content: DEFAULT_CONTENT },
    ],
    after: [
      { path: 'b/Bar.meta', content: DEFAULT_CONTENT },
      { path: 'b/Baz.meta', content: DEFAULT_CONTENT },
    ],
  },
  {
    label: '1 source, 3 identical adds — first in path order folds (R Foo→A ; A B ; A C) [#6]',
    before: [{ path: 'a/Foo.meta', content: DEFAULT_CONTENT }],
    after: [
      { path: 'b/A.meta', content: DEFAULT_CONTENT },
      { path: 'b/B.meta', content: DEFAULT_CONTENT },
      { path: 'b/C.meta', content: DEFAULT_CONTENT },
    ],
  },
  {
    label: '2 sources, 2 adds, basename preference per add (R Qux→Qux ; R Foo→Zed) [#7]',
    before: [
      { path: 'a/Foo.meta', content: DEFAULT_CONTENT },
      { path: 'a/Qux.meta', content: DEFAULT_CONTENT },
    ],
    after: [
      { path: 'b/Qux.meta', content: DEFAULT_CONTENT },
      { path: 'b/Zed.meta', content: DEFAULT_CONTENT },
    ],
  },
  {
    label: '#3 with rename limit 1 — exact pairing unaffected (D Qux ; R Foo→Bar) [#8]',
    before: [
      { path: 'a/Foo.meta', content: DEFAULT_CONTENT },
      { path: 'a/Qux.meta', content: DEFAULT_CONTENT },
    ],
    after: [{ path: 'b/Bar.meta', content: DEFAULT_CONTENT }],
    gitFlags: ['-l1'],
    renameOptions: { limit: 1 },
  },
  {
    label:
      'symlink source pairs with the symlink add, not the mode-incompatible regular add (A b/file ; R link→link2) [#12]',
    before: [{ path: 'a/link', content: 'target', kind: 'symlink' }],
    after: [
      { path: 'b/file', content: 'target' },
      { path: 'b/link2', content: 'target', kind: 'symlink' },
    ],
  },
  {
    label: 'regular source pairs across the executable bit (R Foo→Bar ; A Baz) [#13]',
    before: [{ path: 'a/Foo.sh', content: DEFAULT_CONTENT }],
    after: [
      { path: 'b/Bar.sh', content: DEFAULT_CONTENT, kind: 'exec' },
      { path: 'b/Baz.sh', content: DEFAULT_CONTENT },
    ],
  },
  {
    label: 'empty blob — 1 source, 2 adds (R Foo→Bar ; A Baz) [#14]',
    before: [{ path: 'a/Foo.meta', content: '' }],
    after: [
      { path: 'b/Bar.meta', content: '' },
      { path: 'b/Baz.meta', content: '' },
    ],
  },
  {
    label:
      '101 sources sharing an id, no basename match — cap holds the first (R F001→Bar + 100 D) [#15]',
    before: manyFiles(101),
    after: [{ path: 'b/Bar.meta', content: DEFAULT_CONTENT }],
  },
  {
    label:
      '101 sources + a basename match as the 102nd eligible — cap hides it (R F001→Zzz + D Zzz) [#16]',
    before: [...manyFiles(101), { path: 'a/Zzz.meta', content: DEFAULT_CONTENT }],
    after: [{ path: 'b/Zzz.meta', content: DEFAULT_CONTENT }],
  },
  {
    label:
      '99 sources + a basename match as the 100th eligible — the cap is not yet reached (R Zzz→Zzz) [#16a]',
    before: [...manyFiles(99), { path: 'a/Zzz.meta', content: DEFAULT_CONTENT }],
    after: [{ path: 'b/Zzz.meta', content: DEFAULT_CONTENT }],
  },
  {
    label:
      '100 sources + a basename match as the 101st eligible — cap hides it (R F001→Zzz) [#16b]',
    before: [...manyFiles(100), { path: 'a/Zzz.meta', content: DEFAULT_CONTENT }],
    after: [{ path: 'b/Zzz.meta', content: DEFAULT_CONTENT }],
  },
  {
    label: '#15 with rename limit 1 — exact pairing unaffected (R F001→Bar + 100 D) [#17]',
    before: manyFiles(101),
    after: [{ path: 'b/Bar.meta', content: DEFAULT_CONTENT }],
    gitFlags: ['-l1'],
    renameOptions: { limit: 1 },
  },
  {
    label: '3 sources sharing an id, basename = third delete (D Foo ; D Qux ; R Zed→Zed) [#18]',
    before: [
      { path: 'a/Foo.meta', content: DEFAULT_CONTENT },
      { path: 'a/Qux.meta', content: DEFAULT_CONTENT },
      { path: 'a/Zed.meta', content: DEFAULT_CONTENT },
    ],
    after: [{ path: 'b/Zed.meta', content: DEFAULT_CONTENT }],
  },
  {
    label:
      'directory rename + copy, diff-tree non-recursive — tree entries pair by id (R x→y ; A z) [D1]',
    before: [
      { path: 'x/f', content: 'l1\n' },
      { path: 'x/g', content: 'l2\n' },
    ],
    after: [
      { path: 'y/f', content: 'l1\n' },
      { path: 'y/g', content: 'l2\n' },
      { path: 'z/f', content: 'l1\n' },
      { path: 'z/g', content: 'l2\n' },
    ],
    recursive: false,
    gitCommand: 'diff-tree',
  },
  {
    label:
      'directory rename + copy, recursive — every leaf pairs by id (R x/f→y/f ; R x/g→y/g ; A z/f ; A z/g) [D1r]',
    before: [
      { path: 'x/f', content: 'l1\n' },
      { path: 'x/g', content: 'l2\n' },
    ],
    after: [
      { path: 'y/f', content: 'l1\n' },
      { path: 'y/g', content: 'l2\n' },
      { path: 'z/f', content: 'l1\n' },
      { path: 'z/g', content: 'l2\n' },
    ],
    recursive: true,
  },
];

const fixtures = new Map<string, { readonly dir: string }>();

function fixtureOf(label: string): { readonly dir: string } {
  const found = fixtures.get(label);
  if (found === undefined) throw new Error(`fixture not built for row: ${label}`);
  return found;
}

describe.skipIf(!GIT_AVAILABLE)('exact rename pass interop', () => {
  beforeAll(async () => {
    for (const row of ROWS) {
      fixtures.set(row.label, await buildRow(row));
    }
  }, SETUP_TIMEOUT);

  afterAll(async () => {
    for (const { dir } of fixtures.values()) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  describe('Given a raw diff pair exercising the exact rename pass', () => {
    describe('When diff is called with detectRenames', () => {
      it.each(ROWS)('Then name-status matches live git for: $label', async (row) => {
        // Arrange
        const { dir } = fixtureOf(row.label);
        const ctx = createNodeContext({ workDir: dir });
        const peer = gitPeerNameStatus(dir, row);

        // Act
        const result = await diff(ctx, {
          from: 'HEAD~1',
          to: 'HEAD',
          detectRenames: true,
          recursive: row.recursive ?? true,
          ...(row.renameOptions !== undefined ? { renameOptions: row.renameOptions } : {}),
        });
        const ours = nameStatusFrom(result);

        // Assert
        expect(ours).toBe(peer);
      });
    });
  });
});
