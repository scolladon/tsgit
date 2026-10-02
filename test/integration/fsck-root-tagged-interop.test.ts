/**
 * Cross-tool interop — `fsck --root --tags`. git prints the `root` and
 * `tagged` lines from `fsck_obj` alone, so a full run prints them and a
 * `--connectivity-only` run never does. Each row runs real `git fsck` and
 * tsgit's on the same repository and rebuilds git's lines from tsgit's
 * structured findings.
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
import { disableAutoMaintenance, GIT_AVAILABLE, runGit } from './interop-helpers.js';

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
          .filter((line) => ROOT_OR_TAGGED_LINE.test(line));
        const repo = await openRepository({ cwd: dir });
        const sut = repo.fsck;

        // Act
        const result = await sut({ connectivityOnly }).finally(() => repo.dispose());

        // Assert
        expect(result.findings.map(renderLine).filter((line) => line !== undefined)).toEqual(
          expected,
        );
      },
      ROW_TIMEOUT,
    );
  });
});
