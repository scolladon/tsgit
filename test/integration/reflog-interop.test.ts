/**
 * Integration — the reflog malformed-line parity matrix, driven against
 * canonical git. A shared four-commit base repo is built once; every case
 * below gets its own copy, corrupted identically. Read-only cases
 * (`reflog show`, `rev-parse @{n}`, the stash-stack read) use that single
 * copy — both readers see byte-identical bytes by construction. The
 * rewrite cases (`delete`, `expire`, `stash drop`, `branch -m`) use twin
 * copies instead: git mutates one, tsgit the other, and the resulting
 * file bytes are compared.
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
    /**
     * A third base repo for the reachability matrix: `main` commits A then
     * B, `side` branches off B and adds C, then `main` is reset back to A —
     * so B is reachable only through `side`, matching the history the
     * reachability rule is pinned against.
     */
    let reachabilityBaseDir = '';
    let reachabilityA = '';
    /**
     * A fourth base repo for the same matrix: `main` commits A then B, then
     * a later commit D is made from B and reset away — D is unreachable
     * from any current tip.
     */
    let reachabilityWithDBaseDir = '';
    let reachabilityWithDB = '';
    /**
     * A fifth base repo pinning F1: `main` commits P then Q then R, then a
     * `reset --hard` back to P and forward to R again — R's parent Q sits
     * below the total cutoff under test, so the bounded pass marks Q but
     * never expands it, leaving P (reachable only through Q) unmarked. Git's
     * date bound is laziness only: a miss on P drops the bound and re-expands
     * Q, finding P after all.
     */
    let frontierBaseDir = '';
    /**
     * A sixth base repo pinning F3: `main` commits A, then HEAD detaches and
     * commits B — B is reachable only by way of the detached HEAD, which
     * `UE_HEAD` never seeds as a tip in its own right.
     */
    let detachedHeadBaseDir = '';
    const REACHABILITY_EPOCH = 1_700_000_000;
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
      // timestamps are second-precision and the unreachable-cutoff
      // comparison is inclusive (`>=`), so a commit stamped in the same wall-clock
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

      reachabilityBaseDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-reflog-interop-reach-'));
      runGit(['init', '-q', '-b', 'main', reachabilityBaseDir]);
      git(reachabilityBaseDir, 'config', 'user.name', 'Ada');
      git(reachabilityBaseDir, 'config', 'user.email', 'ada@example.com');
      git(reachabilityBaseDir, 'config', 'commit.gpgsign', 'false');
      disableAutoMaintenance(reachabilityBaseDir);
      await writeFile(path.join(reachabilityBaseDir, 'a.txt'), 'a\n');
      git(reachabilityBaseDir, 'add', '-A');
      runGit(['-C', reachabilityBaseDir, 'commit', '-q', '-m', 'a'], {
        env: datedEnv(REACHABILITY_EPOCH),
      });
      reachabilityA = git(reachabilityBaseDir, 'rev-parse', 'HEAD').trim();
      await writeFile(path.join(reachabilityBaseDir, 'b.txt'), 'b\n');
      git(reachabilityBaseDir, 'add', '-A');
      runGit(['-C', reachabilityBaseDir, 'commit', '-q', '-m', 'b'], {
        env: datedEnv(REACHABILITY_EPOCH + 100),
      });
      runGit(['-C', reachabilityBaseDir, 'checkout', '-q', '-b', 'side'], {
        env: datedEnv(REACHABILITY_EPOCH + 125),
      });
      await writeFile(path.join(reachabilityBaseDir, 'c.txt'), 'c\n');
      git(reachabilityBaseDir, 'add', '-A');
      runGit(['-C', reachabilityBaseDir, 'commit', '-q', '-m', 'c'], {
        env: datedEnv(REACHABILITY_EPOCH + 150),
      });
      runGit(['-C', reachabilityBaseDir, 'checkout', '-q', 'main'], {
        env: datedEnv(REACHABILITY_EPOCH + 175),
      });
      runGit(['-C', reachabilityBaseDir, 'reset', '-q', '--hard', reachabilityA], {
        env: datedEnv(REACHABILITY_EPOCH + 200),
      });

      reachabilityWithDBaseDir = await mkdtemp(
        path.join(os.tmpdir(), 'tsgit-reflog-interop-reach-d-'),
      );
      runGit(['init', '-q', '-b', 'main', reachabilityWithDBaseDir]);
      git(reachabilityWithDBaseDir, 'config', 'user.name', 'Ada');
      git(reachabilityWithDBaseDir, 'config', 'user.email', 'ada@example.com');
      git(reachabilityWithDBaseDir, 'config', 'commit.gpgsign', 'false');
      disableAutoMaintenance(reachabilityWithDBaseDir);
      await writeFile(path.join(reachabilityWithDBaseDir, 'a.txt'), 'a\n');
      git(reachabilityWithDBaseDir, 'add', '-A');
      runGit(['-C', reachabilityWithDBaseDir, 'commit', '-q', '-m', 'a'], {
        env: datedEnv(REACHABILITY_EPOCH),
      });
      await writeFile(path.join(reachabilityWithDBaseDir, 'b.txt'), 'b\n');
      git(reachabilityWithDBaseDir, 'add', '-A');
      runGit(['-C', reachabilityWithDBaseDir, 'commit', '-q', '-m', 'b'], {
        env: datedEnv(REACHABILITY_EPOCH + 100),
      });
      reachabilityWithDB = git(reachabilityWithDBaseDir, 'rev-parse', 'HEAD').trim();
      await writeFile(path.join(reachabilityWithDBaseDir, 'd.txt'), 'd\n');
      git(reachabilityWithDBaseDir, 'add', '-A');
      runGit(['-C', reachabilityWithDBaseDir, 'commit', '-q', '-m', 'd'], {
        env: datedEnv(REACHABILITY_EPOCH + 200),
      });
      runGit(['-C', reachabilityWithDBaseDir, 'reset', '-q', '--hard', reachabilityWithDB], {
        env: datedEnv(REACHABILITY_EPOCH + 200),
      });

      frontierBaseDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-reflog-interop-frontier-'));
      runGit(['init', '-q', '-b', 'main', frontierBaseDir]);
      git(frontierBaseDir, 'config', 'user.name', 'Ada');
      git(frontierBaseDir, 'config', 'user.email', 'ada@example.com');
      git(frontierBaseDir, 'config', 'commit.gpgsign', 'false');
      disableAutoMaintenance(frontierBaseDir);
      await writeFile(path.join(frontierBaseDir, 'p.txt'), 'p\n');
      git(frontierBaseDir, 'add', '-A');
      runGit(['-C', frontierBaseDir, 'commit', '-q', '-m', 'p'], {
        env: datedEnv(REACHABILITY_EPOCH + 1000),
      });
      const frontierP = git(frontierBaseDir, 'rev-parse', 'HEAD').trim();
      await writeFile(path.join(frontierBaseDir, 'q.txt'), 'q\n');
      git(frontierBaseDir, 'add', '-A');
      runGit(['-C', frontierBaseDir, 'commit', '-q', '-m', 'q'], {
        env: datedEnv(REACHABILITY_EPOCH + 1500),
      });
      await writeFile(path.join(frontierBaseDir, 'r.txt'), 'r\n');
      git(frontierBaseDir, 'add', '-A');
      runGit(['-C', frontierBaseDir, 'commit', '-q', '-m', 'r'], {
        env: datedEnv(REACHABILITY_EPOCH + 3000),
      });
      const frontierR = git(frontierBaseDir, 'rev-parse', 'HEAD').trim();
      runGit(['-C', frontierBaseDir, 'reset', '-q', '--hard', frontierP], {
        env: datedEnv(REACHABILITY_EPOCH + 3500),
      });
      runGit(['-C', frontierBaseDir, 'reset', '-q', '--hard', frontierR], {
        env: datedEnv(REACHABILITY_EPOCH + 3600),
      });

      detachedHeadBaseDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-reflog-interop-detach-'));
      runGit(['init', '-q', '-b', 'main', detachedHeadBaseDir]);
      git(detachedHeadBaseDir, 'config', 'user.name', 'Ada');
      git(detachedHeadBaseDir, 'config', 'user.email', 'ada@example.com');
      git(detachedHeadBaseDir, 'config', 'commit.gpgsign', 'false');
      disableAutoMaintenance(detachedHeadBaseDir);
      await writeFile(path.join(detachedHeadBaseDir, 'a.txt'), 'a\n');
      git(detachedHeadBaseDir, 'add', '-A');
      runGit(['-C', detachedHeadBaseDir, 'commit', '-q', '-m', 'a'], {
        env: datedEnv(REACHABILITY_EPOCH),
      });
      runGit(['-C', detachedHeadBaseDir, 'checkout', '-q', '--detach'], {
        env: datedEnv(REACHABILITY_EPOCH + 50),
      });
      await writeFile(path.join(detachedHeadBaseDir, 'b.txt'), 'b\n');
      git(detachedHeadBaseDir, 'add', '-A');
      runGit(['-C', detachedHeadBaseDir, 'commit', '-q', '-m', 'b'], {
        env: datedEnv(REACHABILITY_EPOCH + 100),
      });
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      await rm(baseDir, { recursive: true, force: true });
      await rm(freshBaseDir, { recursive: true, force: true });
      await rm(reachabilityBaseDir, { recursive: true, force: true });
      await rm(reachabilityWithDBaseDir, { recursive: true, force: true });
      await rm(frontierBaseDir, { recursive: true, force: true });
      await rm(detachedHeadBaseDir, { recursive: true, force: true });
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

          // Assert — git's C-string read truncates the message at the NUL to
          // 'A'; %gs then strips one trailing byte unconditionally, rendering
          // EMPTY. tsgit's message field is a plain JS string slice and keeps
          // every byte.
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
          const dir = await caseDir('tab-free-message');
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
      const tabFreeSurvivorText = (): string => {
        const tabFree = `${baseLines[0].split('\t')[0]}\n`;
        return `${tabFree}${baseLines[1]}this is not a reflog line at all\n${baseLines[3]}`;
      };

      describe('When main@{1} is deleted', () => {
        it('Then git reflog delete and tsgit delete produce byte-identical logs', async () => {
          // Arrange — twin repos, corrupted identically; git mutates its own
          // copy on delete, so read-only sharing (used by the rest of this
          // suite) does not apply here.
          const text = tabFreeSurvivorText();
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
          const text = tabFreeSurvivorText();
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

    describe('Given a middle valid line carrying a non-UTF-8 byte in its identity name and message', () => {
      /**
       * A latin1 0xE9 in both the identity name and the message — a byte
       * that is not valid UTF-8 on its own, but perfectly valid content to
       * git's own byte-oriented reflog reader (it never validates encoding).
       * Placed at line 2 (the c0→c1 move) rather than line 3: `main@{1}`
       * deletes line 3 (e2), so line 2 survives that delete and must be
       * re-serialized byte-identical rather than mangled by a decode/
       * re-encode round trip.
       */
      const latin1Line2 = (): Buffer =>
        Buffer.concat([
          Buffer.from(`${c0} ${c1} Ad`, 'utf8'),
          Buffer.from([0xe9]),
          Buffer.from(' Lovelace <ada@example.com> 1700000001 +0200\tcommit: caf', 'utf8'),
          Buffer.from([0xe9]),
          Buffer.from('\n', 'utf8'),
        ]);

      /** Replaces line 2 of 4 (oldest-first, the c0→c1 move) with `line2`,
       *  keeping the other three valid lines from the base fixture. */
      const writeLine2 = async (dir: string, line2: Buffer): Promise<void> => {
        const text = Buffer.concat([
          Buffer.from(baseLines[0], 'utf8'),
          line2,
          Buffer.from(baseLines[2], 'utf8'),
          Buffer.from(baseLines[3], 'utf8'),
        ]);
        await writeFile(mainLogPath(dir), text);
      };

      describe('When expire runs with --expire=never', () => {
        it('Then git and tsgit both re-emit the non-UTF-8 line byte-identical', async () => {
          // Arrange
          const line2 = latin1Line2();
          const peer = await caseDir('latin1-expire-peer');
          const ours = await caseDir('latin1-expire-ours');
          await writeLine2(peer, line2);
          await writeLine2(ours, line2);

          // Act
          git(peer, 'reflog', 'expire', '--expire=never', 'refs/heads/main');
          const ctx = createNodeContext({ workDir: ours });
          await reflog(ctx, { action: 'expire', ref: 'refs/heads/main', expire: 'never' });

          // Assert — nothing expires on either side, but the rewrite still
          // runs unconditionally; the non-UTF-8 bytes must survive it. The
          // 0xE9 presence check keeps the comparison honest: identical files
          // that both LOST the byte would otherwise still pass.
          const peerBytes = await readFile(mainLogPath(peer));
          const oursBytes = await readFile(mainLogPath(ours));
          expect(oursBytes).toEqual(peerBytes);
          expect(oursBytes.includes(0xe9)).toBe(true);
        });
      });

      describe('When main@{1} is deleted', () => {
        it('Then the surviving non-UTF-8 line round-trips byte-identical, same as git', async () => {
          // Arrange — main@{1} targets line 3 (e2), leaving the latin1 line
          // at line 2 among the survivors that get re-serialized.
          const line2 = latin1Line2();
          const peer = await caseDir('latin1-delete-peer');
          const ours = await caseDir('latin1-delete-ours');
          await writeLine2(peer, line2);
          await writeLine2(ours, line2);

          // Act
          git(peer, 'reflog', 'delete', 'main@{1}');
          const ctx = createNodeContext({ workDir: ours });
          await reflog(ctx, { action: 'delete', ref: 'refs/heads/main', index: 1 });

          // Assert
          const peerBytes = await readFile(mainLogPath(peer));
          const oursBytes = await readFile(mainLogPath(ours));
          expect(oursBytes).toEqual(peerBytes);
          expect(oursBytes.includes(0xe9)).toBe(true);
        });
      });
    });

    describe('Given a reflog entry stamped a year in the FUTURE', () => {
      describe('When expire runs with --expire=now on both sides', () => {
        it('Then both sides delete it — the cutoff is the maximum time, not the clock', async () => {
          // Arrange — hand-write a future-dated line; git maps now/all to
          // TIME_MAX, so even a timestamp ahead of the wall clock expires.
          const peer = await caseDir('future-expire-peer');
          const ours = await caseDir('future-expire-ours');
          const future = Math.floor(Date.now() / 1000) + 365 * 24 * 3600;
          const raw = await readFile(mainLogPath(peer), 'utf8');
          const first = raw.split(/(?<=\n)/)[0] as string;
          const oldId = first.slice(0, 40);
          const newId = first.slice(41, 81);
          const futureLine = `${oldId} ${newId} Probe <probe@example.com> ${future} +0000\tfuture\n`;
          await writeFile(mainLogPath(peer), futureLine, 'utf8');
          await writeFile(mainLogPath(ours), futureLine, 'utf8');

          // Act
          git(peer, 'reflog', 'expire', '--expire=now', 'refs/heads/main');
          const ctx = createNodeContext({ workDir: ours });
          const result = await reflog(ctx, {
            action: 'expire',
            ref: 'refs/heads/main',
            expire: 'now',
          });

          // Assert
          expect(result).toEqual({ kind: 'expire', removed: 1, kept: 0 });
          const peerBytes = await readFile(mainLogPath(peer));
          const oursBytes = await readFile(mainLogPath(ours));
          expect(peerBytes).toHaveLength(0);
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

      describe('When rev-parse resolves main@{0} over an unusable log', () => {
        it.each([
          { fixture: 'all-corrupt', content: 'garbage one\ngarbage two\n' },
          { fixture: 'zero-byte', content: '' },
        ])(
          'Then git answers the current ref value while tsgit throws REVPARSE_UNRESOLVED — a recorded divergence ($fixture)',
          async ({ fixture, content }) => {
            // Arrange
            const dir = await caseDir(`degenerate-revparse-${fixture}`);
            await writeFile(mainLogPath(dir), content, 'utf8');
            const ctx = createNodeContext({ workDir: dir });

            // Act
            const gitOid = git(dir, 'rev-parse', 'main@{0}').trim();
            const tip = git(dir, 'rev-parse', 'main').trim();
            let caught: unknown;
            try {
              await revParse(ctx, 'main@{0}');
            } catch (err) {
              caught = err;
            }

            // Assert — git falls back to the ref's own value; tsgit refuses
            // with a typed error. Neither side matches the other today.
            expect(gitOid).toBe(tip);
            expect((caught as TsgitError).data).toEqual({
              code: 'REVPARSE_UNRESOLVED',
              expression: 'main@{0}',
            });
          },
        );
      });

      describe('When reflog exists is asked about each degenerate shape', () => {
        it.each([
          { fixture: 'all-corrupt', content: 'garbage one\ngarbage two\n', expected: true },
          { fixture: 'zero-byte', content: '', expected: true },
        ])(
          'Then both sides report presence from the file alone ($fixture)',
          async ({ fixture, content, expected }) => {
            // Arrange
            const dir = await caseDir(`degenerate-exists-${fixture}`);
            await writeFile(mainLogPath(dir), content, 'utf8');
            const ctx = createNodeContext({ workDir: dir });

            // Act
            const gitResult = tryRunGitWithExit(['-C', dir, 'reflog', 'exists', 'refs/heads/main']);
            const result = await reflog(ctx, { action: 'exists', ref: 'refs/heads/main' });

            // Assert — corruption never affects existence.
            expect(gitResult.exitCode).toBe(0);
            expect(result).toEqual({ kind: 'exists', exists: expected });
          },
        );

        it('Then an absent log file reports absent on both sides', async () => {
          // Arrange
          const dir = await caseDir('degenerate-exists-absent');
          await rm(mainLogPath(dir));
          const ctx = createNodeContext({ workDir: dir });

          // Act
          const gitResult = tryRunGitWithExit(['-C', dir, 'reflog', 'exists', 'refs/heads/main']);
          const result = await reflog(ctx, { action: 'exists', ref: 'refs/heads/main' });

          // Assert
          expect(gitResult.exitCode).toBe(1);
          expect(result).toEqual({ kind: 'exists', exists: false });
        });
      });

      describe('When rev-parse resolves a date selector across the malformed gap', () => {
        it('Then main@{50.years.ago} resolves to the same oid on both tools', async () => {
          // Arrange — a date far past the oldest entry clamps to the oldest
          // surviving one on both sides; git's only-goes-back warning is
          // rendering and is not matched.
          const dir = await caseDir('degenerate-date-selector');
          await writeLine3(dir, 'this is not a reflog line at all\n');
          const ctx = createNodeContext({ workDir: dir });

          // Act
          const gitOid = git(dir, 'rev-parse', 'main@{50.years.ago}').trim();
          const tsgitOid = await revParse(ctx, 'main@{50.years.ago}');

          // Assert
          expect(tsgitOid).toBe(gitOid);
        });
      });

      describe('When expire runs on a ref that exists but has no reflog file at all', () => {
        it('Then both sides refuse and neither creates a log file (git exit 255, tsgit REFLOG_NOT_FOUND)', async () => {
          // Arrange
          const dir = await caseDir('degenerate-absent-log');
          git(dir, 'branch', 'exists-no-log');
          await rm(path.join(dir, '.git', 'logs', 'refs', 'heads', 'exists-no-log'));
          const ctx = createNodeContext({ workDir: dir });

          // Act
          const gitResult = tryRunGitWithExit([
            '-C',
            dir,
            'reflog',
            'expire',
            '--expire=never',
            'refs/heads/exists-no-log',
          ]);
          let caught: unknown;
          try {
            await reflog(ctx, {
              action: 'expire',
              ref: 'refs/heads/exists-no-log',
              expire: 'never',
            });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(gitResult.exitCode).toBe(255);
          expect(gitResult.stderr).toContain('reflog could not be found');
          expect((caught as TsgitError).data).toEqual({
            code: 'REFLOG_NOT_FOUND',
            ref: 'refs/heads/exists-no-log',
          });
          const logPath = path.join(dir, '.git', 'logs', 'refs', 'heads', 'exists-no-log');
          await expect(stat(logPath)).rejects.toThrow();
        });
      });

      describe('When reflog show runs on a ref name that does not resolve to any ref at all', () => {
        it('Then both refuse before any log is walked', async () => {
          // Arrange
          const dir = await caseDir('degenerate-absent-ref');
          const ctx = createNodeContext({ workDir: dir });
          const sut = reflog;

          // Act
          const gitResult = tryRunGitWithExit(['-C', dir, 'reflog', 'show', 'totally-absent-ref']);
          let caught: unknown;
          try {
            await sut(ctx, { action: 'show', ref: 'totally-absent-ref' });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(gitResult.exitCode).toBe(128);
          expect(gitResult.stderr).toContain(
            "fatal: ambiguous argument 'totally-absent-ref': unknown revision or path not in the working tree.",
          );
          expect((caught as TsgitError).data).toEqual({
            code: 'REVPARSE_UNRESOLVED',
            expression: 'totally-absent-ref',
          });
        });
      });

      describe('When reflog show runs on a ref that resolves but carries no log', () => {
        it('Then both report nothing at all, without refusing', async () => {
          // Arrange
          const dir = await caseDir('resolves-no-log');
          git(dir, 'branch', 'quiet');
          await rm(branchLogPath(dir, 'quiet'), { force: true });
          const ctx = createNodeContext({ workDir: dir });
          const sut = reflog;

          // Act
          const gitResult = tryRunGitWithExit(['-C', dir, 'reflog', 'show', 'refs/heads/quiet']);
          const result = await sut(ctx, { action: 'show', ref: 'refs/heads/quiet' });

          // Assert
          expect(gitResult.exitCode).toBe(0);
          expect(gitResult.stdout).toBe('');
          expect(result.kind === 'show' && result.entries).toEqual([]);
        });
      });

      describe('When reflog show runs on a name whose log survives but whose ref is gone', () => {
        it('Then both refuse — the revision parse runs before the log is ever read', async () => {
          // Arrange — the log file stays on disk; only the ref is unlinked.
          const dir = await caseDir('log-without-ref');
          git(dir, 'branch', 'orphaned');
          await rm(refPath(dir, 'refs/heads/orphaned'), { force: true });
          const ctx = createNodeContext({ workDir: dir });
          const sut = reflog;

          // Act
          const gitResult = tryRunGitWithExit(['-C', dir, 'reflog', 'show', 'refs/heads/orphaned']);
          let caught: unknown;
          try {
            await sut(ctx, { action: 'show', ref: 'refs/heads/orphaned' });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(await pathExists(branchLogPath(dir, 'orphaned'))).toBe(true);
          expect(gitResult.exitCode).toBe(128);
          expect(gitResult.stderr).toContain('ambiguous argument');
          expect((caught as TsgitError).data).toEqual({
            code: 'REVPARSE_UNRESOLVED',
            expression: 'refs/heads/orphaned',
          });
        });
      });

      describe('When reflog show runs on HEAD in a repository with no commit yet', () => {
        it('Then both refuse — an unborn HEAD resolves to nothing', async () => {
          // Arrange
          const dir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-reflog-unborn-'));
          caseRoots.push(dir);
          runGit(['init', '-q', '-b', 'main', dir]);
          const ctx = createNodeContext({ workDir: dir });
          const sut = reflog;

          // Act
          const gitResult = tryRunGitWithExit(['-C', dir, 'reflog', 'show', 'HEAD']);
          let caught: unknown;
          try {
            await sut(ctx, { action: 'show', ref: 'HEAD' });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(gitResult.exitCode).toBe(128);
          expect(gitResult.stderr).toContain("fatal: ambiguous argument 'HEAD'");
          expect((caught as TsgitError).data).toEqual({
            code: 'REVPARSE_UNRESOLVED',
            expression: 'HEAD',
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
            path.join(os.tmpdir(), 'tsgit-reflog-interop-stash-base-'),
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

          // Assert — HEAD names `main` here, so logs/HEAD gains git's two
          // rename entries, byte-identical on both sides.
          const peerHeadBytes = await readFile(headLogPath(peer));
          const oursHeadBytes = await readFile(headLogPath(ours));
          expect(oursHeadBytes).toEqual(peerHeadBytes);
        });
      });
    });

    describe('Given a branch renamed onto a name nested under its own', () => {
      describe('When both tools rename it', () => {
        it("Then the destination ref and log are byte-identical to git's, the source gone", async () => {
          // Arrange — twin repos, the rename entry's committer timestamp
          // pinned on both sides so the whole destination log compares.
          const peer = await caseDir('nested-rename-down-peer');
          const ours = await caseDir('nested-rename-down-ours');
          const renameEpoch = BASE_EPOCH + 2_000;
          for (const dir of [peer, ours]) {
            runGit(['-C', dir, 'branch', 'a', 'main'], { env: pinnedCommitterEnv(BASE_EPOCH) });
          }
          const ctx = createNodeContext({ workDir: ours });

          // Act
          runGit(['-C', peer, 'branch', '-m', 'a', 'a/b'], {
            env: pinnedCommitterEnv(renameEpoch),
          });
          const dateSpy = vi.spyOn(Date, 'now').mockReturnValue(renameEpoch * 1000);
          try {
            await branchRename(ctx, { from: 'a', to: 'a/b' });
          } finally {
            dateSpy.mockRestore();
          }

          // Assert
          expect(await readFile(refPath(ours, 'refs/heads/a/b'), 'utf8')).toBe(
            await readFile(refPath(peer, 'refs/heads/a/b'), 'utf8'),
          );
          expect(await readFile(branchLogPath(ours, 'a/b'))).toEqual(
            await readFile(branchLogPath(peer, 'a/b')),
          );
          for (const dir of [peer, ours]) {
            expect((await stat(refPath(dir, 'refs/heads/a'))).isDirectory()).toBe(true);
            expect((await stat(branchLogPath(dir, 'a'))).isDirectory()).toBe(true);
          }
        });
      });
    });

    describe('Given a branch renamed onto the name it is nested under', () => {
      describe('When both tools rename it', () => {
        it("Then the destination ref and log are byte-identical to git's, the source tree pruned", async () => {
          // Arrange
          const peer = await caseDir('nested-rename-up-peer');
          const ours = await caseDir('nested-rename-up-ours');
          const renameEpoch = BASE_EPOCH + 3_000;
          for (const dir of [peer, ours]) {
            runGit(['-C', dir, 'branch', 'c/d', 'main'], { env: pinnedCommitterEnv(BASE_EPOCH) });
          }
          const ctx = createNodeContext({ workDir: ours });

          // Act
          runGit(['-C', peer, 'branch', '-m', 'c/d', 'c'], {
            env: pinnedCommitterEnv(renameEpoch),
          });
          const dateSpy = vi.spyOn(Date, 'now').mockReturnValue(renameEpoch * 1000);
          try {
            await branchRename(ctx, { from: 'c/d', to: 'c' });
          } finally {
            dateSpy.mockRestore();
          }

          // Assert
          expect(await readFile(refPath(ours, 'refs/heads/c'), 'utf8')).toBe(
            await readFile(refPath(peer, 'refs/heads/c'), 'utf8'),
          );
          expect(await readFile(branchLogPath(ours, 'c'))).toEqual(
            await readFile(branchLogPath(peer, 'c')),
          );
          for (const dir of [peer, ours]) {
            expect((await stat(refPath(dir, 'refs/heads/c'))).isFile()).toBe(true);
            expect((await stat(branchLogPath(dir, 'c'))).isFile()).toBe(true);
          }
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
          const headLogBefore = await readFile(headLogPath(peer));

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

          // Assert — HEAD names `main` here, not `left`/`right`, so renaming
          // neither names it; logs/HEAD is byte-unchanged on both sides (it
          // already existed from the base commit).
          expect(await readFile(headLogPath(peer))).toEqual(headLogBefore);
          expect(await readFile(headLogPath(ours))).toEqual(headLogBefore);
        });
      });
    });

    describe('Given a reftable-backed checked-out branch with two commits', () => {
      describe('When it is renamed', () => {
        it("Then migrating each side to the files format leaves logs/HEAD and the renamed branch's own log byte-identical", async () => {
          // Arrange — build a reftable repo with git, copy it twice, rename
          // on each side (git's CLI, tsgit's `branchRename`), then migrate
          // BOTH copies to the files format so their raw log bytes can be
          // compared directly (reftable has no per-ref log file of its own).
          const root = await mkdtemp(path.join(os.tmpdir(), 'tsgit-reflog-interop-rt-rename-'));
          caseRoots.push(root);
          runGit(['init', '-q', '-b', 'main', '--ref-format=reftable', root]);
          git(root, 'config', 'user.name', 'Ada');
          git(root, 'config', 'user.email', 'ada@example.com');
          git(root, 'config', 'commit.gpgsign', 'false');
          disableAutoMaintenance(root);
          await writeFile(path.join(root, 'f.txt'), 'c1\n');
          git(root, 'add', '-A');
          runGit(['-C', root, 'commit', '-q', '-m', 'c1'], { env: pinnedCommitterEnv(BASE_EPOCH) });
          await writeFile(path.join(root, 'f.txt'), 'c2\n');
          git(root, 'add', '-A');
          runGit(['-C', root, 'commit', '-q', '-m', 'c2'], {
            env: pinnedCommitterEnv(BASE_EPOCH + 1),
          });
          const peer = await cloneRepo(root, 'rt-rename-peer');
          const ours = await cloneRepo(root, 'rt-rename-ours');
          const renameEpoch = BASE_EPOCH + 500;
          const baseCtx = createNodeContext({ workDir: ours });
          const oursCtx: Context = {
            ...baseCtx,
            layout: { ...baseCtx.layout, refStorage: 'reftable' },
          };

          // Act
          runGit(['-C', peer, 'branch', '-m', 'main', 'renamed'], {
            env: pinnedCommitterEnv(renameEpoch),
          });
          const dateSpy = vi.spyOn(Date, 'now').mockReturnValue(renameEpoch * 1000);
          try {
            await branchRename(oursCtx, { from: 'main', to: 'renamed' });
          } finally {
            dateSpy.mockRestore();
          }
          runGit(['-C', peer, 'refs', 'migrate', '--ref-format=files']);
          runGit(['-C', ours, 'refs', 'migrate', '--ref-format=files']);

          // Assert
          const peerHeadBytes = await readFile(headLogPath(peer));
          const oursHeadBytes = await readFile(headLogPath(ours));
          expect(oursHeadBytes).toEqual(peerHeadBytes);
          const peerBranchBytes = await readFile(branchLogPath(peer, 'renamed'));
          const oursBranchBytes = await readFile(branchLogPath(ours, 'renamed'));
          expect(oursBranchBytes).toEqual(peerBranchBytes);
          expect(await pathExists(branchLogPath(peer, 'main'))).toBe(false);
          expect(await pathExists(branchLogPath(ours, 'main'))).toBe(false);
        });
      });
    });

    describe('Given a branch renamed onto its own name with force', () => {
      describe('When the self-rename runs on both sides', () => {
        it("Then the branch survives with git's own appended rename entry, byte-identical", async () => {
          // Arrange — `branch -M x x` exits 0 in git and appends one rename
          // entry; the branch and its prior history are untouched.
          const peer = await caseDir('self-rename-peer');
          const ours = await caseDir('self-rename-ours');
          const renameEpoch = BASE_EPOCH + 2_000;
          const ctx = createNodeContext({ workDir: ours });

          // Act
          runGit(['-C', peer, 'branch', '-M', 'main', 'main'], {
            env: pinnedCommitterEnv(renameEpoch),
          });
          const dateSpy = vi.spyOn(Date, 'now').mockReturnValue(renameEpoch * 1000);
          try {
            await branchRename(ctx, { from: 'main', to: 'main', force: true });
          } finally {
            dateSpy.mockRestore();
          }

          // Assert
          const peerBytes = await readFile(mainLogPath(peer));
          const oursBytes = await readFile(mainLogPath(ours));
          expect(oursBytes).toEqual(peerBytes);
        });
      });
    });

    describe('Given a SHA-256 repository with a corrupted refs/heads/main log', () => {
      describe('When main@{1} is deleted on both sides', () => {
        it('Then the rewritten logs are byte-identical at the 64-hex width', async () => {
          // Arrange — a dedicated --object-format=sha256 twin pair: the parse
          // offsets, the oid-width guard and the rewrite serializer all run at
          // hexLength 64 here, so this is a measurement, not an inference from
          // the SHA-1 rows.
          const root = await mkdtemp(path.join(os.tmpdir(), 'tsgit-reflog-interop-sha256-'));
          caseRoots.push(root);
          runGit(['init', '-q', '-b', 'main', '--object-format=sha256', root]);
          git(root, 'config', 'user.name', 'Ada');
          git(root, 'config', 'user.email', 'ada@example.com');
          git(root, 'config', 'commit.gpgsign', 'false');
          disableAutoMaintenance(root);
          for (let i = 0; i < 3; i += 1) {
            await writeFile(path.join(root, 'f.txt'), `v${i}\n`);
            git(root, 'add', '-A');
            runGit(['-C', root, 'commit', '-q', '-m', `c${i}`], {
              env: pinnedCommitterEnv(BASE_EPOCH + i),
            });
          }
          const raw = await readFile(mainLogPath(root), 'utf8');
          const lines = raw.split(/(?<=\n)/).filter((line) => line.length > 0);
          const corrupted = `${lines[0]}this is not a reflog line at all\n${lines[2]}`;
          const peer = await cloneRepo(root, 'sha256-delete-peer');
          const ours = await cloneRepo(root, 'sha256-delete-ours');
          await writeFile(mainLogPath(peer), corrupted, 'utf8');
          await writeFile(mainLogPath(ours), corrupted, 'utf8');

          // Act
          git(peer, 'reflog', 'delete', 'main@{1}');
          const ctx = createNodeContext({ workDir: ours, algorithm: 'sha256' });
          await reflog(ctx, { action: 'delete', ref: 'refs/heads/main', index: 1 });

          // Assert
          const peerBytes = await readFile(mainLogPath(peer));
          const oursBytes = await readFile(mainLogPath(ours));
          expect(oursBytes).toEqual(peerBytes);
        });
      });
    });

    describe('Given a CRLF-terminated refs/heads/main log', () => {
      describe('When expire runs with --expire=never on both sides', () => {
        it('Then every bare CR survives the rewrite byte-for-byte on both sides', async () => {
          // Arrange — a CR is legal message content: git's rewrite emits it
          // back verbatim rather than refusing, so a CRLF log round-trips
          // with every \r intact (only the rewrite TAB rule applies).
          const peer = await caseDir('expire-crlf-peer');
          const ours = await caseDir('expire-crlf-ours');
          const raw = await readFile(mainLogPath(peer), 'utf8');
          const crlf = raw.replaceAll('\n', '\r\n');
          await writeFile(mainLogPath(peer), crlf, 'utf8');
          await writeFile(mainLogPath(ours), crlf, 'utf8');

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
    });

    describe('Given main reset back behind a side branch that kept a newer commit', () => {
      describe('When expire runs with --expire=now --expire-unreachable=never on refs/heads/main', () => {
        it('Then git and tsgit both expire every entry unconditionally, byte-identical', async () => {
          // Arrange
          const peer = await cloneRepo(reachabilityBaseDir, 'reach-r1-peer');
          const ours = await cloneRepo(reachabilityBaseDir, 'reach-r1-ours');

          // Act
          git(
            peer,
            'reflog',
            'expire',
            '--expire=now',
            '--expire-unreachable=never',
            'refs/heads/main',
          );
          const ctx = createNodeContext({ workDir: ours });
          const result = await reflog(ctx, {
            action: 'expire',
            ref: 'refs/heads/main',
            expire: 'now',
            expireUnreachable: 'never',
          });

          // Assert
          expect(result).toEqual({ kind: 'expire', removed: 3, kept: 0 });
          const peerBytes = await readFile(mainLogPath(peer));
          const oursBytes = await readFile(mainLogPath(ours));
          expect(oursBytes).toEqual(peerBytes);
        });
      });

      describe('When expire runs with --expire=never --expire-unreachable=now on refs/heads/main', () => {
        it('Then git and tsgit both keep only the entry landing on the tip itself, byte-identical', async () => {
          // Arrange — reachability is measured from `main`'s own tip (A):
          // `A→B` and `B→A` both name B, reachable only through `side`.
          const peer = await cloneRepo(reachabilityBaseDir, 'reach-r2-peer');
          const ours = await cloneRepo(reachabilityBaseDir, 'reach-r2-ours');

          // Act
          git(
            peer,
            'reflog',
            'expire',
            '--expire=never',
            '--expire-unreachable=now',
            'refs/heads/main',
          );
          const ctx = createNodeContext({ workDir: ours });
          const result = await reflog(ctx, {
            action: 'expire',
            ref: 'refs/heads/main',
            expire: 'never',
            expireUnreachable: 'now',
          });

          // Assert
          expect(result).toEqual({ kind: 'expire', removed: 2, kept: 1 });
          const peerBytes = await readFile(mainLogPath(peer));
          const oursBytes = await readFile(mainLogPath(ours));
          expect(oursBytes).toEqual(peerBytes);
        });
      });

      describe('When expire runs with --expire=never --expire-unreachable=now on HEAD', () => {
        it('Then git and tsgit both keep every entry, byte-identical', async () => {
          // Arrange — the same cutoffs as the previous case, but against
          // HEAD: marking from every current tip (main=A, side=C) reaches
          // A, B and C, so nothing in this log is unreachable.
          const peer = await cloneRepo(reachabilityBaseDir, 'reach-r3-peer');
          const ours = await cloneRepo(reachabilityBaseDir, 'reach-r3-ours');

          // Act
          git(peer, 'reflog', 'expire', '--expire=never', '--expire-unreachable=now', 'HEAD');
          const ctx = createNodeContext({ workDir: ours });
          const result = await reflog(ctx, {
            action: 'expire',
            ref: 'HEAD',
            expire: 'never',
            expireUnreachable: 'now',
          });

          // Assert
          expect(result).toEqual({ kind: 'expire', removed: 0, kept: 6 });
          const peerBytes = await readFile(headLogPath(peer));
          const oursBytes = await readFile(headLogPath(ours));
          expect(oursBytes).toEqual(peerBytes);
        });
      });

      describe('When expire runs with --expire=never --expire-unreachable=never on refs/heads/main', () => {
        it('Then git and tsgit both keep every entry without a walk, byte-identical', async () => {
          // Arrange
          const peer = await cloneRepo(reachabilityBaseDir, 'reach-r4-peer');
          const ours = await cloneRepo(reachabilityBaseDir, 'reach-r4-ours');

          // Act
          git(
            peer,
            'reflog',
            'expire',
            '--expire=never',
            '--expire-unreachable=never',
            'refs/heads/main',
          );
          const ctx = createNodeContext({ workDir: ours });
          const result = await reflog(ctx, {
            action: 'expire',
            ref: 'refs/heads/main',
            expire: 'never',
            expireUnreachable: 'never',
          });

          // Assert
          expect(result).toEqual({ kind: 'expire', removed: 0, kept: 3 });
          const peerBytes = await readFile(mainLogPath(peer));
          const oursBytes = await readFile(mainLogPath(ours));
          expect(oursBytes).toEqual(peerBytes);
        });
      });

      describe('When expire runs with explicit numeric cutoffs on refs/heads/main', () => {
        it('Then git and tsgit judge each entry the same way, byte-identical', async () => {
          // Arrange — `0→A` is below the total cutoff and expires
          // unconditionally; `A→B` is between the two cutoffs and expires
          // because B is unreachable from A; `B→A` is at or above the
          // unreachable cutoff and is kept without a reachability check.
          const peer = await cloneRepo(reachabilityBaseDir, 'reach-r5-peer');
          const ours = await cloneRepo(reachabilityBaseDir, 'reach-r5-ours');
          const expire = `@${REACHABILITY_EPOCH + 50}`;
          const expireUnreachable = `@${REACHABILITY_EPOCH + 150}`;

          // Act
          git(
            peer,
            'reflog',
            'expire',
            `--expire=${expire}`,
            `--expire-unreachable=${expireUnreachable}`,
            'refs/heads/main',
          );
          const ctx = createNodeContext({ workDir: ours });
          const result = await reflog(ctx, {
            action: 'expire',
            ref: 'refs/heads/main',
            expire,
            expireUnreachable,
          });

          // Assert
          expect(result).toEqual({ kind: 'expire', removed: 2, kept: 1 });
          const peerBytes = await readFile(mainLogPath(peer));
          const oursBytes = await readFile(mainLogPath(ours));
          expect(oursBytes).toEqual(peerBytes);
        });
      });
    });

    describe('Given a later commit created on main then reset away', () => {
      describe('When expire runs with --expire=now --expire-unreachable=never', () => {
        it('Then git and tsgit both expire every entry unconditionally, byte-identical', async () => {
          // Arrange
          const peer = await cloneRepo(reachabilityWithDBaseDir, 'reach-r6a-peer');
          const ours = await cloneRepo(reachabilityWithDBaseDir, 'reach-r6a-ours');

          // Act
          git(
            peer,
            'reflog',
            'expire',
            '--expire=now',
            '--expire-unreachable=never',
            'refs/heads/main',
          );
          const ctx = createNodeContext({ workDir: ours });
          const result = await reflog(ctx, {
            action: 'expire',
            ref: 'refs/heads/main',
            expire: 'now',
            expireUnreachable: 'never',
          });

          // Assert
          expect(result).toEqual({ kind: 'expire', removed: 4, kept: 0 });
          const peerBytes = await readFile(mainLogPath(peer));
          const oursBytes = await readFile(mainLogPath(ours));
          expect(oursBytes).toEqual(peerBytes);
        });
      });

      describe('When expire runs with --expire=never --expire-unreachable=now', () => {
        it('Then git and tsgit both expire the entries naming the unreachable commit on either side, byte-identical', async () => {
          // Arrange — D is unreachable from B (main's tip): the entry moving
          // TO D expires because its new id is unreachable, the entry
          // moving FROM D expires because its old id is unreachable.
          const peer = await cloneRepo(reachabilityWithDBaseDir, 'reach-r6b-peer');
          const ours = await cloneRepo(reachabilityWithDBaseDir, 'reach-r6b-ours');

          // Act
          git(
            peer,
            'reflog',
            'expire',
            '--expire=never',
            '--expire-unreachable=now',
            'refs/heads/main',
          );
          const ctx = createNodeContext({ workDir: ours });
          const result = await reflog(ctx, {
            action: 'expire',
            ref: 'refs/heads/main',
            expire: 'never',
            expireUnreachable: 'now',
          });

          // Assert
          expect(result).toEqual({ kind: 'expire', removed: 2, kept: 2 });
          const peerBytes = await readFile(mainLogPath(peer));
          const oursBytes = await readFile(mainLogPath(ours));
          expect(oursBytes).toEqual(peerBytes);
        });
      });

      describe('When expire runs with an unreachable cutoff not later than the total cutoff', () => {
        it('Then git and tsgit both decide by the clock alone, byte-identical', async () => {
          // Arrange
          const peer = await cloneRepo(reachabilityWithDBaseDir, 'reach-r6c-peer');
          const ours = await cloneRepo(reachabilityWithDBaseDir, 'reach-r6c-ours');
          const expire = `@${REACHABILITY_EPOCH + 150}`;
          const expireUnreachable = `@${REACHABILITY_EPOCH + 50}`;

          // Act
          git(
            peer,
            'reflog',
            'expire',
            `--expire=${expire}`,
            `--expire-unreachable=${expireUnreachable}`,
            'refs/heads/main',
          );
          const ctx = createNodeContext({ workDir: ours });
          const result = await reflog(ctx, {
            action: 'expire',
            ref: 'refs/heads/main',
            expire,
            expireUnreachable,
          });

          // Assert
          expect(result).toEqual({ kind: 'expire', removed: 2, kept: 2 });
          const peerBytes = await readFile(mainLogPath(peer));
          const oursBytes = await readFile(mainLogPath(ours));
          expect(oursBytes).toEqual(peerBytes);
        });
      });
    });

    describe('Given a mark left over below the total cutoff, reachable only through it', () => {
      describe('When expire runs with explicit numeric cutoffs on refs/heads/main', () => {
        it('Then git and tsgit both drop the bound on the miss and keep the same three entries, byte-identical', async () => {
          // Arrange — R's parent Q sits below the total cutoff, so the
          // bounded pass marks Q but stops there, without ever reaching P.
          // git's date bound is laziness only: the first miss on P drops the
          // bound and re-expands Q, discovering P after all.
          const peer = await cloneRepo(frontierBaseDir, 'frontier-peer');
          const ours = await cloneRepo(frontierBaseDir, 'frontier-ours');
          const expire = `@${REACHABILITY_EPOCH + 2000}`;
          const expireUnreachable = `@${REACHABILITY_EPOCH + 4000}`;

          // Act
          git(
            peer,
            'reflog',
            'expire',
            `--expire=${expire}`,
            `--expire-unreachable=${expireUnreachable}`,
            'refs/heads/main',
          );
          const ctx = createNodeContext({ workDir: ours });
          const result = await reflog(ctx, {
            action: 'expire',
            ref: 'refs/heads/main',
            expire,
            expireUnreachable,
          });

          // Assert — `0→P` and `P→Q` are below the total cutoff and expire
          // unconditionally; `Q→R`, `R→P` and `P→R` all survive, P and R
          // proven mutually reachable only once the bound is dropped.
          expect(result).toEqual({ kind: 'expire', removed: 2, kept: 3 });
          const peerBytes = await readFile(mainLogPath(peer));
          const oursBytes = await readFile(mainLogPath(ours));
          expect(oursBytes).toEqual(peerBytes);
        });
      });
    });

    describe('Given an entry naming an object that was never written', () => {
      describe('When expire runs with --expire=never --expire-unreachable=now on refs/heads/main', () => {
        it('Then git and tsgit both treat the missing object as a gentle-lookup miss and keep every entry, byte-identical', async () => {
          // Arrange — git's `lookup_commit_reference_gently` returns NULL on
          // any resolution failure, a name that was never written included;
          // the caller keeps the entry rather than aborting the expire.
          const peer = await caseDir('missing-object-peer');
          const ours = await caseDir('missing-object-ours');
          const missing = 'f'.repeat(40);
          const line2 = `${c0} ${missing} Ada <ada@example.com> ${BASE_EPOCH + 100} +0200\tprobe: named object never written\n`;
          const line3 = `${missing} ${c0} Ada <ada@example.com> ${BASE_EPOCH + 200} +0200\tprobe: named object never written\n`;
          const text = `${baseLines[0]}${line2}${line3}`;
          await writeFile(mainLogPath(peer), text, 'utf8');
          await writeFile(mainLogPath(ours), text, 'utf8');

          // Act
          git(
            peer,
            'reflog',
            'expire',
            '--expire=never',
            '--expire-unreachable=now',
            'refs/heads/main',
          );
          const ctx = createNodeContext({ workDir: ours });
          const result = await reflog(ctx, {
            action: 'expire',
            ref: 'refs/heads/main',
            expire: 'never',
            expireUnreachable: 'now',
          });

          // Assert
          expect(result).toEqual({ kind: 'expire', removed: 0, kept: 3 });
          const peerBytes = await readFile(mainLogPath(peer));
          const oursBytes = await readFile(mainLogPath(ours));
          expect(oursBytes).toEqual(peerBytes);
        });
      });
    });

    describe('Given HEAD detached at a commit no ref under refs/ names', () => {
      describe('When expire runs with --expire=never --expire-unreachable=now on HEAD', () => {
        it('Then git and tsgit both exclude HEAD itself from the tip set, byte-identical', async () => {
          // Arrange — git seeds `UE_HEAD`'s mark list via `refs_for_each_ref`,
          // refs under `refs/` only; `HEAD` is never pushed as a tip in its
          // own right, detached or not. `main` (the only ref) sits at A; B is
          // reachable only by way of the detached HEAD.
          const peer = await cloneRepo(detachedHeadBaseDir, 'detached-peer');
          const ours = await cloneRepo(detachedHeadBaseDir, 'detached-ours');

          // Act
          git(peer, 'reflog', 'expire', '--expire=never', '--expire-unreachable=now', 'HEAD');
          const ctx = createNodeContext({ workDir: ours });
          const result = await reflog(ctx, {
            action: 'expire',
            ref: 'HEAD',
            expire: 'never',
            expireUnreachable: 'now',
          });

          // Assert — the entry naming B (`commit: b`) expires; B is
          // unreachable from `main` (the only ref, still at A), and the
          // detached HEAD that names it is never itself a tip.
          expect(result).toEqual({ kind: 'expire', removed: 1, kept: 2 });
          const peerBytes = await readFile(headLogPath(peer));
          const oursBytes = await readFile(headLogPath(ours));
          expect(oursBytes).toEqual(peerBytes);
        });
      });
    });

    describe('Given a branch ref deleted while its reflog file remains', () => {
      describe('When expire runs with --all --expire=never --expire-unreachable=now', () => {
        it('Then git and tsgit both fully expire the orphaned log, byte-identical', async () => {
          // Arrange — the ref no longer resolves to a commit, so its log
          // expires by clock alone under `--all`, on both tools.
          const peer = await caseDir('reach-gone-all-peer');
          const ours = await caseDir('reach-gone-all-ours');
          for (const dir of [peer, ours]) {
            git(dir, 'branch', 'gone');
            await rm(refPath(dir, 'refs/heads/gone'));
          }

          // Act
          git(peer, 'reflog', 'expire', '--all', '--expire=never', '--expire-unreachable=now');
          const ctx = createNodeContext({ workDir: ours });
          await reflog(ctx, {
            action: 'expire',
            all: true,
            expire: 'never',
            expireUnreachable: 'now',
          });

          // Assert
          const peerBytes = await readFile(branchLogPath(peer, 'gone'));
          const oursBytes = await readFile(branchLogPath(ours, 'gone'));
          expect(peerBytes).toHaveLength(0);
          expect(oursBytes).toEqual(peerBytes);
        });
      });

      describe('When expire runs directly against the gone ref (full and short name)', () => {
        it.each([
          { label: 'the full name', arg: 'refs/heads/gone' },
          { label: 'the short name', arg: 'gone' },
        ])(
          'Then $label both refuse REFLOG_NOT_FOUND, and the log survives on both',
          async ({ arg }) => {
            // Arrange — `repo_dwim_log` requires the name to resolve for
            // reading before its log is even consulted; a deleted ref never
            // resolves, so this is now an agreement row, not a divergence.
            const dir = await caseDir(`reach-gone-single-${arg.replace(/\W/g, '')}`);
            git(dir, 'branch', 'gone');
            await rm(refPath(dir, 'refs/heads/gone'));
            const before = await readFile(branchLogPath(dir, 'gone'), 'utf8');
            const ctx = createNodeContext({ workDir: dir });

            // Act
            const gitResult = tryRunGitWithExit([
              '-C',
              dir,
              'reflog',
              'expire',
              '--expire=never',
              '--expire-unreachable=now',
              arg,
            ]);
            let caught: unknown;
            try {
              await reflog(ctx, {
                action: 'expire',
                ref: arg,
                expire: 'never',
                expireUnreachable: 'now',
              });
            } catch (err) {
              caught = err;
            }

            // Assert
            expect(gitResult.exitCode).toBe(255);
            expect(gitResult.stderr).toContain(`reflog could not be found: '${arg}'`);
            expect((caught as TsgitError).data).toEqual({ code: 'REFLOG_NOT_FOUND', ref: arg });
            expect(await readFile(branchLogPath(dir, 'gone'), 'utf8')).toBe(before);
          },
        );
      });
    });

    describe('target resolution (repo_dwim_log)', () => {
      describe('Given a packed-only ref with a reflog', () => {
        describe('When expire runs on its full name with --expire=now', () => {
          it('Then both tools fully expire it, byte-identical', async () => {
            // Arrange
            const peer = await caseDir('dwim-packed-peer');
            const ours = await caseDir('dwim-packed-ours');
            for (const dir of [peer, ours]) {
              git(dir, 'pack-refs', '--all');
              const before = await readFile(mainLogPath(dir), 'utf8');
              expect(before.length).toBeGreaterThan(0);
            }

            // Act
            git(peer, 'reflog', 'expire', '--expire=now', '--expire-unreachable=never', 'main');
            const ctx = createNodeContext({ workDir: ours });
            const result = await reflog(ctx, {
              action: 'expire',
              ref: 'main',
              expire: 'now',
              expireUnreachable: 'never',
            });

            // Assert — both tools accept the packed-only ref as a target,
            // and the DWIMed log is fully expired on both.
            const peerBytes = await readFile(mainLogPath(peer), 'utf8');
            const oursBytes = await readFile(mainLogPath(ours), 'utf8');
            expect(peerBytes).toHaveLength(0);
            expect(oursBytes).toBe(peerBytes);
            expect(result).toEqual({ kind: 'expire', removed: 4, kept: 0 });
          });
        });
      });

      describe('Given a short name resolving under refs/heads', () => {
        describe('When expire runs on the short name with --expire=now', () => {
          it('Then both tools fully expire the DWIMed branch log', async () => {
            // Arrange
            const peer = await caseDir('dwim-short-peer');
            const ours = await caseDir('dwim-short-ours');
            for (const dir of [peer, ours]) {
              runGit(['-C', dir, 'branch', 'side'], { env: runGitEnv() });
            }

            // Act
            git(peer, 'reflog', 'expire', '--expire=now', '--expire-unreachable=never', 'side');
            const ctx = createNodeContext({ workDir: ours });
            await reflog(ctx, {
              action: 'expire',
              ref: 'side',
              expire: 'now',
              expireUnreachable: 'never',
            });

            // Assert
            const peerBytes = await readFile(branchLogPath(peer, 'side'), 'utf8');
            const oursBytes = await readFile(branchLogPath(ours, 'side'), 'utf8');
            expect(peerBytes).toHaveLength(0);
            expect(oursBytes).toBe(peerBytes);
          });
        });
      });

      describe('Given a symbolic ref with its own log, pointing at a branch that also has one', () => {
        describe('When expire runs on the symbolic ref name', () => {
          it("Then both tools expire only the symref's own log", async () => {
            // Arrange
            const peer = await caseDir('dwim-symref-own-peer');
            const ours = await caseDir('dwim-symref-own-ours');
            for (const dir of [peer, ours]) {
              runGit(['-C', dir, 'symbolic-ref', 'refs/heads/sym2', 'refs/heads/main'], {
                env: runGitEnv(),
              });
              runGit(['-C', dir, 'update-ref', '-m', 'seed', 'refs/heads/sym2', 'HEAD'], {
                env: runGitEnv(),
              });
            }

            // Act
            git(peer, 'reflog', 'expire', '--expire=now', '--expire-unreachable=never', 'sym2');
            const ctx = createNodeContext({ workDir: ours });
            await reflog(ctx, {
              action: 'expire',
              ref: 'sym2',
              expire: 'now',
              expireUnreachable: 'never',
            });

            // Assert — the symref's own log emptied on both; main's untouched.
            const peerSym = await readFile(branchLogPath(peer, 'sym2'), 'utf8');
            const oursSym = await readFile(branchLogPath(ours, 'sym2'), 'utf8');
            expect(peerSym).toHaveLength(0);
            expect(oursSym).toBe(peerSym);
            const mainAfter = await readFile(mainLogPath(ours), 'utf8');
            expect(mainAfter).toBe(await readFile(mainLogPath(peer), 'utf8'));
          });
        });
      });

      describe('Given a symbolic ref with no own log, pointing at a branch that has one', () => {
        describe('When expire runs on the symbolic ref name', () => {
          it("Then both tools expire the target branch's log", async () => {
            // Arrange — the symref is planted directly as a loose file
            // (never through `git symbolic-ref`, which writes its OWN
            // creation entry to `logs/refs/heads/sym2` and would defeat the
            // "no own log" premise this row pins).
            const peer = await caseDir('dwim-symref-target-peer');
            const ours = await caseDir('dwim-symref-target-ours');
            for (const dir of [peer, ours]) {
              await writeFile(refPath(dir, 'refs/heads/sym2'), 'ref: refs/heads/main\n');
            }

            // Act
            git(peer, 'reflog', 'expire', '--expire=now', '--expire-unreachable=never', 'sym2');
            const ctx = createNodeContext({ workDir: ours });
            await reflog(ctx, {
              action: 'expire',
              ref: 'sym2',
              expire: 'now',
              expireUnreachable: 'never',
            });

            // Assert
            const peerMain = await readFile(mainLogPath(peer), 'utf8');
            const oursMain = await readFile(mainLogPath(ours), 'utf8');
            expect(peerMain).toHaveLength(0);
            expect(oursMain).toBe(peerMain);
          });
        });
      });

      describe('Given HEAD with no own log, pointing at a branch that has one', () => {
        describe('When expire runs on HEAD', () => {
          it("Then both tools expire the branch's log", async () => {
            // Arrange
            const peer = await caseDir('dwim-head-target-peer');
            const ours = await caseDir('dwim-head-target-ours');
            for (const dir of [peer, ours]) {
              await rm(headLogPath(dir));
            }

            // Act
            git(peer, 'reflog', 'expire', '--expire=now', '--expire-unreachable=never', 'HEAD');
            const ctx = createNodeContext({ workDir: ours });
            await reflog(ctx, {
              action: 'expire',
              ref: 'HEAD',
              expire: 'now',
              expireUnreachable: 'never',
            });

            // Assert
            const peerMain = await readFile(mainLogPath(peer), 'utf8');
            const oursMain = await readFile(mainLogPath(ours), 'utf8');
            expect(peerMain).toHaveLength(0);
            expect(oursMain).toBe(peerMain);
          });
        });
      });

      describe('Given an invalid or selector-suffixed argument', () => {
        describe('When expire runs', () => {
          it.each([
            { label: 'a ref name containing ..', arg: 'refs/heads/bad..name' },
            { label: 'HEAD with a reflog selector suffix', arg: 'HEAD@{0}' },
          ])('Then $label both refuse REFLOG_NOT_FOUND', async ({ arg }) => {
            // Arrange
            const dir = await caseDir(`dwim-invalid-${arg.replace(/\W/g, '')}`);
            const ctx = createNodeContext({ workDir: dir });

            // Act
            const gitResult = tryRunGitWithExit(['-C', dir, 'reflog', 'expire', arg]);
            let caught: unknown;
            try {
              await reflog(ctx, { action: 'expire', ref: arg });
            } catch (err) {
              caught = err;
            }

            // Assert
            expect(gitResult.exitCode).toBe(255);
            expect(gitResult.stderr).toContain(`reflog could not be found: '${arg}'`);
            expect((caught as TsgitError).data).toEqual({ code: 'REFLOG_NOT_FOUND', ref: arg });
          });
        });
      });

      describe('Given zero reflogs and a malformed core.deltaBaseCacheLimit', () => {
        describe('When expire runs with --all --expire=now', () => {
          it('Then both tools are a no-op — the repo-settings class is never reached', async () => {
            // Arrange — every reflog the base repo wrote is removed first.
            const peer = await caseDir('dwim-zero-all-peer');
            const ours = await caseDir('dwim-zero-all-ours');
            for (const dir of [peer, ours]) {
              await rm(headLogPath(dir));
              await rm(mainLogPath(dir));
              await appendFile(
                path.join(dir, '.git', 'config'),
                '[core]\n\tdeltaBaseCacheLimit = -1\n',
              );
            }

            // Act
            const gitResult = tryRunGitWithExit([
              '-C',
              peer,
              'reflog',
              'expire',
              '--all',
              '--expire=now',
            ]);
            const ctx = createNodeContext({ workDir: ours });
            const result = await reflog(ctx, { action: 'expire', all: true, expire: 'now' });

            // Assert
            expect(gitResult.exitCode).toBe(0);
            expect(result).toEqual({ kind: 'expire', removed: 0, kept: 0 });
          });
        });
      });

      describe('Given a symbolic ref carrying its own log but pointing at a missing branch', () => {
        describe('When expire runs on the dangling symref (full and short name)', () => {
          it.each([
            { label: 'the full name', arg: 'refs/heads/sym' },
            { label: 'the short name', arg: 'sym' },
          ])(
            'Then $label both refuse REFLOG_NOT_FOUND, and the log survives on both',
            async ({ arg }) => {
              // Arrange — the symref resolves for writing but never for
              // reading, so its own log is never consulted.
              const dir = await caseDir(`dwim-dangling-${arg.replace(/\W/g, '')}`);
              git(dir, 'symbolic-ref', 'refs/heads/sym', 'refs/heads/nope');
              await cp(mainLogPath(dir), branchLogPath(dir, 'sym'));
              const before = await readFile(branchLogPath(dir, 'sym'), 'utf8');
              const ctx = createNodeContext({ workDir: dir });

              // Act
              const gitResult = tryRunGitWithExit([
                '-C',
                dir,
                'reflog',
                'expire',
                '--expire=now',
                arg,
              ]);
              let caught: unknown;
              try {
                await reflog(ctx, { action: 'expire', ref: arg, expire: 'now' });
              } catch (err) {
                caught = err;
              }

              // Assert
              expect(gitResult.exitCode).toBe(255);
              expect(gitResult.stderr).toBe(`error: reflog could not be found: '${arg}'\n`);
              expect((caught as TsgitError).data).toEqual({ code: 'REFLOG_NOT_FOUND', ref: arg });
              expect(await readFile(branchLogPath(dir, 'sym'), 'utf8')).toBe(before);
            },
          );
        });
      });

      describe('Given HEAD pointing at a branch that was never born, with logs/HEAD present', () => {
        describe('When expire runs on HEAD', () => {
          it('Then both tools refuse REFLOG_NOT_FOUND and leave logs/HEAD intact', async () => {
            // Arrange
            const dir = await caseDir('dwim-unborn-head');
            git(dir, 'symbolic-ref', 'HEAD', 'refs/heads/unborn');
            const before = await readFile(headLogPath(dir), 'utf8');
            expect(before.length).toBeGreaterThan(0);
            const ctx = createNodeContext({ workDir: dir });

            // Act
            const gitResult = tryRunGitWithExit([
              '-C',
              dir,
              'reflog',
              'expire',
              '--expire=now',
              'HEAD',
            ]);
            let caught: unknown;
            try {
              await reflog(ctx, { action: 'expire', ref: 'HEAD', expire: 'now' });
            } catch (err) {
              caught = err;
            }

            // Assert
            expect(gitResult.exitCode).toBe(255);
            expect(gitResult.stderr).toBe("error: reflog could not be found: 'HEAD'\n");
            expect((caught as TsgitError).data).toEqual({
              code: 'REFLOG_NOT_FOUND',
              ref: 'HEAD',
            });
            expect(await readFile(headLogPath(dir), 'utf8')).toBe(before);
          });
        });
      });

      describe('Given a loose ref whose file holds text that is not an object id', () => {
        describe('When expire runs on that ref, whose log exists', () => {
          it('Then both tools refuse REFLOG_NOT_FOUND and leave the log intact', async () => {
            // Arrange — resolution for reading fails on the content itself,
            // before the log is looked for.
            const dir = await caseDir('dwim-unparseable-ref');
            await writeFile(refPath(dir, 'refs/heads/bad'), 'not-an-object-id\n');
            await cp(mainLogPath(dir), branchLogPath(dir, 'bad'));
            const before = await readFile(branchLogPath(dir, 'bad'), 'utf8');
            const ctx = createNodeContext({ workDir: dir });

            // Act
            const gitResult = tryRunGitWithExit([
              '-C',
              dir,
              'reflog',
              'expire',
              '--expire=now',
              'refs/heads/bad',
            ]);
            let caught: unknown;
            try {
              await reflog(ctx, { action: 'expire', ref: 'refs/heads/bad', expire: 'now' });
            } catch (err) {
              caught = err;
            }

            // Assert
            expect(gitResult.exitCode).toBe(255);
            expect(gitResult.stderr).toBe("error: reflog could not be found: 'refs/heads/bad'\n");
            expect((caught as TsgitError).data).toEqual({
              code: 'REFLOG_NOT_FOUND',
              ref: 'refs/heads/bad',
            });
            expect(await readFile(branchLogPath(dir, 'bad'), 'utf8')).toBe(before);
          });
        });
      });

      describe('Given a ref naming an object that was never written, with a log of its own', () => {
        describe.each([
          {
            label: 'an explicit --expire=now',
            flags: { expire: 'now' } as const,
            gitFlags: ['--expire=now'],
          },
          {
            label: 'an explicit --expire=never with --expire-unreachable=now',
            flags: { expire: 'never', expireUnreachable: 'now' } as const,
            gitFlags: ['--expire=never', '--expire-unreachable=now'],
          },
        ])('When expire runs with $label', ({ label, flags, gitFlags }) => {
          it('Then both tools fully expire the log, byte-identical', async () => {
            // Arrange — resolution never reads the object, so the target is
            // accepted; the tip then peels to nothing, which is what makes
            // even the unreachable-only cutoff sweep every entry.
            const slug = label.replace(/\W+/g, '');
            const peer = await caseDir(`dwim-missing-object-peer-${slug}`);
            const ours = await caseDir(`dwim-missing-object-ours-${slug}`);
            for (const dir of [peer, ours]) {
              await writeFile(refPath(dir, 'refs/heads/ghost'), `${'1'.repeat(40)}\n`);
              await cp(mainLogPath(dir), branchLogPath(dir, 'ghost'));
            }

            // Act
            const gitResult = tryRunGitWithExit([
              '-C',
              peer,
              'reflog',
              'expire',
              ...gitFlags,
              'refs/heads/ghost',
            ]);
            const ctx = createNodeContext({ workDir: ours });
            await reflog(ctx, { action: 'expire', ref: 'refs/heads/ghost', ...flags });

            // Assert
            expect(gitResult.exitCode).toBe(0);
            const peerBytes = await readFile(branchLogPath(peer, 'ghost'));
            expect(peerBytes).toHaveLength(0);
            expect(await readFile(branchLogPath(ours, 'ghost'))).toEqual(peerBytes);
          });
        });
      });

      describe('Given no ref argument and no --all', () => {
        describe('When expire runs with --expire=now', () => {
          it('Then both tools leave every log untouched', async () => {
            // Arrange
            const peer = await caseDir('dwim-no-target-peer');
            const ours = await caseDir('dwim-no-target-ours');
            const beforeMain = await readFile(mainLogPath(peer), 'utf8');
            const beforeHead = await readFile(headLogPath(peer), 'utf8');
            expect(beforeMain.length).toBeGreaterThan(0);
            expect(beforeHead.length).toBeGreaterThan(0);

            // Act
            const gitResult = tryRunGitWithExit(['-C', peer, 'reflog', 'expire', '--expire=now']);
            const ctx = createNodeContext({ workDir: ours });
            const result = await reflog(ctx, { action: 'expire', expire: 'now' });

            // Assert — HEAD is NOT defaulted to: neither log moves.
            expect(gitResult.exitCode).toBe(0);
            expect(result).toEqual({ kind: 'expire', removed: 0, kept: 0 });
            for (const dir of [peer, ours]) {
              expect(await readFile(mainLogPath(dir), 'utf8')).toBe(beforeMain);
              expect(await readFile(headLogPath(dir), 'utf8')).toBe(beforeHead);
            }
          });
        });
      });
    });

    describe('the repo-settings class relative to target resolution', () => {
      /** A `core.deltaBaseCacheLimit` the class refuses — appended LAST, so
       *  every `git` call that builds the fixture still runs on a clean config. */
      const poisonClass = (dir: string): Promise<void> =>
        appendFile(path.join(dir, '.git', 'config'), '[core]\n\tdeltaBaseCacheLimit = bogus\n');

      describe('Given a malformed core.deltaBaseCacheLimit and a target that cannot resolve', () => {
        describe.each([
          { label: 'a name no ref ever had', arg: 'refs/heads/nope', orphanLog: false },
          { label: 'a deleted ref whose log remains', arg: 'refs/heads/gone', orphanLog: true },
        ])('When expire runs against $label', ({ label, arg, orphanLog }) => {
          it('Then both tools refuse on the target, never on the class', async () => {
            // Arrange
            const dir = await caseDir(`class-after-target-${label.replace(/\W+/g, '')}`);
            if (orphanLog) {
              git(dir, 'branch', 'gone');
              await rm(refPath(dir, 'refs/heads/gone'));
            }
            await poisonClass(dir);
            const ctx = createNodeContext({ workDir: dir });

            // Act
            const gitResult = tryRunGitWithExit([
              '-C',
              dir,
              'reflog',
              'expire',
              '--expire=now',
              arg,
            ]);
            let caught: unknown;
            try {
              await reflog(ctx, { action: 'expire', ref: arg, expire: 'now' });
            } catch (err) {
              caught = err;
            }

            // Assert — the class refusal never appears on either side.
            expect(gitResult.exitCode).toBe(255);
            expect(gitResult.stderr).toBe(`error: reflog could not be found: '${arg}'\n`);
            expect((caught as TsgitError).data).toEqual({ code: 'REFLOG_NOT_FOUND', ref: arg });
          });
        });
      });

      describe('Given a malformed core.deltaBaseCacheLimit and an unparseable --expire value', () => {
        describe('When expire runs on HEAD', () => {
          it('Then both tools refuse on the flag, never on the class', async () => {
            // Arrange
            const dir = await caseDir('class-after-flag');
            await poisonClass(dir);
            const before = await readFile(headLogPath(dir), 'utf8');
            const ctx = createNodeContext({ workDir: dir });

            // Act
            const gitResult = tryRunGitWithExit([
              '-C',
              dir,
              'reflog',
              'expire',
              '--expire=bogus',
              'HEAD',
            ]);
            let caught: unknown;
            try {
              await reflog(ctx, { action: 'expire', ref: 'HEAD', expire: 'bogus' });
            } catch (err) {
              caught = err;
            }

            // Assert — git names the flag; tsgit's own refusal for this one
            // path is a recorded divergence in message, not in ordering.
            expect(gitResult.exitCode).toBe(128);
            expect(gitResult.stderr).toBe("fatal: invalid timestamp 'bogus' given to '--expire'\n");
            expect((caught as TsgitError).data).toEqual({
              code: 'REVPARSE_UNRESOLVED',
              expression: 'bogus',
            });
            expect(await readFile(headLogPath(dir), 'utf8')).toBe(before);
          });
        });
      });

      describe('Given a malformed core.deltaBaseCacheLimit and no target at all', () => {
        describe('When expire runs with --expire=now and no ref', () => {
          it('Then both tools succeed — zero targets never reach the class', async () => {
            // Arrange
            const peer = await caseDir('class-zero-target-peer');
            const ours = await caseDir('class-zero-target-ours');
            for (const dir of [peer, ours]) await poisonClass(dir);
            const before = await readFile(mainLogPath(peer), 'utf8');

            // Act
            const gitResult = tryRunGitWithExit(['-C', peer, 'reflog', 'expire', '--expire=now']);
            const ctx = createNodeContext({ workDir: ours });
            const result = await reflog(ctx, { action: 'expire', expire: 'now' });

            // Assert
            expect(gitResult.exitCode).toBe(0);
            expect(gitResult.stderr).toBe('');
            expect(result).toEqual({ kind: 'expire', removed: 0, kept: 0 });
            for (const dir of [peer, ours]) {
              expect(await readFile(mainLogPath(dir), 'utf8')).toBe(before);
            }
          });
        });
      });

      describe('Given a malformed core.deltaBaseCacheLimit and reflogs to sweep', () => {
        describe('When expire runs with --all --expire=now', () => {
          it('Then both tools refuse on the class, naming the same key and value', async () => {
            // Arrange
            const peer = await caseDir('class-all-peer');
            const ours = await caseDir('class-all-ours');
            for (const dir of [peer, ours]) await poisonClass(dir);
            const beforeMain = await readFile(mainLogPath(peer), 'utf8');
            const beforeHead = await readFile(headLogPath(peer), 'utf8');

            // Act
            const gitResult = tryRunGitWithExit([
              '-C',
              peer,
              'reflog',
              'expire',
              '--all',
              '--expire=now',
            ]);
            const ctx = createNodeContext({ workDir: ours });
            let caught: unknown;
            try {
              await reflog(ctx, { action: 'expire', all: true, expire: 'now' });
            } catch (err) {
              caught = err;
            }

            // Assert — git's own fatal line, rebuilt from tsgit's refusal data.
            const data = (caught as TsgitError).data as unknown as Record<string, unknown>;
            expect(data).toEqual({
              code: 'CONFIG_BAD_NUMERIC_VALUE',
              key: 'core.deltabasecachelimit',
              source: path.join(ours, '.git', 'config'),
              value: 'bogus',
              reason: 'invalid unit',
            });
            expect(gitResult.exitCode).toBe(128);
            expect(gitResult.stderr).toBe(
              `fatal: bad numeric config value '${data['value'] as string}' for '${data['key'] as string}' in file ${path.relative(ours, data['source'] as string)}: ${data['reason'] as string}\n`,
            );
            // The named branch log is untouched on both. git reaches the
            // Both sweep in the same order and rewrite each log as they
            // reach it, so both leave `logs/HEAD` emptied — the class is
            // reached on the branch that follows it, whose own log neither
            // tool has touched.
            expect(beforeHead).not.toBe('');
            for (const dir of [peer, ours]) {
              expect(await readFile(mainLogPath(dir), 'utf8')).toBe(beforeMain);
              expect(await readFile(headLogPath(dir), 'utf8')).toBe('');
            }
          });
        });
      });
    });
  },
);
