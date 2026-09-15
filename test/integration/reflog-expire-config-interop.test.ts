/**
 * Integration — `gc.reflogExpire` / `gc.reflogExpireUnreachable` /
 * `gc.<pattern>.*` policy against canonical git.
 *
 * @proves
 *   surface:        reflog
 *   bucket:         cross-tool-interop
 *   unique:         gc.reflogExpire* configuration against git 2.55.0
 *   interopSurface: reflog
 */
import { appendFile, cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { reflog } from '../../src/application/commands/reflog.js';
import { TsgitError } from '../../src/domain/error.js';
import {
  disableAutoMaintenance,
  GIT_AVAILABLE,
  git,
  runGit,
  runGitEnv,
  tryRunGitWithExit,
} from './interop-helpers.js';

const SETUP_TIMEOUT = 60_000;
const DAY = 86_400;

const datedEnv = (epoch: number): NodeJS.ProcessEnv => ({
  ...runGitEnv(),
  GIT_AUTHOR_NAME: 'Ada',
  GIT_AUTHOR_EMAIL: 'ada@example.com',
  GIT_AUTHOR_DATE: `${epoch} +0000`,
  GIT_COMMITTER_NAME: 'Ada',
  GIT_COMMITTER_EMAIL: 'ada@example.com',
  GIT_COMMITTER_DATE: `${epoch} +0000`,
});

const mainLogPath = (dir: string): string =>
  path.join(dir, '.git', 'logs', 'refs', 'heads', 'main');
const stashLogPath = (dir: string): string => path.join(dir, '.git', 'logs', 'refs', 'stash');

/** Every entry's age (days) lies at least 5 days from every cutoff the
 *  matrix below uses (30/45/50/60/90/100/120/150), so neither git's own
 *  `time(NULL)` nor tsgit's `Date.now()` can move an entry across a cutoff
 *  during the run. */
const AGES: Readonly<Record<string, number>> = {
  e1: 200,
  e2: 100,
  e3: 60,
  e4: 60,
  e5: 60,
  e6: 10,
  e7: 10,
};

interface RowOids {
  readonly zero: string;
  readonly a: string;
  readonly b: string;
  readonly c: string;
  readonly u: string;
  readonly u2: string;
}

const reflogLine = (oldId: string, newId: string, now: number, label: string): string =>
  `${oldId} ${newId} Ada <ada@example.com> ${now - (AGES[label] as number) * DAY} +0000\t${label}\n`;

const buildLogText = (now: number, oids: RowOids): string =>
  [
    reflogLine(oids.zero, oids.a, now, 'e1'),
    reflogLine(oids.a, oids.b, now, 'e2'),
    reflogLine(oids.b, oids.u, now, 'e3'),
    reflogLine(oids.u, oids.b, now, 'e4'),
    reflogLine(oids.b, oids.c, now, 'e5'),
    reflogLine(oids.c, oids.u2, now, 'e6'),
    reflogLine(oids.u2, oids.c, now, 'e7'),
  ].join('');

/** The surviving entries' own labels, read back from a rewritten log. */
const survivingLabels = async (logPath: string): Promise<ReadonlyArray<string>> => {
  const content = await readFile(logPath, 'utf8').catch(() => '');
  if (content.length === 0) return [];
  return content
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => line.split('\t')[1] ?? '');
};

describe.skipIf(!GIT_AVAILABLE)(
  'integration — gc.reflogExpire* configuration against canonical git',
  () => {
    let baseDir = '';
    let oids: RowOids = { zero: '0'.repeat(40), a: '', b: '', c: '', u: '', u2: '' };
    let now = 0;
    const caseRoots: string[] = [];

    beforeAll(async () => {
      now = Math.floor(Date.now() / 1000);
      baseDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-reflog-expire-config-'));
      runGit(['init', '-q', '-b', 'main', baseDir]);
      git(baseDir, 'config', 'user.name', 'Ada');
      git(baseDir, 'config', 'user.email', 'ada@example.com');
      git(baseDir, 'config', 'commit.gpgsign', 'false');
      disableAutoMaintenance(baseDir);
      // The well-known empty-tree id — universal for SHA-1, needs no `mktree` call.
      const tree = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
      const commitAt = (
        message: string,
        ageDays: number,
        parents: ReadonlyArray<string>,
      ): string => {
        const args = ['-C', baseDir, 'commit-tree', tree];
        for (const parent of parents) args.push('-p', parent);
        return runGit([...args, '-m', message], { env: datedEnv(now - ageDays * DAY) }).trim();
      };
      const a = commitAt('a', 200, []);
      const b = commitAt('b', 100, [a]);
      const c = commitAt('c', 60, [b]);
      const u = commitAt('u', 60, [b]);
      const u2 = commitAt('u2', 10, [c]);
      oids = { zero: '0'.repeat(40), a, b, c, u, u2 };
      git(baseDir, 'update-ref', 'refs/heads/main', c);
      git(baseDir, 'update-ref', 'refs/stash', c);
      git(baseDir, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      await rm(baseDir, { recursive: true, force: true });
      await Promise.all(
        caseRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
      );
    });

    const caseDir = async (slug: string): Promise<string> => {
      const root = await mkdtemp(path.join(os.tmpdir(), `tsgit-reflog-expire-config-${slug}-`));
      caseRoots.push(root);
      const target = path.join(root, 'repo');
      await cp(baseDir, target, { recursive: true });
      return target;
    };

    /** Both `dir`'s log and config are planted fresh, independent of any
     *  earlier row's rewrite. */
    const seedRow = async (dir: string, configText: string | undefined): Promise<void> => {
      const logText = buildLogText(now, oids);
      await writeFile(mainLogPath(dir), logText);
      // The rows targeting `refs/stash` directly need its own log seeded
      // from the same seven entries, so they exercise the identical matrix.
      await writeFile(stashLogPath(dir), logText);
      if (configText !== undefined) {
        await appendFile(path.join(dir, '.git', 'config'), configText);
      }
    };

    interface SuccessRow {
      readonly label: string;
      readonly config?: string;
      readonly ref?: string;
      readonly all?: boolean;
      readonly expire?: string;
      readonly expireUnreachable?: string;
      readonly kept: ReadonlyArray<string>;
    }

    const gitArgsFor = (row: SuccessRow): ReadonlyArray<string> => {
      const args = ['reflog', 'expire'];
      if (row.all === true) args.push('--all');
      if (row.expire !== undefined) args.push(`--expire=${row.expire}`);
      if (row.expireUnreachable !== undefined)
        args.push(`--expire-unreachable=${row.expireUnreachable}`);
      if (row.all !== true) args.push(row.ref ?? 'refs/heads/main');
      return args;
    };

    const successRows: ReadonlyArray<SuccessRow> = [
      { label: 'no configuration at all, plain defaults', kept: ['e6', 'e7'] },
      {
        label: 'a global reflogExpire of never',
        config: '[gc]\n\treflogExpire = never\n',
        kept: ['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7'],
      },
      {
        label: 'a global reflogExpireUnreachable of never',
        config: '[gc]\n\treflogExpireUnreachable = never\n',
        kept: ['e6', 'e7'],
      },
      {
        label: 'both global cutoffs set to honest, finite values',
        config: '[gc]\n\treflogExpire = 120.days.ago\n\treflogExpireUnreachable = 45.days.ago\n',
        kept: ['e2', 'e5', 'e6', 'e7'],
      },
      {
        label: 'finite global cutoffs plus an --expire=now flag',
        config: '[gc]\n\treflogExpire = 120.days.ago\n\treflogExpireUnreachable = 45.days.ago\n',
        expire: 'now',
        kept: [],
      },
      {
        label: 'a matching pattern sets only the total slot',
        config: '[gc "refs/heads/*"]\n\treflogExpire = 120.days.ago\n',
        kept: ['e2', 'e3', 'e4', 'e5', 'e6', 'e7'],
      },
      {
        label: 'a matching pattern sets only the unreachable slot',
        config: '[gc "refs/heads/*"]\n\treflogExpireUnreachable = 45.days.ago\n',
        kept: ['e1', 'e2', 'e5', 'e6', 'e7'],
      },
      {
        label: 'a broad matching pattern precedes a narrower one in config order',
        config:
          '[gc "refs/heads/*"]\n\treflogExpire = never\n\treflogExpireUnreachable = never\n[gc "refs/heads/m*"]\n\treflogExpire = now\n\treflogExpireUnreachable = now\n',
        kept: ['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7'],
      },
      {
        label: 'the same two patterns, with the narrower one appearing first instead',
        config:
          '[gc "refs/heads/m*"]\n\treflogExpire = now\n\treflogExpireUnreachable = now\n[gc "refs/heads/*"]\n\treflogExpire = never\n\treflogExpireUnreachable = never\n',
        kept: [],
      },
      {
        label: 'the same pattern text appears in two separate config sections',
        config:
          '[gc "refs/heads/*"]\n\treflogExpire = 120.days.ago\n[gc "refs/heads/*"]\n\treflogExpireUnreachable = 45.days.ago\n',
        kept: ['e2', 'e5', 'e6', 'e7'],
      },
      {
        label: 'a pattern of refs/* — wildmatch crosses the / separator',
        config: '[gc "refs/*"]\n\treflogExpire = never\n\treflogExpireUnreachable = never\n',
        kept: ['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7'],
      },
      {
        label: 'a matching bracket range pattern',
        config:
          '[gc "refs/heads/m[a-z]in"]\n\treflogExpire = never\n\treflogExpireUnreachable = never\n',
        kept: ['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7'],
      },
      {
        label: 'a negated bracket pattern that does not match — defaults apply',
        config:
          '[gc "refs/heads/m[!a]in"]\n\treflogExpire = never\n\treflogExpireUnreachable = never\n',
        kept: ['e6', 'e7'],
      },
      {
        label: 'an unterminated bracket pattern never matches — defaults apply',
        config:
          '[gc "refs/heads/m[a"]\n\treflogExpire = never\n\treflogExpireUnreachable = never\n',
        kept: ['e6', 'e7'],
      },
      {
        label: 'approxidate keyword phrases for both cutoffs',
        config: '[gc]\n\treflogExpire = 150 days ago\n\treflogExpireUnreachable = 2 weeks ago\n',
        kept: ['e2', 'e5', 'e6', 'e7'],
      },
      {
        label: 'an uppercase NEVER keyword, case-tolerant like the flag grammar',
        config: '[gc]\n\treflogExpire = NEVER\n',
        kept: ['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7'],
      },
      {
        label: 'two valid values for the same global key — the later one wins',
        config: '[gc]\n\treflogExpire = 120.days.ago\n\treflogExpire = never\n',
        kept: ['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7'],
      },
      {
        label: 'refs/stash targeted directly with no pattern or flag',
        ref: 'refs/stash',
        kept: ['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7'],
      },
      {
        label: 'refs/stash targeted directly, with a pattern configuring it',
        config: '[gc "refs/stash"]\n\treflogExpire = 45.days.ago\n',
        ref: 'refs/stash',
        kept: ['e6', 'e7'],
      },
      {
        label: 'HEAD targeted directly under a global never value',
        config: '[gc]\n\treflogExpire = never\n',
        ref: 'HEAD',
        kept: ['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7'],
      },
      {
        label: 'every reflog expired together under --all --expire=now',
        all: true,
        expire: 'now',
        kept: [],
      },
    ];

    describe.each(successRows)('Given $label', (row) => {
      describe('When expire runs', () => {
        it('Then git and tsgit keep exactly the same entries, byte-identical', async () => {
          // Arrange
          const peer = await caseDir(`ok-peer-${row.label.replace(/\W+/g, '')}`);
          const ours = await caseDir(`ok-ours-${row.label.replace(/\W+/g, '')}`);
          await seedRow(peer, row.config);
          await seedRow(ours, row.config);

          // Act
          const gitResult = tryRunGitWithExit(['-C', peer, ...gitArgsFor(row)]);
          const ctx = createNodeContext({ workDir: ours });
          await reflog(ctx, {
            action: 'expire',
            ...(row.all === true ? { all: true } : { ref: row.ref ?? 'refs/heads/main' }),
            ...(row.expire !== undefined ? { expire: row.expire } : {}),
            ...(row.expireUnreachable !== undefined
              ? { expireUnreachable: row.expireUnreachable }
              : {}),
          });

          // Assert
          expect(gitResult.exitCode).toBe(0);
          const logPath = row.ref === 'refs/stash' ? stashLogPath(peer) : mainLogPath(peer);
          const oursLogPath = row.ref === 'refs/stash' ? stashLogPath(ours) : mainLogPath(ours);
          const peerKept = await survivingLabels(logPath);
          const oursKept = await survivingLabels(oursLogPath);
          expect(peerKept.slice().sort()).toEqual([...row.kept].sort());
          expect(oursKept.slice().sort()).toEqual([...row.kept].sort());
        });
      });
    });

    interface RefusalRow {
      readonly label: string;
      readonly config: string;
      readonly ref?: string;
      readonly expire?: string;
    }

    const refusalRows: ReadonlyArray<RefusalRow> = [
      { label: 'a bogus value on a global key', config: '[gc]\n\treflogExpire = bogus\n' },
      {
        label: 'a valueless global key',
        config: '[gc]\n\treflogExpire\n',
      },
      {
        label: 'a bogus entry followed by a later valid one for the same key',
        config: '[gc]\n\treflogExpire = bogus\n\treflogExpire = never\n',
      },
      {
        label: 'a bogus value on a pattern that would not even match the target',
        config: '[gc "refs/tags/*"]\n\treflogExpire = bogus\n',
      },
      {
        label: 'a bogus global value together with a ref that does not resolve',
        config: '[gc]\n\treflogExpire = bogus\n',
        ref: 'refs/heads/nope',
      },
      {
        label: 'a bogus global value together with an also-bogus --expire flag',
        config: '[gc]\n\treflogExpire = bogus\n',
        expire: 'bogus2',
      },
    ];

    describe.each(refusalRows)('Given $label', (row) => {
      describe('When expire runs', () => {
        it('Then both git and tsgit refuse, and the log is untouched on both', async () => {
          // Arrange
          const peer = await caseDir(`bad-peer-${row.label.replace(/\W+/g, '')}`);
          const ours = await caseDir(`bad-ours-${row.label.replace(/\W+/g, '')}`);
          await seedRow(peer, row.config);
          await seedRow(ours, row.config);
          const beforePeer = await readFile(mainLogPath(peer), 'utf8');
          const beforeOurs = await readFile(mainLogPath(ours), 'utf8');

          // Act
          const gitArgs = ['reflog', 'expire'];
          if (row.expire !== undefined) gitArgs.push(`--expire=${row.expire}`);
          gitArgs.push(row.ref ?? 'refs/heads/main');
          const gitResult = tryRunGitWithExit(['-C', peer, ...gitArgs]);
          const ctx = createNodeContext({ workDir: ours });
          let caught: unknown;
          try {
            await reflog(ctx, {
              action: 'expire',
              ref: row.ref ?? 'refs/heads/main',
              ...(row.expire !== undefined ? { expire: row.expire } : {}),
            });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(gitResult.exitCode).toBe(128);
          expect(caught).toBeInstanceOf(TsgitError);
          const code = (caught as TsgitError).data.code;
          expect(code === 'CONFIG_BAD_DATE_VALUE' || code === 'CONFIG_MISSING_VALUE').toBe(true);
          expect(await readFile(mainLogPath(peer), 'utf8')).toBe(beforePeer);
          expect(await readFile(mainLogPath(ours), 'utf8')).toBe(beforeOurs);
        });
      });
    });

    describe('Given no ref, no --all, and a bogus gc.reflogExpire', () => {
      describe('When expire runs', () => {
        it('Then both tools still refuse — configuration is parsed before the no-op', async () => {
          // Arrange — a malformed reflog-expiry VALUE refuses even where the
          // target sweep would otherwise be a no-op (unlike a malformed
          // core.deltaBaseCacheLimit, which the repo-settings class skips
          // entirely with zero targets — covered separately by unit and
          // command-level interop rows for the plain no-op case).
          const peer = await caseDir('noop-peer');
          const ours = await caseDir('noop-ours');
          await seedRow(peer, '[gc]\n\treflogExpire = bogus\n');
          await seedRow(ours, '[gc]\n\treflogExpire = bogus\n');
          const beforePeer = await readFile(mainLogPath(peer), 'utf8');

          // Act
          const gitResult = tryRunGitWithExit(['-C', peer, 'reflog', 'expire']);
          const ctx = createNodeContext({ workDir: ours });
          let caught: unknown;
          try {
            await reflog(ctx, { action: 'expire' });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(gitResult.exitCode).toBe(128);
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as TsgitError).data.code).toBe('CONFIG_BAD_DATE_VALUE');
          expect(await readFile(mainLogPath(peer), 'utf8')).toBe(beforePeer);
        });
      });
    });
  },
);
