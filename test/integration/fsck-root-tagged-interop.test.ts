/**
 * Cross-tool interop — `fsck --root --tags`. git prints the `root` and
 * `tagged` lines from `fsck_obj` alone, so a full run prints them and a
 * `--connectivity-only` run never does. Each row runs real `git fsck` and
 * tsgit's on the same repository and rebuilds git's lines from tsgit's
 * structured findings — compared as sets: git prints them in its object
 * iteration order, a display concern the structured findings leave to the caller.
 *
 * @proves
 *   surface:        fsck
 *   bucket:         cross-tool-interop
 *   unique:         tsgit fsck reports root and tagged findings exactly where git prints them
 *   interopSurface: fsck
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FsckFinding } from '../../src/application/commands/fsck.js';
import { openRepository } from '../../src/index.node.js';
import {
  disableAutoMaintenance,
  GIT_AVAILABLE,
  runGit,
  tryRunGitWithExit,
} from './interop-helpers.js';

const ROW_TIMEOUT = 30_000;
const ROOT_OR_TAGGED_LINE = /^(root|tagged) /;

let root: string;

beforeAll(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'tsgit-interop-fsck-root-tagged-')));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Two commits on main and an annotated tag `v1` naming the tip. */
const taggedHistory = (slug: string): string => {
  const dir = path.join(root, slug);
  runGit(['init', '-q', '-b', 'main', dir]);
  disableAutoMaintenance(dir);
  for (const message of ['c1', 'c2']) {
    runGit(['-C', dir, 'commit', '-q', '--allow-empty', '-m', message]);
  }
  runGit(['-C', dir, 'tag', '-a', '-m', 't', 'v1']);
  return dir;
};

/** Writes `body` as a loose `type` object git would refuse to build itself. */
const literally = (dir: string, type: string, body: string): string =>
  runGit(['-C', dir, 'hash-object', '-t', type, '-w', '--literally', '--stdin'], {
    input: body,
  }).trim();

const IDENT = 'Ada <ada@example.com> 1700000000 +0000';

/** Unreachable objects `fsck_obj` checks all the same. */
const UNREACHABLE_ROWS: ReadonlyArray<{
  readonly name: string;
  readonly plant: (dir: string) => void;
}> = [
  {
    name: 'an unreachable root commit and a tag naming it',
    plant: (dir) => {
      const tree = runGit(['-C', dir, 'rev-parse', 'HEAD^{tree}']).trim();
      const orphan = runGit(['-C', dir, 'commit-tree', tree, '-m', 'orphan']).trim();
      literally(dir, 'tag', `object ${orphan}\ntype commit\ntag u\ntagger ${IDENT}\n\nm\n`);
    },
  },
  {
    name: 'an unreachable tag naming an absent commit',
    plant: (dir) => {
      literally(dir, 'tag', `object ${'1'.repeat(40)}\ntype commit\ntag u\ntagger ${IDENT}\n\nm\n`);
    },
  },
  {
    name: 'an unreachable root commit failing its content check',
    plant: (dir) => {
      const tree = runGit(['-C', dir, 'rev-parse', 'HEAD^{tree}']).trim();
      literally(
        dir,
        'commit',
        `tree ${tree}\nauthor Ada<ada@example.com> 1 +0000\ncommitter ${IDENT}\n\nm\n`,
      );
    },
  },
];

const renderLine = (finding: FsckFinding): string | undefined => {
  if (finding.type === 'root') return `root ${finding.id}`;
  if (finding.type === 'tagged') {
    return `tagged ${finding.objectType} ${finding.id} (${finding.tagName}) in ${finding.tag}`;
  }
  return undefined;
};

describe.skipIf(!GIT_AVAILABLE)('Given a tagged history', () => {
  describe.each([
    { mode: 'a full fsck', flags: [] as ReadonlyArray<string>, connectivityOnly: false },
    { mode: 'a connectivity-only fsck', flags: ['--connectivity-only'], connectivityOnly: true },
  ])('When $mode runs under git and tsgit', ({ mode, flags, connectivityOnly }) => {
    it(
      'Then tsgit reports the root and tagged lines git prints',
      async () => {
        // Arrange
        const dir = taggedHistory(mode.replace(/[^a-z]+/g, '-'));
        const expected = runGit(['-C', dir, 'fsck', '--root', '--tags', ...flags])
          .split('\n')
          .filter((line) => ROOT_OR_TAGGED_LINE.test(line))
          .sort();
        const repo = await openRepository({ cwd: dir });
        const sut = repo.fsck;

        // Act
        const result = await sut({ connectivityOnly }).finally(() => repo.dispose());

        // Assert
        expect(
          result.findings
            .map(renderLine)
            .filter((line) => line !== undefined)
            .sort(),
        ).toEqual(expected);
      },
      ROW_TIMEOUT,
    );
  });
});

describe.skipIf(!GIT_AVAILABLE)('Given a tagged history', () => {
  describe.each(UNREACHABLE_ROWS)('When it also holds $name', ({ name, plant }) => {
    it(
      'Then tsgit reports the root and tagged lines a full git fsck prints',
      async () => {
        // Arrange
        const dir = taggedHistory(name.replace(/[^a-z]+/g, '-'));
        plant(dir);
        const expected = tryRunGitWithExit(['-C', dir, 'fsck', '--root', '--tags'])
          .stdout.split('\n')
          .filter((line) => ROOT_OR_TAGGED_LINE.test(line))
          .sort();
        const repo = await openRepository({ cwd: dir });
        const sut = repo.fsck;

        // Act
        const result = await sut({}).finally(() => repo.dispose());

        // Assert
        expect(
          result.findings
            .map(renderLine)
            .filter((line) => line !== undefined)
            .sort(),
        ).toEqual(expected);
      },
      ROW_TIMEOUT,
    );
  });
});
