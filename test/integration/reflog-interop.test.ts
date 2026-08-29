/**
 * Integration — the reflog malformed-line parity matrix, driven against
 * canonical git. A shared four-commit base repo is built once; every case
 * below gets its own copy, corrupted identically, then read by both real
 * git and tsgit. Read-only: `reflog show`, `rev-parse @{n}` and the
 * stash-stack read never mutate the fixture in this part, so a single copy
 * per case (rather than a git-side/tsgit-side twin) already guarantees both
 * readers see byte-identical bytes — the rewrite-bytes cases (`delete`,
 * `expire`, `stash drop`) land in a later part.
 *
 * @proves
 *   surface:        reflog
 *   bucket:         cross-tool-interop
 *   unique:         per-line reflog tolerance and rewrite bytes against canonical git
 *   interopSurface: reflog
 */
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import type { ReflogShowEntry } from '../../src/application/commands/reflog.js';
import { reflog } from '../../src/application/commands/reflog.js';
import { revParse } from '../../src/application/commands/rev-parse.js';
import { readStashStack } from '../../src/application/primitives/stash-ref.js';
import { TsgitError } from '../../src/domain/error.js';
import type { Context } from '../../src/ports/context.js';
import {
  disableAutoMaintenance,
  GIT_AVAILABLE,
  git,
  runGit,
  runGitEnv,
  tryRunGitWithExit,
} from './interop-helpers.js';

const SETUP_TIMEOUT = 60_000;
const BASE_EPOCH = 1_700_000_000;

const datedEnv = (epoch: number): NodeJS.ProcessEnv => ({
  ...runGitEnv(),
  GIT_AUTHOR_NAME: 'Ada',
  GIT_AUTHOR_EMAIL: 'ada@example.com',
  GIT_AUTHOR_DATE: `${epoch} +0200`,
  GIT_COMMITTER_NAME: 'Ada',
  GIT_COMMITTER_EMAIL: 'ada@example.com',
  GIT_COMMITTER_DATE: `${epoch} +0200`,
});

/** `<dir>/.git/logs/<ref path>` — the two refs this suite corrupts. */
const mainLogPath = (dir: string): string =>
  path.join(dir, '.git', 'logs', 'refs', 'heads', 'main');
const stashLogPath = (dir: string): string => path.join(dir, '.git', 'logs', 'refs', 'stash');
const refPath = (dir: string, ref: string): string => path.join(dir, '.git', ...ref.split('/'));

/** Splits one `%format`'s multi-record stdout into exactly one string per
 *  record, preserving a genuinely EMPTY record (a tab-less line's empty
 *  message, or a NUL-truncated subject) — a plain `.split('\n').filter(Boolean)`
 *  would silently swallow those real empty rows along with the harmless
 *  trailing-newline artefact. */
const splitGitLines = (raw: string): ReadonlyArray<string> =>
  raw.endsWith('\n') ? raw.slice(0, -1).split('\n') : raw.split('\n');

interface GitReflogRow {
  readonly newId: string;
  readonly message: string;
}

/** `git log -g --format='%H<TAB>%gs' <ref>`, newest-first — the FULL oid,
 *  never the abbreviated one `git reflog show` prints, so an oid comparison
 *  needs no truncation (hash abbreviation is a rendering concern the
 *  library never models). */
const gitReflogRows = (dir: string, ref: string): ReadonlyArray<GitReflogRow> =>
  git(dir, 'log', '-g', '--format=%H\t%gs', ref)
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      const [newId, ...rest] = line.split('\t');
      return { newId: newId ?? '', message: rest.join('\t') };
    });

/** Reconstructs git's `<ref>@{n}: <message>` parity (minus the abbreviated
 *  oid, which the library deliberately never models) from tsgit's
 *  structured `ReflogShowEntry` fields — the one comparison every parity
 *  case funnels through. */
const expectShowParity = (
  entries: ReadonlyArray<ReflogShowEntry>,
  gitRows: ReadonlyArray<GitReflogRow>,
): void => {
  expect(entries).toHaveLength(gitRows.length);
  entries.forEach((entry, index) => {
    expect(entry.index).toBe(index);
    expect(entry.entry.newId).toBe(gitRows[index]?.newId);
    expect(entry.entry.message).toBe(gitRows[index]?.message);
  });
};

describe.skipIf(!GIT_AVAILABLE)(
  'integration — reflog malformed-line parity with canonical git',
  () => {
    let baseDir = '';
    let c0 = '';
    let c1 = '';
    let c2 = '';
    let c3 = '';
    /** The base repo's four valid `refs/heads/main` log lines, each including
     *  its own trailing LF — spliced around a corrupted line 3 by every row. */
    let baseLines: readonly [string, string, string, string];
    const caseRoots: string[] = [];

    beforeAll(async () => {
      baseDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-reflog-interop-base-'));
      runGit(['init', '-q', '-b', 'main', baseDir]);
      git(baseDir, 'config', 'user.name', 'Ada');
      git(baseDir, 'config', 'user.email', 'ada@example.com');
      git(baseDir, 'config', 'commit.gpgsign', 'false');
      disableAutoMaintenance(baseDir);
      const commits: string[] = [];
      for (let i = 0; i < 4; i += 1) {
        await writeFile(path.join(baseDir, `f${i}.txt`), `c${i}\n`);
        git(baseDir, 'add', '-A');
        runGit(['-C', baseDir, 'commit', '-q', '-m', `c${i}`], { env: datedEnv(BASE_EPOCH + i) });
        commits.push(git(baseDir, 'rev-parse', 'HEAD').trim());
      }
      [c0, c1, c2, c3] = commits as [string, string, string, string];
      const rawBase = await readFile(mainLogPath(baseDir), 'utf8');
      const lines = rawBase.split(/(?<=\n)/).filter((line) => line.length > 0);
      baseLines = lines as unknown as [string, string, string, string];
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      await rm(baseDir, { recursive: true, force: true });
      await Promise.all(
        caseRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
      );
    });

    /** Every case gets its own copy of the shared base repo — read-only, so
     *  one copy suffices for both readers (see file header). */
    const caseDir = async (slug: string): Promise<string> => {
      const root = await mkdtemp(path.join(os.tmpdir(), `tsgit-reflog-interop-${slug}-`));
      caseRoots.push(root);
      const target = path.join(root, 'repo');
      await cp(baseDir, target, { recursive: true });
      return target;
    };

    /** Replaces line 3 of 4 (oldest-first, the `c1 → c2` move) with `line3`,
     *  keeping the other three valid lines from the base fixture — the
     *  corruption point every row-level case in this suite mutates. */
    const writeLine3 = async (dir: string, line3: string): Promise<void> => {
      const text = `${baseLines[0]}${baseLines[1]}${line3}${baseLines[3]}`;
      await writeFile(mainLogPath(dir), text, 'utf8');
    };

    describe('Given each per-line class both git and tsgit reject or skip', () => {
      describe('When reflog show reads the corrupted log', () => {
        const AGREEING_ROWS: ReadonlyArray<{
          readonly label: string;
          readonly line3: (oldId: string, newId: string) => string;
        }> = [
          {
            label: 'bad oid hex (old oid = 40×z)',
            line3: (_oldId, newId) =>
              `${'z'.repeat(40)} ${newId} Ada <ada@example.com> 1700000002 +0200\tcommit: c2\n`,
          },
          {
            label: 'short oid (39 hex chars)',
            line3: (oldId, newId) =>
              `${oldId.slice(0, 39)} ${newId} Ada <ada@example.com> 1700000002 +0200\tcommit: c2\n`,
          },
          {
            label: 'long oid (41 hex chars)',
            line3: (oldId, newId) =>
              `${oldId}a ${newId} Ada <ada@example.com> 1700000002 +0200\tcommit: c2\n`,
          },
          {
            label: 'no separator after old oid',
            line3: (oldId, newId) =>
              `${oldId}X${newId} Ada <ada@example.com> 1700000002 +0200\tcommit: c2\n`,
          },
          {
            label: 'no separator after new oid',
            line3: (oldId, newId) =>
              `${oldId} ${newId}XProbe <ada@example.com> 1700000002 +0200\tcommit: c2\n`,
          },
          { label: 'garbage line', line3: () => 'this is not a reflog line at all\n' },
          { label: 'empty line mid-file', line3: () => '\n' },
          {
            label: 'identity without brackets',
            line3: (oldId, newId) =>
              `${oldId} ${newId} Probe no-brackets 1700000002 +0200\tcommit: c2\n`,
          },
          {
            label: 'no closing >',
            line3: (oldId, newId) =>
              `${oldId} ${newId} Probe <ada@example.com 1700000002 +0200\tcommit: c2\n`,
          },
          {
            label: 'non-numeric timestamp',
            line3: (oldId, newId) =>
              `${oldId} ${newId} Ada <ada@example.com> not-a-number +0200\tcommit: c2\n`,
          },
          {
            label: 'no timezone field',
            line3: (oldId, newId) =>
              `${oldId} ${newId} Ada <ada@example.com> 1700000002\tcommit: c2\n`,
          },
          {
            label: 'short timezone',
            line3: (oldId, newId) =>
              `${oldId} ${newId} Ada <ada@example.com> 1700000002 +00\tcommit: c2\n`,
          },
          {
            label: 'non-numeric timezone',
            line3: (oldId, newId) =>
              `${oldId} ${newId} Ada <ada@example.com> 1700000002 +abcd\tcommit: c2\n`,
          },
          {
            label: 'timezone without sign',
            line3: (oldId, newId) =>
              `${oldId} ${newId} Ada <ada@example.com> 1700000002 0200\tcommit: c2\n`,
          },
          {
            label: 'zero timestamp',
            line3: (oldId, newId) =>
              `${oldId} ${newId} Ada <ada@example.com> 0 +0200\tcommit: c2\n`,
          },
        ];

        it.each(AGREEING_ROWS)(
          'Then $label — both keep the same 3 survivors',
          async ({ line3 }) => {
            // Arrange
            const dir = await caseDir('agree');
            await writeLine3(dir, line3(c1, c2));
            const ctx = createNodeContext({ workDir: dir });

            // Act
            const gitRows = gitReflogRows(dir, 'refs/heads/main');
            const result = await reflog(ctx, { action: 'show', ref: 'refs/heads/main' });

            // Assert
            expect(gitRows.map((row) => row.newId)).toEqual([c3, c1, c0]);
            expect(result.kind).toBe('show');
            if (result.kind !== 'show') throw new Error('unreachable');
            expectShowParity(result.entries, gitRows);
          },
        );
      });
    });

    describe('Given the final line has no terminating LF', () => {
      describe('When reflog show reads the corrupted log', () => {
        it('Then both sides drop the newest entry', async () => {
          // Arrange
          const dir = await caseDir('unterminated');
          const text = baseLines.join('');
          await writeFile(mainLogPath(dir), text.slice(0, -1), 'utf8');
          const ctx = createNodeContext({ workDir: dir });

          // Act
          const gitRows = gitReflogRows(dir, 'refs/heads/main');
          const result = await reflog(ctx, { action: 'show', ref: 'refs/heads/main' });

          // Assert — the unterminated newest line (c2 → c3) is lost on both sides.
          expect(gitRows.map((row) => row.newId)).toEqual([c2, c1, c0]);
          expect(result.kind).toBe('show');
          if (result.kind !== 'show') throw new Error('unreachable');
          expectShowParity(result.entries, gitRows);
        });
      });
    });

    describe('Given the per-line classes where git and tsgit still disagree', () => {
      describe('When reflog show reads a NUL byte inside the message', () => {
        it('Then git truncates the subject to empty at the NUL, but tsgit keeps the NUL and the trailing byte', async () => {
          // Arrange
          const dir = await caseDir('nul-in-message');
          await writeLine3(dir, `${c1} ${c2} Ada <ada@example.com> 1700000002 +0200\tA\0B\n`);
          const ctx = createNodeContext({ workDir: dir });

          // Act
          const gitSubjects = splitGitLines(
            git(dir, 'log', '-g', '--format=%gs', 'refs/heads/main'),
          );
          const result = await reflog(ctx, { action: 'show', ref: 'refs/heads/main' });

          // Assert — git's %gs (a NUL-terminated C-string read) truncates to empty;
          // tsgit's message field is a plain JS string slice and keeps every byte.
          expect(gitSubjects[1]).toBe('');
          expect(result.kind).toBe('show');
          if (result.kind !== 'show') throw new Error('unreachable');
          expect(result.entries[1]?.entry.message).toBe('A\0B');
        });
      });

      describe('When reflog show reads a line with no opening angle bracket', () => {
        it('Then git keeps the entry, but tsgit rejects it as an invalid identity', async () => {
          // Arrange
          const dir = await caseDir('no-opening-bracket');
          await writeLine3(
            dir,
            `${c1} ${c2} Probe probe@example.com> 1700000002 +0200\tcommit: c2\n`,
          );
          const ctx = createNodeContext({ workDir: dir });

          // Act
          const gitRows = gitReflogRows(dir, 'refs/heads/main');
          const result = await reflog(ctx, { action: 'show', ref: 'refs/heads/main' });

          // Assert — git keeps all 4; tsgit's identity parser requires BOTH
          // brackets and drops the line, leaving 3 survivors.
          expect(gitRows.map((row) => row.newId)).toEqual([c3, c2, c1, c0]);
          expect(result.kind).toBe('show');
          if (result.kind !== 'show') throw new Error('unreachable');
          expect(result.entries.map((e) => e.entry.newId)).toEqual([c3, c1, c0]);
        });
      });

      describe('When reflog show reads a `>` inside the name', () => {
        it('Then git skips the entry, but tsgit keeps it with the name taken up to the LAST `>`', async () => {
          // Arrange
          const dir = await caseDir('gt-in-name');
          await writeLine3(
            dir,
            `${c1} ${c2} x>y <probe@example.com> 1700000002 +0200\tcommit: c2\n`,
          );
          const ctx = createNodeContext({ workDir: dir });

          // Act
          const gitRows = gitReflogRows(dir, 'refs/heads/main');
          const result = await reflog(ctx, { action: 'show', ref: 'refs/heads/main' });

          // Assert — git's forward scan for the first `>` misreads the boundary
          // and skips; tsgit's last-bracket-pair parser keeps it, name "x>y".
          expect(gitRows.map((row) => row.newId)).toEqual([c3, c1, c0]);
          expect(result.kind).toBe('show');
          if (result.kind !== 'show') throw new Error('unreachable');
          expect(result.entries.map((e) => e.entry.newId)).toEqual([c3, c2, c1, c0]);
          expect(result.entries[1]?.entry.identity.name).toBe('x>y');
        });
      });

      describe('When reflog show reads a line with no space after the closing `>`', () => {
        it('Then git skips the entry, but tsgit keeps it', async () => {
          // Arrange
          const dir = await caseDir('no-space-after-gt');
          await writeLine3(
            dir,
            `${c1} ${c2} Probe <ada@example.com>1700000002 +0200\tcommit: c2\n`,
          );
          const ctx = createNodeContext({ workDir: dir });

          // Act
          const gitRows = gitReflogRows(dir, 'refs/heads/main');
          const result = await reflog(ctx, { action: 'show', ref: 'refs/heads/main' });

          // Assert
          expect(gitRows.map((row) => row.newId)).toEqual([c3, c1, c0]);
          expect(result.kind).toBe('show');
          if (result.kind !== 'show') throw new Error('unreachable');
          expect(result.entries.map((e) => e.entry.newId)).toEqual([c3, c2, c1, c0]);
        });
      });

      describe('When reflog show reads a negative timestamp', () => {
        it('Then git reads the unsigned 64-bit wraparound, but tsgit keeps the negative value', async () => {
          // Arrange
          const dir = await caseDir('negative-timestamp');
          await writeLine3(dir, `${c1} ${c2} Ada <ada@example.com> -5 +0200\tcommit: c2\n`);
          const ctx = createNodeContext({ workDir: dir });

          // Act — `--date=raw` renders `%gd` as "<timestamp> <tz>" instead of the
          // ordinal, surfacing git's own parsed (wrapped-unsigned) timestamp.
          const gitSelectors = splitGitLines(
            git(dir, 'log', '-g', '--date=raw', '--format=%gd', 'refs/heads/main'),
          );
          const result = await reflog(ctx, { action: 'show', ref: 'refs/heads/main' });

          // Assert
          expect(gitSelectors[1]).toBe('main@{18446744073709551611 +0200}');
          expect(result.kind).toBe('show');
          if (result.kind !== 'show') throw new Error('unreachable');
          expect(result.entries[1]?.entry.identity.timestamp).toBe(-5);
        });
      });
    });

    describe('Given the accepted-line classes both tools agree on', () => {
      describe('When reflog show reads a tab-less line (empty message)', () => {
        it('Then both sides keep all four entries, the corrupted one with an empty message', async () => {
          // Arrange — no tab: the line ends at the timezone.
          const dir = await caseDir('tabless-message');
          await writeLine3(dir, `${c1} ${c2} Ada <ada@example.com> 1700000002 +0200\n`);
          const ctx = createNodeContext({ workDir: dir });

          // Act
          const gitRows = gitReflogRows(dir, 'refs/heads/main');
          const result = await reflog(ctx, { action: 'show', ref: 'refs/heads/main' });

          // Assert
          expect(gitRows[1]).toEqual({ newId: c2, message: '' });
          expect(result.kind).toBe('show');
          if (result.kind !== 'show') throw new Error('unreachable');
          expectShowParity(result.entries, gitRows);
        });
      });

      describe('When reflog show reads a trailing blank line at file end', () => {
        it('Then both sides keep all four entries unaffected', async () => {
          // Arrange
          const dir = await caseDir('trailing-blank-line');
          await writeFile(mainLogPath(dir), `${baseLines.join('')}\n`, 'utf8');
          const ctx = createNodeContext({ workDir: dir });

          // Act
          const gitRows = gitReflogRows(dir, 'refs/heads/main');
          const result = await reflog(ctx, { action: 'show', ref: 'refs/heads/main' });

          // Assert
          expect(gitRows.map((row) => row.newId)).toEqual([c3, c2, c1, c0]);
          expect(result.kind).toBe('show');
          if (result.kind !== 'show') throw new Error('unreachable');
          expectShowParity(result.entries, gitRows);
        });
      });

      describe('When reflog show reads CRLF line endings on every line', () => {
        it('Then both sides keep all four entries, each message trailing a bare \\r', async () => {
          // Arrange
          const dir = await caseDir('crlf-endings');
          const crlfText = baseLines.map((line) => line.replace(/\n$/, '\r\n')).join('');
          await writeFile(mainLogPath(dir), crlfText, 'utf8');
          const ctx = createNodeContext({ workDir: dir });

          // Act
          const gitRows = gitReflogRows(dir, 'refs/heads/main');
          const result = await reflog(ctx, { action: 'show', ref: 'refs/heads/main' });

          // Assert
          expect(gitRows.every((row) => row.message.endsWith('\r'))).toBe(true);
          expect(result.kind).toBe('show');
          if (result.kind !== 'show') throw new Error('unreachable');
          expectShowParity(result.entries, gitRows);
        });
      });
    });

    describe('Given a corrupted log reduced to three surviving entries', () => {
      describe('When rev-parse resolves main@{n} for each surviving index', () => {
        it.each([0, 1, 2])('Then main@{%i} resolves to the same oid on both tools', async (n) => {
          // Arrange
          const dir = await caseDir(`numbering-n${n}`);
          await writeLine3(dir, 'this is not a reflog line at all\n');
          const ctx = createNodeContext({ workDir: dir });

          // Act
          const gitOid = git(dir, 'rev-parse', `main@{${n}}`).trim();
          const tsgitOid = await revParse(ctx, `main@{${n}}`);

          // Assert
          expect(tsgitOid).toBe(gitOid);
        });
      });

      describe('When rev-parse resolves main@{3} — one past the last surviving entry', () => {
        it("Then git refuses at exit 128 and tsgit throws REFLOG_ENTRY_OUT_OF_RANGE — git's stderr text and the gap/only-goes-back warnings are rendering and are not matched", async () => {
          // Arrange
          const dir = await caseDir('numbering-boundary');
          await writeLine3(dir, 'this is not a reflog line at all\n');
          const ctx = createNodeContext({ workDir: dir });

          // Act
          const gitResult = tryRunGitWithExit(['-C', dir, 'rev-parse', 'main@{3}']);
          let caught: unknown;
          try {
            await revParse(ctx, 'main@{3}');
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(gitResult.exitCode).toBe(128);
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as TsgitError).data).toEqual({
            code: 'REFLOG_ENTRY_OUT_OF_RANGE',
            ref: 'refs/heads/main',
            requested: 3,
            available: 3,
          });
        });
      });
    });

    describe('Given a corrupted refs/stash log', () => {
      describe('When the stash stack is read', () => {
        it("Then git stash list and tsgit's stash-stack read agree on the surviving entries", async () => {
          // Arrange
          const dir = await caseDir('stash-list');
          const zero = '0'.repeat(40);
          const stashText =
            `${zero} ${c0} Ada <ada@example.com> 1700000000 +0200\tWIP on main: 000 first\n` +
            'this is not a reflog line at all\n' +
            `${c0} ${c1} Ada <ada@example.com> 1700000001 +0200\tWIP on main: 111 second\n`;
          await mkdir(path.dirname(stashLogPath(dir)), { recursive: true });
          await writeFile(stashLogPath(dir), stashText, 'utf8');
          await writeFile(refPath(dir, 'refs/stash'), `${c1}\n`, 'utf8');
          const ctx: Context = createNodeContext({ workDir: dir });

          // Act — the malformed line skipped identically on both sides.
          const gitOutput = git(dir, 'stash', 'list').trim();
          const stack = await readStashStack(ctx);

          // Assert
          expect(gitOutput.split('\n')).toEqual([
            'stash@{0}: WIP on main: 111 second',
            'stash@{1}: WIP on main: 000 first',
          ]);
          expect(stack).toEqual([
            { index: 0, selector: 'stash@{0}', stash: c1, message: 'WIP on main: 111 second' },
            { index: 1, selector: 'stash@{1}', stash: c0, message: 'WIP on main: 000 first' },
          ]);
        });
      });
    });
  },
);
