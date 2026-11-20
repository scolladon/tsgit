/**
 * Cross-tool interop — a bogus `sparse.expectFilesOutsideOfPatterns` is refused by every
 * operational command exactly where canonical git dies at config load, with sparse checkout
 * on or off, from the local file or an active `config.worktree`.
 *
 * @proves
 *   surface:        config gate
 *   bucket:         cross-tool-interop
 *   unique:         a bogus sparse.expectFilesOutsideOfPatterns refuses the operational surface as canonical git does
 *   interopSurface: config
 */
import { writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TsgitError } from '../../src/domain/error.js';
import { openRepository } from '../../src/index.node.js';
import {
  GIT_AVAILABLE,
  makePeerPair,
  type PeerPair,
  runGit,
  runGitEnv,
  tryRunGitWithExit,
} from './interop-helpers.js';

const SPARSE_BOGUS = '[sparse]\n\texpectFilesOutsideOfPatterns = bogus\n';
const GIT_LINE =
  "fatal: bad boolean config value 'bogus' for 'sparse.expectfilesoutsideofpatterns'";
const EXTENSION_ON = '[extensions]\n\tworktreeConfig = true\n';

type Command = 'status' | 'rev-parse';

interface Row {
  readonly id: string;
  readonly command: Command;
  readonly core: (ignorecase: string) => string;
  readonly local: (core: string) => string;
  readonly worktree?: string;
  readonly expectedKey: string;
}

const coreSection = (ignorecase: string, formatVersion = 0): string =>
  `[core]\n\trepositoryformatversion = ${formatVersion}\n\tignorecase = ${ignorecase}\n`;

const ROWS: ReadonlyArray<Row> = [
  {
    id: 'E3 local bogus',
    command: 'status',
    core: (ic) => coreSection(ic),
    local: (core) => `${core}${SPARSE_BOGUS}`,
    expectedKey: 'sparse.expectfilesoutsideofpatterns',
  },
  {
    id: 'E3b worktree bogus with the extension on',
    command: 'status',
    core: (ic) => coreSection(ic, 1),
    local: (core) => `${core}${EXTENSION_ON}`,
    worktree: SPARSE_BOGUS,
    expectedKey: 'sparse.expectfilesoutsideofpatterns',
  },
  {
    id: 'O1 sparse key before a bad core.fileMode',
    command: 'status',
    core: (ic) => `${coreSection(ic)}\tfileMode = bogus\n`,
    local: (core) => `${SPARSE_BOGUS}${core}`,
    expectedKey: 'sparse.expectfilesoutsideofpatterns',
  },
  {
    id: 'O2 bad core.fileMode before the sparse key',
    command: 'status',
    core: (ic) => `${coreSection(ic)}\tfileMode = bogus\n`,
    local: (core) => `${core}${SPARSE_BOGUS}`,
    expectedKey: 'core.filemode',
  },
  {
    id: 'O3 sparse checkout off, rev-parse',
    command: 'rev-parse',
    core: (ic) => coreSection(ic),
    local: (core) => `${core}${SPARSE_BOGUS}`,
    expectedKey: 'sparse.expectfilesoutsideofpatterns',
  },
];

const arm = (dir: string, ignorecase: string, row: Row): void => {
  runGit(['init', '-q', '-b', 'main', dir]);
  runGit(
    [
      '-C',
      dir,
      '-c',
      'user.name=Ada',
      '-c',
      'user.email=ada@example.com',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'c',
    ],
    {
      env: runGitEnv(),
    },
  );
  writeFileSync(path.join(dir, '.git', 'config'), row.local(row.core(ignorecase)));
  if (row.worktree !== undefined)
    writeFileSync(path.join(dir, '.git', 'config.worktree'), row.worktree);
};

const tsgitRefusal = async (dir: string, command: Command): Promise<TsgitError | undefined> => {
  try {
    const repo = await openRepository({ cwd: dir });
    try {
      if (command === 'status') await repo.status();
      else await repo.revParse('HEAD');
    } finally {
      await repo.dispose();
    }
  } catch (error) {
    return error instanceof TsgitError ? error : undefined;
  }
  return undefined;
};

const rebuiltGitLine = (data: Record<string, unknown>): string =>
  `fatal: bad boolean config value '${String(data.value)}' for '${String(data.key)}'`;

describe.skipIf(!GIT_AVAILABLE || process.platform === 'win32')(
  'sparse.expectFilesOutsideOfPatterns config gate interop',
  () => {
    describe.each(['false', 'true'] as const)(
      'Given core.ignorecase=%s in both twins',
      (ignorecase) => {
        let pair: PeerPair;
        beforeEach(async () => {
          pair = await makePeerPair('sparse-expect-files-config');
        });
        afterEach(async () => {
          await pair.dispose();
        });

        describe('When a command runs against a bogus value', () => {
          it.each(ROWS)('Then $id refuses in both tools', async (row) => {
            // Arrange
            arm(pair.peer, ignorecase, row);
            arm(pair.ours, ignorecase, row);

            // Act
            const gitResult = tryRunGitWithExit(
              ['-C', pair.peer, row.command, ...(row.command === 'rev-parse' ? ['HEAD'] : [])],
              {
                env: runGitEnv(),
              },
            );
            const refusal = await tsgitRefusal(pair.ours, row.command);

            // Assert
            expect(gitResult.exitCode).toBe(128);
            expect(gitResult.stderr).toContain(
              row.expectedKey === 'core.filemode' ? "for 'core.filemode'" : GIT_LINE,
            );
            expect(refusal?.data).toMatchObject({
              code: 'CONFIG_BAD_BOOLEAN_VALUE',
              key: row.expectedKey,
              value: 'bogus',
            });
            expect(gitResult.stderr).toContain(
              rebuiltGitLine(refusal?.data as unknown as Record<string, unknown>),
            );
          });
        });
      },
    );
  },
);
