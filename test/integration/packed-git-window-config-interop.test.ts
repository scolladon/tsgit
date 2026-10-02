/**
 * Cross-tool interop — the `core.packedGitWindowSize` / `core.packedGitLimit`
 * refusal (the pack window cache's config pin, read with git's repo
 * settings). Builds one clean repository, then for every accepted operand of
 * the pinned unsigned-long grammar proves cat-file, rev-parse and status all
 * agree with git; for every malformed operand proves all three refuse
 * identically, rebuilding git's own fatal line from tsgit's structured error
 * data — while branch and tag listing, which never reach the object store,
 * accept it as git does.
 *
 * @proves
 *   surface:        config-read
 *   bucket:         cross-tool-interop
 *   unique:         core.packedGitWindowSize / core.packedGitLimit accept and
 *                    refuse the exact operands git 2.55.0 does, on every
 *                    command git validates the key in
 *   interopSurface: cat-file, rev-parse, status, branch, tag
 */
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { branchList } from '../../src/application/commands/branch.js';
import { catFile } from '../../src/application/commands/cat-file.js';
import { revParse } from '../../src/application/commands/rev-parse.js';
import { status } from '../../src/application/commands/status.js';
import { tagList } from '../../src/application/commands/tag.js';
import { TsgitError } from '../../src/domain/error.js';
import type { Commit } from '../../src/domain/objects/index.js';
import { ObjectId, serializeIdentity } from '../../src/domain/objects/index.js';
import type { Context } from '../../src/ports/context.js';
import { GIT_AVAILABLE, git, runGit, runGitEnv, tryRunGitWithExit } from './interop-helpers.js';

const SETUP_TIMEOUT = 60_000;

const datedEnv = (epoch: number): NodeJS.ProcessEnv => ({
  ...runGitEnv(),
  GIT_AUTHOR_NAME: 'A U Thor',
  GIT_AUTHOR_EMAIL: 'author@example.com',
  GIT_AUTHOR_DATE: `${epoch} +0000`,
  GIT_COMMITTER_NAME: 'A U Thor',
  GIT_COMMITTER_EMAIL: 'author@example.com',
  GIT_COMMITTER_DATE: `${epoch} +0000`,
});

type PackedGitKey = 'packedGitWindowSize' | 'packedGitLimit';

const PACKED_GIT_KEYS: ReadonlyArray<PackedGitKey> = ['packedGitWindowSize', 'packedGitLimit'];

/** git prints the key lowercased and the file path as it reached it. */
const badNumericFatal = (key: PackedGitKey, value: string, reason: string): string =>
  `fatal: bad numeric config value '${value}' for 'core.${key.toLowerCase()}' in file .git/config: ${reason}\n`;

const ACCEPTED_VALUES: ReadonlyArray<string> = ['0', '1', '1k', '4g', '9223372036854775807'];

const ACCEPTED_ROWS: ReadonlyArray<{ readonly key: PackedGitKey; readonly value: string }> =
  PACKED_GIT_KEYS.flatMap((key) => ACCEPTED_VALUES.map((value) => ({ key, value })));

interface RefusedRow {
  readonly key: PackedGitKey;
  readonly slug: string;
  readonly lines: string;
  readonly reported: string;
  readonly reason: 'invalid unit' | 'out of range';
}

const refusedRowsFor = (key: PackedGitKey): ReadonlyArray<RefusedRow> => [
  { key, slug: 'letters', lines: `\t${key} = abc\n`, reported: 'abc', reason: 'invalid unit' },
  { key, slug: 'negative', lines: `\t${key} = -1\n`, reported: '-1', reason: 'invalid unit' },
  { key, slug: 'minus-zero', lines: `\t${key} = -0\n`, reported: '-0', reason: 'invalid unit' },
  { key, slug: 'empty', lines: `\t${key} = \n`, reported: '', reason: 'invalid unit' },
  { key, slug: 'valueless', lines: `\t${key}\n`, reported: '', reason: 'invalid unit' },
  {
    key,
    slug: 'past-the-unsigned-bound',
    lines: `\t${key} = 18446744073709551616\n`,
    reported: '18446744073709551616',
    reason: 'out of range',
  },
];

const REFUSED_ROWS: ReadonlyArray<RefusedRow> = PACKED_GIT_KEYS.flatMap(refusedRowsFor);

interface BadNumericData {
  readonly code: string;
  readonly key: string;
  readonly source: string;
  readonly value: string;
  readonly reason: string;
}

/**
 * Rebuilds `git cat-file -p <commit>`'s byte layout from tsgit's structured
 * `CommitData` — the library returns fields, never rendered text, so pinning
 * the interop against git's stdout means reconstructing it here.
 */
const reconstructCatFileText = (commit: Commit): string => {
  const headerLines = [
    `tree ${commit.data.tree}`,
    ...commit.data.parents.map((parent) => `parent ${parent}`),
    `author ${serializeIdentity(commit.data.author)}`,
    `committer ${serializeIdentity(commit.data.committer)}`,
  ];
  return `${headerLines.join('\n')}\n\n${commit.data.message}`;
};

describe.skipIf(!GIT_AVAILABLE)(
  'core.packedGitWindowSize / core.packedGitLimit eager refusal — cross-tool interop',
  () => {
    let base = '';
    let headId: ObjectId;
    const caseRoots: string[] = [];

    beforeAll(async () => {
      base = await mkdtemp(path.join(os.tmpdir(), 'tsgit-packed-git-window-base-'));
      git(base, 'init', '-q', '-b', 'main');
      git(base, 'config', 'user.name', 'A U Thor');
      git(base, 'config', 'user.email', 'author@example.com');
      git(base, 'config', 'commit.gpgsign', 'false');
      await writeFile(path.join(base, 'file.txt'), 'hello\n');
      git(base, 'add', '-A');
      runGit(['-C', base, 'commit', '-q', '--no-gpg-sign', '-m', 'c0'], {
        env: datedEnv(1_700_000_000),
      });
      headId = ObjectId.from(git(base, 'rev-parse', 'HEAD').trim());
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      await rm(base, { recursive: true, force: true });
      await Promise.all(
        caseRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
      );
    });

    /** A private copy of the shared fixture, carrying this row's own `[core]`
     *  line — no two rows may share a config file or a Context whose session
     *  cache would outlive the copy it was opened on. */
    const caseRepo = async (
      slug: string,
      lines: string,
    ): Promise<{ readonly dir: string; readonly ctx: Context }> => {
      const root = await mkdtemp(path.join(os.tmpdir(), `tsgit-packed-git-window-${slug}-`));
      caseRoots.push(root);
      const dir = path.join(root, 'repo');
      await cp(base, dir, { recursive: true });
      await writeFile(path.join(dir, '.git', 'config'), `[core]\n${lines}`, { flag: 'a' });
      return { dir, ctx: createNodeContext({ workDir: dir }) };
    };

    /** Full-field refusal proof — every field of `.data`, not just the code. */
    const assertRefusesWithBadNumeric = async (
      op: () => Promise<unknown>,
      qualifiedKey: string,
      source: string,
      reported: string,
      reason: string,
    ): Promise<void> => {
      let caught: unknown;
      try {
        await op();
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(TsgitError);
      const data = (caught as TsgitError).data as BadNumericData;
      expect(data.code).toBe('CONFIG_BAD_NUMERIC_VALUE');
      expect(data.key).toBe(qualifiedKey);
      expect(data.source).toBe(source);
      expect(data.value).toBe(reported);
      expect(data.reason).toBe(reason);
    };

    describe('Given a repo with an accepted core.packedGitWindowSize / core.packedGitLimit value', () => {
      describe.each(ACCEPTED_ROWS)('When core.$key = $value', ({ key, value }) => {
        it('Then cat-file, rev-parse and status all agree with git (exit 0)', async () => {
          // Arrange
          const { dir, ctx } = await caseRepo(`${key}-${value}`, `\t${key} = ${value}\n`);

          // Act
          const catFileGit = tryRunGitWithExit(['-C', dir, 'cat-file', '-p', 'HEAD']);
          const revParseGit = tryRunGitWithExit(['-C', dir, 'rev-parse', 'HEAD']);
          const statusGit = tryRunGitWithExit(['-C', dir, 'status']);

          // Assert — git
          expect(catFileGit.exitCode).toBe(0);
          expect(revParseGit.exitCode).toBe(0);
          expect(statusGit.exitCode).toBe(0);

          // Assert — tsgit's catFile content matches git's own cat-file bytes
          // (reconstructed from the structured commit, per the library's
          // fields-not-rendered-text contract); rev-parse matches the head id
          // git resolved to; status reports the clean tree git's exit 0 does.
          const catFileResult = await catFile(ctx, { ids: [headId] });
          const entry = catFileResult.entries[0];
          if (entry === undefined || !entry.ok || entry.object.type !== 'commit') {
            throw new Error('expected a resolved commit entry');
          }
          expect(reconstructCatFileText(entry.object)).toBe(catFileGit.stdout);
          await expect(revParse(ctx, 'HEAD')).resolves.toBe(headId);
          const statusResult = await status(ctx);
          expect(statusResult.changes).toEqual([]);
        });
      });
    });

    describe.each(PACKED_GIT_KEYS)('Given core.%s set twice, malformed and then valid', (key) => {
      describe('When cat-file, rev-parse and status run on both tools', () => {
        it('Then both accept — git reads only the last entry', async () => {
          // Arrange
          const { dir, ctx } = await caseRepo(
            `${key}-bad-then-valid`,
            `\t${key} = x\n\t${key} = 1\n`,
          );

          // Act
          const gitExits = [
            tryRunGitWithExit(['-C', dir, 'cat-file', '-p', 'HEAD']).exitCode,
            tryRunGitWithExit(['-C', dir, 'rev-parse', 'HEAD']).exitCode,
            tryRunGitWithExit(['-C', dir, 'status']).exitCode,
          ];

          // Assert
          expect(gitExits).toEqual([0, 0, 0]);
          await expect(revParse(ctx, 'HEAD')).resolves.toBe(headId);
          expect((await status(ctx)).changes).toEqual([]);
        });
      });

      describe('When the valid entry comes first and rev-parse runs on both tools', () => {
        it("Then both refuse on the last entry, matching git's fatal line", async () => {
          // Arrange
          const { dir, ctx } = await caseRepo(
            `${key}-valid-then-bad`,
            `\t${key} = 1\n\t${key} = x\n`,
          );

          // Act
          const revParseGit = tryRunGitWithExit(['-C', dir, 'rev-parse', 'HEAD']);

          // Assert
          expect(revParseGit.exitCode).toBe(128);
          expect(revParseGit.stderr).toBe(badNumericFatal(key, 'x', 'invalid unit'));
          await assertRefusesWithBadNumeric(
            () => revParse(ctx, 'HEAD'),
            `core.${key.toLowerCase()}`,
            path.join(dir, '.git', 'config'),
            'x',
            'invalid unit',
          );
        });
      });
    });

    describe('Given core.packedGitLimit then core.packedGitWindowSize, both malformed', () => {
      describe('When rev-parse runs on both tools', () => {
        it('Then both name packedGitWindowSize, the key git reads first', async () => {
          // Arrange
          const lines = '\tpackedGitLimit = x\n\tpackedGitWindowSize = y\n';
          const { dir, ctx } = await caseRepo('limit-then-window-size', lines);

          // Act
          const revParseGit = tryRunGitWithExit(['-C', dir, 'rev-parse', 'HEAD']);

          // Assert
          expect(revParseGit.stderr).toBe(
            badNumericFatal('packedGitWindowSize', 'y', 'invalid unit'),
          );
          await assertRefusesWithBadNumeric(
            () => revParse(ctx, 'HEAD'),
            'core.packedgitwindowsize',
            path.join(dir, '.git', 'config'),
            'y',
            'invalid unit',
          );
        });
      });
    });

    describe('Given only a malformed core.packedGitLimit', () => {
      describe('When branch --list and tag --list run on both tools', () => {
        it('Then both list — git reads the bound only on the way to the object store', async () => {
          // Arrange
          const { dir, ctx } = await caseRepo('lists', '\tpackedGitLimit = x\n');

          // Act
          const gitExits = [
            tryRunGitWithExit(['-C', dir, 'branch', '--list']).exitCode,
            tryRunGitWithExit(['-C', dir, 'tag', '--list']).exitCode,
          ];

          // Assert
          expect(gitExits).toEqual([0, 0]);
          await expect(branchList(ctx)).resolves.toBeDefined();
          await expect(tagList(ctx)).resolves.toBeDefined();
        });
      });
    });

    describe('Given core.ignoreCase = x on a line before core.packedGitLimit = x', () => {
      describe('When status runs on both tools', () => {
        it('Then both name core.packedgitlimit — status reads the repo settings before its config', async () => {
          // Arrange
          const lines = '\tignoreCase = x\n\tpackedGitLimit = x\n';
          const { dir, ctx } = await caseRepo('ignore-case-then-limit', lines);

          // Act
          const statusGit = tryRunGitWithExit(['-C', dir, 'status']);

          // Assert
          expect(statusGit.stderr).toBe(badNumericFatal('packedGitLimit', 'x', 'invalid unit'));
          await assertRefusesWithBadNumeric(
            () => status(ctx),
            'core.packedgitlimit',
            path.join(dir, '.git', 'config'),
            'x',
            'invalid unit',
          );
        });
      });
    });

    describe('Given a repo with a malformed core.packedGitWindowSize / core.packedGitLimit value', () => {
      describe.each(REFUSED_ROWS)(
        'When core.$key holds a $slug value',
        ({ key, lines, reported, reason }) => {
          it("Then cat-file, rev-parse and status all refuse, matching git's fatal line", async () => {
            // Arrange
            const { dir, ctx } = await caseRepo(`${key}-${reported || 'valueless'}`, lines);
            const qualifiedKey = `core.${key.toLowerCase()}`;
            const source = path.join(dir, '.git', 'config');

            // Act
            const catFileGit = tryRunGitWithExit(['-C', dir, 'cat-file', '-p', 'HEAD']);
            const revParseGit = tryRunGitWithExit(['-C', dir, 'rev-parse', 'HEAD']);
            const statusGit = tryRunGitWithExit(['-C', dir, 'status']);

            // Assert — git, exit code and the reconstructed fatal line
            const expectedFatal = badNumericFatal(key, reported, reason);
            expect(catFileGit.exitCode).toBe(128);
            expect(revParseGit.exitCode).toBe(128);
            expect(statusGit.exitCode).toBe(128);
            expect(catFileGit.stderr).toBe(expectedFatal);
            expect(revParseGit.stderr).toBe(expectedFatal);
            expect(statusGit.stderr).toBe(expectedFatal);

            // Assert — tsgit, every field of `.data`, on every equivalent command
            await assertRefusesWithBadNumeric(
              () => catFile(ctx, { ids: [headId] }),
              qualifiedKey,
              source,
              reported,
              reason,
            );
            await assertRefusesWithBadNumeric(
              () => revParse(ctx, 'HEAD'),
              qualifiedKey,
              source,
              reported,
              reason,
            );
            await assertRefusesWithBadNumeric(
              () => status(ctx),
              qualifiedKey,
              source,
              reported,
              reason,
            );
          });
        },
      );
    });
  },
);
