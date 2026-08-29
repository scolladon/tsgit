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
import { appendFile, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { branchRename } from '../../src/application/commands/branch.js';
import type { ReflogShowEntry } from '../../src/application/commands/reflog.js';
import { reflog } from '../../src/application/commands/reflog.js';
import { revParse } from '../../src/application/commands/rev-parse.js';
import { dropStashEntry, readStashStack } from '../../src/application/primitives/stash-ref.js';
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

/** `<dir>/.git/logs/<ref path>` — the refs this suite corrupts. */
const mainLogPath = (dir: string): string =>
  path.join(dir, '.git', 'logs', 'refs', 'heads', 'main');
const stashLogPath = (dir: string): string => path.join(dir, '.git', 'logs', 'refs', 'stash');
const headLogPath = (dir: string): string => path.join(dir, '.git', 'logs', 'HEAD');
const refPath = (dir: string, ref: string): string => path.join(dir, '.git', ...ref.split('/'));
/** `<dir>/.git/logs/refs/heads/<name>` — the branch-rename case moves this. */
const branchLogPath = (dir: string, name: string): string =>
  path.join(dir, '.git', 'logs', 'refs', 'heads', name);

/** Whether `p` exists — `moveReflog`'s `rename(2)` leaves nothing behind at
 *  the source path, so absence itself is part of what these cases assert. */
const pathExists = async (p: string): Promise<boolean> => {
  try {
    await stat(p);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
};

/**
 * `runGitEnv` plus a pinned committer identity/timestamp, offset `+0000` to
 * match `resolveReflogIdentity`'s own fixed offset — the branch-rename
 * interop cases append a BRAND NEW reflog entry (unlike the purge/rewrite
 * cases above, which never mint one), so byte-for-byte comparison needs
 * git's write pinned to the exact instant tsgit's `Date.now()` is mocked to
 * on the other side.
 */
const pinnedCommitterEnv = (epoch: number): NodeJS.ProcessEnv => ({
  ...runGitEnv(),
  GIT_COMMITTER_NAME: 'Ada',
  GIT_COMMITTER_EMAIL: 'ada@example.com',
  GIT_COMMITTER_DATE: `${epoch} +0000`,
});

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
    /** `logs/HEAD` mirrors `logs/refs/heads/main` line for line — HEAD stays
     *  attached to `main` for every commit the base repo makes. */
    let headLines: readonly [string, string, string, string];
    /** A second base repo built with the REAL current wall clock (no
     *  `GIT_COMMITTER_DATE` override) — the expire-timing cases need entries
     *  whose age is relative to actual "now", not a fixed historical date
     *  that eventually drifts past any cutoff under test. */
    let freshBaseDir = '';
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
      const rawHead = await readFile(headLogPath(baseDir), 'utf8');
      headLines = rawHead.split(/(?<=\n)/).filter((line) => line.length > 0) as unknown as [
        string,
        string,
        string,
        string,
      ];

      freshBaseDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-reflog-interop-fresh-'));
      runGit(['init', '-q', '-b', 'main', freshBaseDir]);
      git(freshBaseDir, 'config', 'user.name', 'Ada');
      git(freshBaseDir, 'config', 'user.email', 'ada@example.com');
      git(freshBaseDir, 'config', 'commit.gpgsign', 'false');
      disableAutoMaintenance(freshBaseDir);
      // Anchored a few seconds behind real "now", not AT it: reflog
      // timestamps are second-precision and `keepEntry`'s cutoff comparison
      // is inclusive (`>=`), so a commit stamped in the same wall-clock
      // second as a later `--expire=now` call would survive on both tools —
      // a timing race, not a tolerance question. A few seconds of margin
      // keeps the fixture "fresh" for the never/90-days-ago cases while
      // staying safely earlier than any `now` cutoff computed later.
      const freshEpoch = Math.floor(Date.now() / 1000) - 5;
      for (let i = 0; i < 2; i += 1) {
        await writeFile(path.join(freshBaseDir, `g${i}.txt`), `g${i}\n`);
        git(freshBaseDir, 'add', '-A');
        runGit(['-C', freshBaseDir, 'commit', '-q', '-m', `g${i}`], {
          env: datedEnv(freshEpoch + i),
        });
      }
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      await rm(baseDir, { recursive: true, force: true });
      await rm(freshBaseDir, { recursive: true, force: true });
      await Promise.all(
        caseRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
      );
    });

    /** Copy `source` into a fresh, tracked tmpdir — the general form behind
     *  {@link caseDir}: the rewrite cases need TWO independent copies of a
     *  fixture (one git mutates, one tsgit mutates), so read-only sharing
     *  (used by the rest of this suite) does not apply to them. */
    const cloneRepo = async (source: string, slug: string): Promise<string> => {
      const root = await mkdtemp(path.join(os.tmpdir(), `tsgit-reflog-interop-${slug}-`));
      caseRoots.push(root);
      const target = path.join(root, 'repo');
      await cp(source, target, { recursive: true });
      return target;
    };

    /** Every case gets its own copy of the shared base repo — read-only, so
     *  one copy suffices for both readers (see file header). */
    const caseDir = async (slug: string): Promise<string> => cloneRepo(baseDir, slug);

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

    describe('Given a corrupted refs/heads/main log with a tab-less surviving entry', () => {
      /** Strips `baseLines[0]`'s message to the tab-less (empty-message) form
       *  and replaces the c1→c2 transition with garbage — `main@{1}` then
       *  targets the c0→c1 entry, leaving the tab-less entry to survive and
       *  be re-serialized under the rewrite writer's always-TAB rule. */
      const tablessSurvivorText = (): string => {
        const tabless = `${baseLines[0].split('\t')[0]}\n`;
        return `${tabless}${baseLines[1]}this is not a reflog line at all\n${baseLines[3]}`;
      };

      describe('When main@{1} is deleted', () => {
        it('Then git reflog delete and tsgit delete produce byte-identical logs', async () => {
          // Arrange — twin repos, corrupted identically; git mutates its own
          // copy on delete, so read-only sharing (used by the rest of this
          // suite) does not apply here.
          const text = tablessSurvivorText();
          const peer = await caseDir('delete-peer');
          const ours = await caseDir('delete-ours');
          await writeFile(mainLogPath(peer), text, 'utf8');
          await writeFile(mainLogPath(ours), text, 'utf8');

          // Act
          git(peer, 'reflog', 'delete', 'main@{1}');
          const ctx = createNodeContext({ workDir: ours });
          await reflog(ctx, { action: 'delete', ref: 'refs/heads/main', index: 1 });

          // Assert — the surviving set (garbage purged, the targeted entry
          // removed) and the re-serialization (the tab-less survivor gains a
          // trailing TAB) both land byte-for-byte the same as git's.
          const peerBytes = await readFile(mainLogPath(peer));
          const oursBytes = await readFile(mainLogPath(ours));
          expect(oursBytes).toEqual(peerBytes);
        });
      });

      describe('When main@{1} is deleted with chain repair', () => {
        it('Then git reflog delete --rewrite and tsgit delete rewrite=true produce byte-identical logs', async () => {
          // Arrange
          const text = tablessSurvivorText();
          const peer = await caseDir('delete-rewrite-peer');
          const ours = await caseDir('delete-rewrite-ours');
          await writeFile(mainLogPath(peer), text, 'utf8');
          await writeFile(mainLogPath(ours), text, 'utf8');

          // Act
          git(peer, 'reflog', 'delete', '--rewrite', 'main@{1}');
          const ctx = createNodeContext({ workDir: ours });
          await reflog(ctx, { action: 'delete', ref: 'refs/heads/main', index: 1, rewrite: true });

          // Assert — the surviving entry's oldId is repaired to chain from
          // the deleted entry's oldId, same as git's.
          const peerBytes = await readFile(mainLogPath(peer));
          const oursBytes = await readFile(mainLogPath(ours));
          expect(oursBytes).toEqual(peerBytes);
        });
      });
    });

    describe('Given a corrupted refs/heads/main log with an out-of-range delete', () => {
      describe('When main@{3} and main@{99} are deleted', () => {
        it.each([3, 99])(
          'Then git and tsgit both exit clean with empty stderr and purge the malformed line, byte-identical',
          async (index) => {
            // Arrange — twin repos, corrupted identically; git mutates its own
            // copy on delete, so read-only sharing (used by the rest of this
            // suite) does not apply here.
            const peer = await caseDir(`delete-oor-corrupt-peer-${index}`);
            const ours = await caseDir(`delete-oor-corrupt-ours-${index}`);
            await writeLine3(peer, 'this is not a reflog line at all\n');
            await writeLine3(ours, 'this is not a reflog line at all\n');
            const ctx = createNodeContext({ workDir: ours });

            // Act
            const gitResult = tryRunGitWithExit([
              '-C',
              peer,
              'reflog',
              'delete',
              `main@{${index}}`,
            ]);
            const result = await reflog(ctx, { action: 'delete', ref: 'refs/heads/main', index });

            // Assert — an out-of-range delete is a silent no-op on both
            // sides, but the malformed line is still purged from disk.
            expect(gitResult.exitCode).toBe(0);
            expect(gitResult.stderr).toBe('');
            expect(result.kind).toBe('delete');
            if (result.kind !== 'delete') throw new Error('unreachable');
            expect('removed' in result).toBe(false);
            const peerBytes = await readFile(mainLogPath(peer));
            const oursBytes = await readFile(mainLogPath(ours));
            expect(oursBytes).toEqual(peerBytes);
          },
        );
      });
    });

    describe('Given a clean refs/heads/main log with an out-of-range delete', () => {
      const CLEAN_OUT_OF_RANGE: ReadonlyArray<{
        readonly label: string;
        readonly selector: string;
        readonly index: number;
      }> = [
        { label: 'main@{4}', selector: 'main@{4}', index: 4 },
        { label: 'main@{99}', selector: 'main@{99}', index: 99 },
        { label: 'a negative index', selector: 'main@{-1}', index: -1 },
      ];

      describe('When main@{4}, main@{99} and a negative index are deleted', () => {
        it.each(CLEAN_OUT_OF_RANGE)(
          'Then $label exits clean on both sides and the file is content-identical to before',
          async ({ selector, index }) => {
            // Arrange
            const peer = await caseDir(`delete-oor-clean-peer-${index}`);
            const ours = await caseDir(`delete-oor-clean-ours-${index}`);
            const before = await readFile(mainLogPath(ours));
            const ctx = createNodeContext({ workDir: ours });

            // Act
            const gitResult = tryRunGitWithExit(['-C', peer, 'reflog', 'delete', selector]);
            const result = await reflog(ctx, { action: 'delete', ref: 'refs/heads/main', index });

            // Assert — content is unchanged on both sides; git's own clean
            // rewrite still touches the inode (measured), so bytes — not
            // `stat` — are compared.
            expect(gitResult.exitCode).toBe(0);
            expect(gitResult.stderr).toBe('');
            expect(result.kind).toBe('delete');
            if (result.kind !== 'delete') throw new Error('unreachable');
            expect('removed' in result).toBe(false);
            const peerBytes = await readFile(mainLogPath(peer));
            const oursBytes = await readFile(mainLogPath(ours));
            expect(peerBytes).toEqual(before);
            expect(oursBytes).toEqual(before);
          },
        );
      });
    });

    describe('Given a corrupted refs/heads/main log with no entry stale enough to prune', () => {
      describe('When expire runs with --expire=never', () => {
        it('Then git and tsgit both purge the malformed line and keep every survivor, byte-identical', async () => {
          // Arrange — "never" never expires anything regardless of the
          // fixture's (historical) commit dates, so the fixed base repo is
          // fine here.
          const peer = await caseDir('expire-never-peer');
          const ours = await caseDir('expire-never-ours');
          await writeLine3(peer, 'this is not a reflog line at all\n');
          await writeLine3(ours, 'this is not a reflog line at all\n');

          // Act
          git(peer, 'reflog', 'expire', '--expire=never', 'refs/heads/main');
          const ctx = createNodeContext({ workDir: ours });
          await reflog(ctx, { action: 'expire', ref: 'refs/heads/main', expire: 'never' });

          // Assert
          const peerBytes = await readFile(mainLogPath(peer));
          const oursBytes = await readFile(mainLogPath(ours));
          expect(oursBytes).toEqual(peerBytes);
        });
      });

      describe('When expire runs with --expire=90.days.ago against fresh (non-expiring) timestamps', () => {
        it('Then git and tsgit both purge the malformed line and keep every survivor, byte-identical', async () => {
          // Arrange — real "now" timestamps, so a 90-day cutoff never reaches
          // them regardless of when this suite happens to run.
          const rawFresh = await readFile(mainLogPath(freshBaseDir), 'utf8');
          const freshLines = rawFresh.split(/(?<=\n)/).filter((line) => line.length > 0) as [
            string,
            string,
          ];
          const text = `${freshLines[0]}this is not a reflog line at all\n${freshLines[1]}`;
          const peer = await cloneRepo(freshBaseDir, 'expire-90days-peer');
          const ours = await cloneRepo(freshBaseDir, 'expire-90days-ours');
          await writeFile(mainLogPath(peer), text, 'utf8');
          await writeFile(mainLogPath(ours), text, 'utf8');

          // Act
          git(peer, 'reflog', 'expire', '--expire=90.days.ago', 'refs/heads/main');
          const ctx = createNodeContext({ workDir: ours });
          await reflog(ctx, { action: 'expire', ref: 'refs/heads/main', expire: '90.days.ago' });

          // Assert
          const peerBytes = await readFile(mainLogPath(peer));
          const oursBytes = await readFile(mainLogPath(ours));
          expect(oursBytes).toEqual(peerBytes);
        });
      });

      describe('When expire runs with --expire=now', () => {
        it('Then git and tsgit both truncate the log to zero bytes, the file still present', async () => {
          // Arrange — every entry, however fresh, was created strictly before
          // this test's own "now", so a `now` cutoff prunes everything.
          const peer = await cloneRepo(freshBaseDir, 'expire-now-peer');
          const ours = await cloneRepo(freshBaseDir, 'expire-now-ours');

          // Act
          git(peer, 'reflog', 'expire', '--expire=now', 'refs/heads/main');
          const ctx = createNodeContext({ workDir: ours });
          await reflog(ctx, { action: 'expire', ref: 'refs/heads/main', expire: 'now' });

          // Assert
          const peerBytes = await readFile(mainLogPath(peer));
          const oursBytes = await readFile(mainLogPath(ours));
          expect(peerBytes).toHaveLength(0);
          expect(oursBytes).toEqual(peerBytes);
        });
      });
    });

    describe('Given degenerate reflog files', () => {
      describe('When expire runs on a log where every line is corrupt', () => {
        it('Then git and tsgit both truncate it to zero bytes and report nothing removed or kept', async () => {
          // Arrange
          const peer = await caseDir('degenerate-all-corrupt-peer');
          const ours = await caseDir('degenerate-all-corrupt-ours');
          const garbage = 'garbage one\ngarbage two\n';
          await writeFile(mainLogPath(peer), garbage, 'utf8');
          await writeFile(mainLogPath(ours), garbage, 'utf8');

          // Act
          git(peer, 'reflog', 'expire', '--expire=never', 'refs/heads/main');
          const ctx = createNodeContext({ workDir: ours });
          const result = await reflog(ctx, {
            action: 'expire',
            ref: 'refs/heads/main',
            expire: 'never',
          });

          // Assert
          expect(result).toEqual({ kind: 'expire', removed: 0, kept: 0 });
          const peerBytes = await readFile(mainLogPath(peer));
          const oursBytes = await readFile(mainLogPath(ours));
          expect(peerBytes).toHaveLength(0);
          expect(oursBytes).toEqual(peerBytes);
        });
      });

      describe('When expire runs on a 0-byte log', () => {
        it('Then git and tsgit both leave it at zero bytes and report nothing removed or kept', async () => {
          // Arrange
          const peer = await caseDir('degenerate-empty-peer');
          const ours = await caseDir('degenerate-empty-ours');
          await writeFile(mainLogPath(peer), '', 'utf8');
          await writeFile(mainLogPath(ours), '', 'utf8');

          // Act
          git(peer, 'reflog', 'expire', '--expire=never', 'refs/heads/main');
          const ctx = createNodeContext({ workDir: ours });
          const result = await reflog(ctx, {
            action: 'expire',
            ref: 'refs/heads/main',
            expire: 'never',
          });

          // Assert
          expect(result).toEqual({ kind: 'expire', removed: 0, kept: 0 });
          const peerBytes = await readFile(mainLogPath(peer));
          const oursBytes = await readFile(mainLogPath(ours));
          expect(peerBytes).toHaveLength(0);
          expect(oursBytes).toEqual(peerBytes);
        });
      });

      describe('Given a ref that exists but has no reflog file at all', () => {
        describe('When expire runs', () => {
          it('Then git refuses (reflog could not be found, exit 255) but tsgit treats it as empty — a pre-existing, accepted divergence', async () => {
            // Arrange
            const dir = await caseDir('degenerate-absent-log');
            git(dir, 'branch', 'existsnolog');
            await rm(path.join(dir, '.git', 'logs', 'refs', 'heads', 'existsnolog'));
            const ctx = createNodeContext({ workDir: dir });

            // Act
            const gitResult = tryRunGitWithExit([
              '-C',
              dir,
              'reflog',
              'expire',
              '--expire=never',
              'refs/heads/existsnolog',
            ]);
            const result = await reflog(ctx, {
              action: 'expire',
              ref: 'refs/heads/existsnolog',
              expire: 'never',
            });

            // Assert
            expect(gitResult.exitCode).toBe(255);
            expect(gitResult.stderr).toContain('reflog could not be found');
            expect(result).toEqual({ kind: 'expire', removed: 0, kept: 0 });
          });
        });
      });

      describe('Given a ref name that does not resolve to any ref at all', () => {
        describe('When reflog show runs', () => {
          it('Then git refuses (fatal: ambiguous argument, exit 128) but tsgit returns an empty result — a pre-existing, accepted divergence', async () => {
            // Arrange
            const dir = await caseDir('degenerate-absent-ref');
            const ctx = createNodeContext({ workDir: dir });

            // Act
            const gitResult = tryRunGitWithExit([
              '-C',
              dir,
              'reflog',
              'show',
              'totally-absent-ref',
            ]);
            const result = await reflog(ctx, { action: 'show', ref: 'totally-absent-ref' });

            // Assert
            expect(gitResult.exitCode).toBe(128);
            expect(gitResult.stderr).toContain('ambiguous argument');
            expect(result.kind).toBe('show');
            expect(result.kind === 'show' && result.entries).toEqual([]);
          });
        });
      });
    });

    describe('Given a corrupted logs/HEAD alongside an otherwise-clean logs/refs/heads/main', () => {
      describe('When expire runs with --expire=never --all', () => {
        it('Then git and tsgit both purge the malformed line from logs/HEAD, byte-identical', async () => {
          // Arrange
          const peer = await caseDir('all-peer');
          const ours = await caseDir('all-ours');
          const text = `${headLines[0]}${headLines[1]}this is not a reflog line at all\n${headLines[3]}`;
          await writeFile(headLogPath(peer), text, 'utf8');
          await writeFile(headLogPath(ours), text, 'utf8');

          // Act
          git(peer, 'reflog', 'expire', '--expire=never', '--all');
          const ctx = createNodeContext({ workDir: ours });
          await reflog(ctx, { action: 'expire', all: true, expire: 'never' });

          // Assert
          const peerBytes = await readFile(headLogPath(peer));
          const oursBytes = await readFile(headLogPath(ours));
          expect(oursBytes).toEqual(peerBytes);
        });
      });
    });

    describe('Given a corrupted refs/stash log with a garbage line between two real stash entries', () => {
      describe('When stash@{1} is dropped', () => {
        it("Then git stash drop and tsgit dropStashEntry produce byte-identical logs — git's repeated gap-warning stderr is rendering and is not matched", async () => {
          // Arrange — `stash drop` validates that the target is a stash-like
          // commit, so real `git stash push` entries are required (unlike the
          // read-only `stash list` case above, which tolerates hand-rolled
          // oids).
          const stashBase = await mkdtemp(
            path.join(os.tmpdir(), 'tsgit-reflog-interop-stashbase-'),
          );
          caseRoots.push(stashBase);
          runGit(['init', '-q', '-b', 'main', stashBase]);
          git(stashBase, 'config', 'user.name', 'Ada');
          git(stashBase, 'config', 'user.email', 'ada@example.com');
          git(stashBase, 'config', 'commit.gpgsign', 'false');
          disableAutoMaintenance(stashBase);
          await writeFile(path.join(stashBase, 'f.txt'), 'base\n');
          git(stashBase, 'add', '-A');
          runGit(['-C', stashBase, 'commit', '-q', '-m', 'base'], { env: datedEnv(BASE_EPOCH) });
          for (let i = 1; i <= 3; i += 1) {
            await appendFile(path.join(stashBase, 'f.txt'), `change${i}\n`);
            runGit(['-C', stashBase, 'stash', 'push', '-q', '-m', `entry ${i}`], {
              env: datedEnv(BASE_EPOCH + i),
            });
          }
          const rawStashLog = await readFile(stashLogPath(stashBase), 'utf8');
          const stashLines = rawStashLog.split(/(?<=\n)/).filter((line) => line.length > 0);
          const corrupted = `${stashLines[0]}this is not a reflog line at all\n${stashLines[1]}${stashLines[2]}`;
          const peer = await cloneRepo(stashBase, 'stash-drop-peer');
          const ours = await cloneRepo(stashBase, 'stash-drop-ours');
          await writeFile(stashLogPath(peer), corrupted, 'utf8');
          await writeFile(stashLogPath(ours), corrupted, 'utf8');

          // Act
          git(peer, 'stash', 'drop', 'stash@{1}');
          const ctx = createNodeContext({ workDir: ours });
          await dropStashEntry(ctx, 1);

          // Assert
          const peerBytes = await readFile(stashLogPath(peer));
          const oursBytes = await readFile(stashLogPath(ours));
          expect(oursBytes).toEqual(peerBytes);
        });
      });
    });

    describe('Given a corrupted refs/heads/main log with a malformed line', () => {
      describe('When the branch is renamed', () => {
        it("Then the destination log is byte-identical to git's own moved-and-appended log, and the source log is gone on both sides", async () => {
          // Arrange — twin repos, corrupted identically; the rename entry's
          // committer timestamp is pinned on both sides so the WHOLE file
          // compares byte-for-byte, not just the moved malformed line.
          const peer = await caseDir('branch-rename-peer');
          const ours = await caseDir('branch-rename-ours');
          await writeLine3(peer, 'this is not a reflog line at all\n');
          await writeLine3(ours, 'this is not a reflog line at all\n');
          const renameEpoch = BASE_EPOCH + 1_000;
          const ctx = createNodeContext({ workDir: ours });

          // Act
          runGit(['-C', peer, 'branch', '-m', 'main', 'renamed'], {
            env: pinnedCommitterEnv(renameEpoch),
          });
          const dateSpy = vi.spyOn(Date, 'now').mockReturnValue(renameEpoch * 1000);
          try {
            await branchRename(ctx, { from: 'main', to: 'renamed' });
          } finally {
            dateSpy.mockRestore();
          }

          // Assert — the moved malformed line and the appended rename entry
          // both land byte-for-byte the same as git's, and the source log
          // is gone entirely on both sides, never left as an empty file.
          const peerBytes = await readFile(branchLogPath(peer, 'renamed'));
          const oursBytes = await readFile(branchLogPath(ours, 'renamed'));
          expect(oursBytes).toEqual(peerBytes);
          expect(await pathExists(mainLogPath(peer))).toBe(false);
          expect(await pathExists(mainLogPath(ours))).toBe(false);
        });
      });
    });

    describe('Given two branches each with their own reflog', () => {
      describe('When the first is force-renamed onto the second', () => {
        it("Then the destination log becomes exactly the source history plus the rename entry, byte-identical to git's own forced rename", async () => {
          // Arrange — `left` and `right` each get one real creation reflog
          // entry, built through git with pinned committer dates so the
          // WHOLE destination file — not just the rename entry — compares
          // byte-for-byte on both sides.
          const root = await mkdtemp(path.join(os.tmpdir(), 'tsgit-reflog-interop-force-'));
          caseRoots.push(root);
          runGit(['init', '-q', '-b', 'main', root]);
          git(root, 'config', 'user.name', 'Ada');
          git(root, 'config', 'user.email', 'ada@example.com');
          git(root, 'config', 'commit.gpgsign', 'false');
          disableAutoMaintenance(root);
          await writeFile(path.join(root, 'f.txt'), 'f\n');
          git(root, 'add', '-A');
          runGit(['-C', root, 'commit', '-q', '-m', 'base'], {
            env: pinnedCommitterEnv(BASE_EPOCH),
          });
          runGit(['-C', root, 'branch', 'left'], { env: pinnedCommitterEnv(BASE_EPOCH + 100) });
          runGit(['-C', root, 'branch', 'right'], { env: pinnedCommitterEnv(BASE_EPOCH + 200) });
          const peer = await cloneRepo(root, 'branch-rename-force-peer');
          const ours = await cloneRepo(root, 'branch-rename-force-ours');
          const renameEpoch = BASE_EPOCH + 300;
          const ctx = createNodeContext({ workDir: ours });

          // Act
          runGit(['-C', peer, 'branch', '-M', 'left', 'right'], {
            env: pinnedCommitterEnv(renameEpoch),
          });
          const dateSpy = vi.spyOn(Date, 'now').mockReturnValue(renameEpoch * 1000);
          try {
            await branchRename(ctx, { from: 'left', to: 'right', force: true });
          } finally {
            dateSpy.mockRestore();
          }

          // Assert — `right`'s own prior entry is replaced, not concatenated
          // with, matching git's own delete_ref-then-move on a forced rename.
          const peerBytes = await readFile(branchLogPath(peer, 'right'));
          const oursBytes = await readFile(branchLogPath(ours, 'right'));
          expect(oursBytes).toEqual(peerBytes);
          expect(await pathExists(branchLogPath(peer, 'left'))).toBe(false);
          expect(await pathExists(branchLogPath(ours, 'left'))).toBe(false);
        });
      });
    });
  },
);
