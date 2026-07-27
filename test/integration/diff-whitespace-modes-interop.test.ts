/**
 * Cross-tool interop — the streaming drop-pass predicate (B4, no `withStat`)
 * and the interned-int stat pass (`withStat: true`) must survive the exact
 * same files as real `git diff --name-status` for each of the five
 * whitespace/CR/blank-line flags. One shared repo (built once in `beforeAll`)
 * carries a linear commit per flag, each touching a mode-only-different file
 * (must be dropped) alongside a real-content-change file (must survive).
 *
 * @proves
 *   surface:        diff.ignoreWhitespace / diff.ignoreCrAtEol / diff.ignoreBlankLines
 *   bucket:         cross-tool-interop
 *   unique:         the streaming predicate path and the interned-Myers stat path agree with
 *                    each other AND with git's --ignore-all-space / --ignore-space-change /
 *                    --ignore-space-at-eol / --ignore-cr-at-eol / --ignore-blank-lines survivors
 *   interopSurface: diff
 */
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TreeDiff } from '../../src/domain/diff/index.js';
import { openRepository } from '../../src/index.node.js';
import { GIT_AVAILABLE, runGitAsync, runGitEnv } from './interop-helpers.js';

const IDENTITY = {
  GIT_AUTHOR_NAME: 'Ada',
  GIT_AUTHOR_EMAIL: 'ada@example.com',
  GIT_COMMITTER_NAME: 'Ada',
  GIT_COMMITTER_EMAIL: 'ada@example.com',
  GIT_AUTHOR_DATE: '1700020000 +0000',
  GIT_COMMITTER_DATE: '1700020000 +0000',
} as const;

interface ScenarioDiffOpts {
  readonly ignoreWhitespace?: 'all' | 'change' | 'at-eol';
  readonly ignoreCrAtEol?: boolean;
  readonly ignoreBlankLines?: boolean;
}

interface Scenario {
  readonly label: string;
  readonly gitFlag: string;
  readonly diffOpts: ScenarioDiffOpts;
  readonly modeOnlyBefore: string;
  readonly modeOnlyAfter: string;
  /**
   * `--ignore-blank-lines` only suppresses numstat/patch output for a
   * blank-only change — the file still shows up in `--name-only` (matches
   * the existing whitespace-interop BL1 finding). Every other flag drops
   * the mode-only file from name-status entirely.
   */
  readonly modeOnlySurvivesNameStatus: boolean;
}

const SCENARIOS: ReadonlyArray<Scenario> = [
  {
    label: 'ignore-all-space',
    gitFlag: '--ignore-all-space',
    diffOpts: { ignoreWhitespace: 'all' },
    modeOnlyBefore: 'a b\n',
    modeOnlyAfter: 'a  b\n',
    modeOnlySurvivesNameStatus: false,
  },
  {
    label: 'ignore-space-change',
    gitFlag: '--ignore-space-change',
    diffOpts: { ignoreWhitespace: 'change' },
    modeOnlyBefore: 'a b\n',
    modeOnlyAfter: 'a    b\n',
    modeOnlySurvivesNameStatus: false,
  },
  {
    label: 'ignore-space-at-eol',
    gitFlag: '--ignore-space-at-eol',
    diffOpts: { ignoreWhitespace: 'at-eol' },
    modeOnlyBefore: 'a\n',
    modeOnlyAfter: 'a   \n',
    modeOnlySurvivesNameStatus: false,
  },
  {
    label: 'ignore-cr-at-eol',
    gitFlag: '--ignore-cr-at-eol',
    diffOpts: { ignoreCrAtEol: true },
    modeOnlyBefore: 'a\r\n',
    modeOnlyAfter: 'a\n',
    modeOnlySurvivesNameStatus: false,
  },
  {
    label: 'ignore-blank-lines',
    gitFlag: '--ignore-blank-lines',
    diffOpts: { ignoreBlankLines: true },
    modeOnlyBefore: 'a\n',
    modeOnlyAfter: 'a\n\n',
    modeOnlySurvivesNameStatus: true,
  },
];

const REAL_BEFORE = 'real one\n';
const REAL_AFTER = 'real two\n';

let dir = '';
let repo: Awaited<ReturnType<typeof openRepository>>;
const shaByLabel = new Map<string, { readonly from: string; readonly to: string }>();

describe.skipIf(!GIT_AVAILABLE)(
  'integration — whitespace-mode predicate/stat parity',
  { timeout: 60_000 },
  () => {
    beforeAll(async () => {
      dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-ws-modes-interop-')));
      await runGitAsync(['init', '-q', '-b', 'main', dir]);
      await runGitAsync(['-C', dir, 'config', 'user.name', 'Ada']);
      await runGitAsync(['-C', dir, 'config', 'user.email', 'ada@example.com']);

      for (const scenario of SCENARIOS) {
        await writeFile(path.join(dir, 'mode-only.txt'), scenario.modeOnlyBefore);
        await writeFile(path.join(dir, 'real.txt'), REAL_BEFORE);
        await runGitAsync(['-C', dir, 'add', 'mode-only.txt', 'real.txt']);
        await runGitAsync(['-C', dir, 'commit', '-q', '-m', `${scenario.label}-base`], {
          env: { ...runGitEnv(), ...IDENTITY },
        });
        const from = (await runGitAsync(['-C', dir, 'rev-parse', 'HEAD'])).trim();

        await writeFile(path.join(dir, 'mode-only.txt'), scenario.modeOnlyAfter);
        await writeFile(path.join(dir, 'real.txt'), REAL_AFTER);
        await runGitAsync(['-C', dir, 'add', 'mode-only.txt', 'real.txt']);
        await runGitAsync(['-C', dir, 'commit', '-q', '-m', `${scenario.label}-change`], {
          env: { ...runGitEnv(), ...IDENTITY },
        });
        const to = (await runGitAsync(['-C', dir, 'rev-parse', 'HEAD'])).trim();

        shaByLabel.set(scenario.label, { from, to });
      }

      repo = await openRepository({ cwd: dir });
    });

    afterAll(async () => {
      await repo.dispose();
      await rm(dir, { recursive: true, force: true });
    });

    const survivorPaths = (treeDiff: TreeDiff): ReadonlyArray<string> =>
      treeDiff.changes
        .filter((c): c is typeof c & { readonly type: 'modify' } => c.type === 'modify')
        .map((c) => c.path as string)
        .sort();

    describe.each(SCENARIOS)('Given a $label change set', (scenario) => {
      describe('When diffing with the predicate path (no withStat), the stat path (withStat:true), and real git', () => {
        it('Then all three agree on which files survive', async () => {
          // Arrange
          const { from, to } = shaByLabel.get(scenario.label)!;
          const liveNameStatus = await runGitAsync([
            '-C',
            dir,
            'diff',
            '--no-ext-diff',
            '--name-only',
            scenario.gitFlag,
            from,
            to,
          ]);
          const livePaths = liveNameStatus
            .split('\n')
            .filter((l) => l.length > 0)
            .sort();

          // Act
          const predicateResult = await repo.diff({ from, to, ...scenario.diffOpts });
          const statResult = await repo.diff({ from, to, ...scenario.diffOpts, withStat: true });

          // Assert
          expect(survivorPaths(predicateResult)).toEqual(livePaths);
          expect(survivorPaths(statResult)).toEqual(livePaths);
          expect(survivorPaths(predicateResult)).toEqual(survivorPaths(statResult));
          expect(livePaths).toEqual(
            scenario.modeOnlySurvivesNameStatus ? ['mode-only.txt', 'real.txt'] : ['real.txt'],
          );
        });
      });
    });
  },
);
