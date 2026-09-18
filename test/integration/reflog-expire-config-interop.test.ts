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
import { appendFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { reflog } from '../../src/application/commands/reflog.js';
import { status } from '../../src/application/commands/status.js';
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

/** One clock for the whole file, read at module load so a row's own config
 *  text can quote an absolute `@<epoch>` cutoff that still lines up with the
 *  ages `beforeAll` stamps into the fixture. */
const NOW = Math.floor(Date.now() / 1_000);

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
const headLogPath = (dir: string): string => path.join(dir, '.git', 'logs', 'HEAD');
const configPath = (dir: string): string => path.join(dir, '.git', 'config');

/** The three seeded logs, so a row can assert on the one it targets AND that
 *  the other two were never touched. */
const ALL_LOGS: ReadonlyArray<(dir: string) => string> = [mainLogPath, stashLogPath, headLogPath];

/** The log `ref` names — the single place the target-to-file mapping lives,
 *  so a row that targets `HEAD` or `refs/stash` can never silently assert
 *  against `main`'s log instead. */
const logPathFor = (dir: string, ref: string): string => {
  if (ref === 'refs/stash') return stashLogPath(dir);
  if (ref === 'HEAD') return headLogPath(dir);
  return mainLogPath(dir);
};

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

const reflogLine = (oldId: string, newId: string, label: string): string =>
  `${oldId} ${newId} Ada <ada@example.com> ${NOW - (AGES[label] as number) * DAY} +0000\t${label}\n`;

const buildLogText = (oids: RowOids): string =>
  [
    reflogLine(oids.zero, oids.a, 'e1'),
    reflogLine(oids.a, oids.b, 'e2'),
    reflogLine(oids.b, oids.u, 'e3'),
    reflogLine(oids.u, oids.b, 'e4'),
    reflogLine(oids.b, oids.c, 'e5'),
    reflogLine(oids.c, oids.u2, 'e6'),
    reflogLine(oids.u2, oids.c, 'e7'),
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
    const caseRoots: string[] = [];

    beforeAll(async () => {
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
        return runGit([...args, '-m', message], { env: datedEnv(NOW - ageDays * DAY) }).trim();
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
      const logText = buildLogText(oids);
      // All three logs carry the identical seven entries, so a row targeting
      // `refs/stash` or `HEAD` exercises the same matrix as a `main` row —
      // and a row that expires one of them proves the other two untouched.
      await Promise.all(ALL_LOGS.map((logPath) => writeFile(logPath(dir), logText)));
      if (configText !== undefined) {
        await appendFile(configPath(dir), configText);
      }
    };

    /** Every seeded log's bytes, in a fixed order, for the untouched-log
     *  assertions both row tables make. */
    const readAllLogs = async (dir: string): Promise<ReadonlyArray<Buffer>> =>
      Promise.all(ALL_LOGS.map((logPath) => readFile(logPath(dir))));

    interface SuccessRow {
      readonly label: string;
      readonly config?: string;
      /** The ref both tools are pointed at; `refs/heads/main` when absent. */
      readonly ref?: string;
      /** No ref argument and no `--all` — the sweep has no target at all. */
      readonly noRef?: boolean;
      readonly all?: boolean;
      readonly expire?: string;
      readonly expireUnreachable?: string;
      readonly kept: ReadonlyArray<string>;
    }

    const targetOf = (row: SuccessRow): string => row.ref ?? 'refs/heads/main';

    const gitArgsFor = (row: SuccessRow): ReadonlyArray<string> => {
      const args = ['reflog', 'expire'];
      if (row.all === true) args.push('--all');
      if (row.expire !== undefined) args.push(`--expire=${row.expire}`);
      if (row.expireUnreachable !== undefined)
        args.push(`--expire-unreachable=${row.expireUnreachable}`);
      if (row.all !== true && row.noRef !== true) args.push(targetOf(row));
      return args;
    };

    /** The `--all` / single-ref / no-target choice, shared by both tools. */
    const targetOptionFor = (row: SuccessRow): { readonly all?: true; readonly ref?: string } => {
      if (row.all === true) return { all: true };
      if (row.noRef === true) return {};
      return { ref: targetOf(row) };
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
        label: 'both global keys spelled entirely in lower case, holding never',
        config: '[gc]\n\treflogexpire = never\n\treflogexpireunreachable = never\n',
        kept: ['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7'],
      },
      {
        label: 'both global keys spelled entirely in lower case, holding finite cutoffs',
        config: '[gc]\n\treflogexpire = 120.days.ago\n\treflogexpireunreachable = 45.days.ago\n',
        kept: ['e2', 'e5', 'e6', 'e7'],
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
        label: 'refs/stash targeted directly under finite global cutoffs',
        config: '[gc]\n\treflogExpire = 45.days.ago\n\treflogExpireUnreachable = 15.days.ago\n',
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
        label: 'refs/stash targeted directly with an explicit --expire flag',
        ref: 'refs/stash',
        expire: '45.days.ago',
        kept: ['e6', 'e7'],
      },
      {
        label: 'HEAD targeted directly under a global never value',
        config: '[gc]\n\treflogExpire = never\n',
        ref: 'HEAD',
        kept: ['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7'],
      },
      {
        label: 'HEAD targeted directly with no configuration at all',
        ref: 'HEAD',
        kept: ['e6', 'e7'],
      },
      {
        label: 'HEAD targeted directly, with a pattern naming HEAD itself',
        config: '[gc "HEAD"]\n\treflogExpire = never\n\treflogExpireUnreachable = never\n',
        ref: 'HEAD',
        kept: ['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7'],
      },
      {
        label: 'every reflog expired together under --all --expire=now',
        all: true,
        expire: 'now',
        kept: [],
      },
      {
        label: 'the branch short name as the argument, plain defaults',
        ref: 'main',
        kept: ['e6', 'e7'],
      },
      {
        label: 'no ref argument and no --all, so the sweep has no target',
        noRef: true,
        kept: ['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7'],
      },
      {
        label: 'both global cutoffs set tighter than every surviving entry but two',
        config: '[gc]\n\treflogExpire = 45.days.ago\n\treflogExpireUnreachable = 15.days.ago\n',
        kept: ['e6', 'e7'],
      },
      {
        label: 'finite global cutoffs plus an --expire=never flag',
        config: '[gc]\n\treflogExpire = 120.days.ago\n\treflogExpireUnreachable = 45.days.ago\n',
        expire: 'never',
        kept: ['e1', 'e2', 'e5', 'e6', 'e7'],
      },
      {
        label: 'finite global cutoffs plus an --expire-unreachable=never flag',
        config: '[gc]\n\treflogExpire = 120.days.ago\n\treflogExpireUnreachable = 45.days.ago\n',
        expireUnreachable: 'never',
        kept: ['e2', 'e3', 'e4', 'e5', 'e6', 'e7'],
      },
      {
        label: 'finite global cutoffs overridden by both flags at once',
        config: '[gc]\n\treflogExpire = 120.days.ago\n\treflogExpireUnreachable = 45.days.ago\n',
        expire: '150.days.ago',
        expireUnreachable: '5.days.ago',
        kept: ['e2', 'e5'],
      },
      {
        label: 'a matching pattern setting both slots at once',
        config:
          '[gc "refs/heads/*"]\n\treflogExpire = 120.days.ago\n\treflogExpireUnreachable = 45.days.ago\n',
        kept: ['e2', 'e5', 'e6', 'e7'],
      },
      {
        label: 'global cutoffs first, then a matching pattern that sets only one slot',
        config:
          '[gc]\n\treflogExpire = 120.days.ago\n\treflogExpireUnreachable = 45.days.ago\n[gc "refs/heads/*"]\n\treflogExpire = never\n',
        kept: ['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7'],
      },
      {
        label: 'the same matching pattern first, with the global cutoffs after it',
        config:
          '[gc "refs/heads/*"]\n\treflogExpire = never\n[gc]\n\treflogExpire = 120.days.ago\n\treflogExpireUnreachable = 45.days.ago\n',
        kept: ['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7'],
      },
      {
        label: 'a pattern under refs/tags that cannot match a branch — defaults apply',
        config: '[gc "refs/tags/*"]\n\treflogExpire = never\n\treflogExpireUnreachable = never\n',
        kept: ['e6', 'e7'],
      },
      {
        label: 'a pattern spelling the full refname with no wildcard at all',
        config:
          '[gc "refs/heads/main"]\n\treflogExpire = never\n\treflogExpireUnreachable = never\n',
        kept: ['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7'],
      },
      {
        label: 'a pattern spelling only the short name, which the full refname never matches',
        config: '[gc "main"]\n\treflogExpire = never\n\treflogExpireUnreachable = never\n',
        kept: ['e6', 'e7'],
      },
      {
        label: 'a pattern of refs/** — the double star is no wider than a single one',
        config: '[gc "refs/**"]\n\treflogExpire = never\n\treflogExpireUnreachable = never\n',
        kept: ['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7'],
      },
      {
        label: 'the false keyword standing in for never on both cutoffs',
        config: '[gc]\n\treflogExpire = false\n\treflogExpireUnreachable = false\n',
        kept: ['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7'],
      },
      {
        label: 'the now keyword on the total cutoff',
        config: '[gc]\n\treflogExpire = now\n',
        kept: [],
      },
      {
        label: 'the all keyword on the unreachable cutoff',
        config: '[gc]\n\treflogExpireUnreachable = all\n',
        kept: [],
      },
      {
        label: 'raw @-prefixed epoch seconds for both cutoffs',
        config: `[gc]\n\treflogExpire = @${NOW - 50 * DAY}\n\treflogExpireUnreachable = @${NOW - 5 * DAY}\n`,
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
            ...targetOptionFor(row),
            ...(row.expire !== undefined ? { expire: row.expire } : {}),
            ...(row.expireUnreachable !== undefined
              ? { expireUnreachable: row.expireUnreachable }
              : {}),
          });

          // Assert — the peer's own surviving entries are the declared
          // outcome, and every seeded log matches the peer's byte for byte,
          // so the two logs this row did NOT target are proven untouched too.
          expect(gitResult.exitCode).toBe(0);
          expect(await survivingLabels(logPathFor(peer, targetOf(row)))).toEqual([...row.kept]);
          expect(await readAllLogs(ours)).toEqual(await readAllLogs(peer));
        });
      });
    });

    interface RefusalRow {
      readonly label: string;
      readonly config: string;
      readonly ref?: string;
      /** No ref argument and no `--all` — the sweep would otherwise be a no-op. */
      readonly noRef?: boolean;
      readonly expire?: string;
      readonly expireUnreachable?: string;
      /** The one refusal this row must produce — never a disjunction. */
      readonly code: 'CONFIG_BAD_DATE_VALUE' | 'CONFIG_MISSING_VALUE';
      /** Fully-qualified key, lower-cased with the subsection kept verbatim. */
      readonly key: string;
      /** The offending raw value; absent for a present-but-valueless key. */
      readonly value?: string;
      /** The config line that must be blamed, matched verbatim against the
       *  seeded file — the line NUMBER is read off the file, never restated,
       *  so the "first bad line, not last-wins" rows differ by construction. */
      readonly culprit: string;
    }

    const refusalRows: ReadonlyArray<RefusalRow> = [
      {
        label: 'a bogus value on a global key',
        config: '[gc]\n\treflogExpire = bogus\n',
        code: 'CONFIG_BAD_DATE_VALUE',
        key: 'gc.reflogexpire',
        value: 'bogus',
        culprit: '\treflogExpire = bogus',
      },
      {
        label: 'a valueless global key',
        config: '[gc]\n\treflogExpire\n',
        code: 'CONFIG_MISSING_VALUE',
        key: 'gc.reflogexpire',
        culprit: '\treflogExpire',
      },
      {
        label: 'a global key whose value is present but empty',
        config: '[gc]\n\treflogExpire =\n',
        code: 'CONFIG_BAD_DATE_VALUE',
        key: 'gc.reflogexpire',
        value: '',
        culprit: '\treflogExpire =',
      },
      {
        label: 'a bogus entry followed by a later valid one for the same key',
        config: '[gc]\n\treflogExpire = bogus\n\treflogExpire = never\n',
        code: 'CONFIG_BAD_DATE_VALUE',
        key: 'gc.reflogexpire',
        value: 'bogus',
        culprit: '\treflogExpire = bogus',
      },
      {
        label: 'a valid entry followed by a bogus one for the same key',
        config: '[gc]\n\treflogExpire = never\n\treflogExpire = bogus\n',
        code: 'CONFIG_BAD_DATE_VALUE',
        key: 'gc.reflogexpire',
        value: 'bogus',
        culprit: '\treflogExpire = bogus',
      },
      {
        label: 'a bogus value on a pattern that would not even match the target',
        config: '[gc "refs/tags/*"]\n\treflogExpire = bogus\n',
        code: 'CONFIG_BAD_DATE_VALUE',
        key: 'gc.refs/tags/*.reflogexpire',
        value: 'bogus',
        culprit: '\treflogExpire = bogus',
      },
      {
        label: 'a bogus global value together with a ref that does not resolve',
        config: '[gc]\n\treflogExpire = bogus\n',
        ref: 'refs/heads/nope',
        code: 'CONFIG_BAD_DATE_VALUE',
        key: 'gc.reflogexpire',
        value: 'bogus',
        culprit: '\treflogExpire = bogus',
      },
      {
        label: 'a bogus global value together with an also-bogus --expire flag',
        config: '[gc]\n\treflogExpire = bogus\n',
        expire: 'bogus2',
        code: 'CONFIG_BAD_DATE_VALUE',
        key: 'gc.reflogexpire',
        value: 'bogus',
        culprit: '\treflogExpire = bogus',
      },
      {
        label: 'a bogus global value while both cutoff flags are given explicitly',
        config: '[gc]\n\treflogExpire = bogus\n',
        expire: 'now',
        expireUnreachable: 'now',
        code: 'CONFIG_BAD_DATE_VALUE',
        key: 'gc.reflogexpire',
        value: 'bogus',
        culprit: '\treflogExpire = bogus',
      },
      {
        label: 'a bogus global value with a malformed core key after it',
        config: '[gc]\n\treflogExpire = bogus\n[core]\n\tdeltaBaseCacheLimit = bogus\n',
        code: 'CONFIG_BAD_DATE_VALUE',
        key: 'gc.reflogexpire',
        value: 'bogus',
        culprit: '\treflogExpire = bogus',
      },
      {
        label: 'the same two malformed keys with the core one written first',
        config: '[core]\n\tdeltaBaseCacheLimit = bogus\n[gc]\n\treflogExpire = bogus\n',
        code: 'CONFIG_BAD_DATE_VALUE',
        key: 'gc.reflogexpire',
        value: 'bogus',
        culprit: '\treflogExpire = bogus',
      },
      {
        label: 'a bogus global value with no ref argument and no --all',
        // A malformed reflog-expiry VALUE refuses even where the target sweep
        // would otherwise be a no-op — unlike a malformed
        // `core.deltaBaseCacheLimit`, which the repo-settings class skips
        // entirely with zero targets.
        config: '[gc]\n\treflogExpire = bogus\n',
        noRef: true,
        code: 'CONFIG_BAD_DATE_VALUE',
        key: 'gc.reflogexpire',
        value: 'bogus',
        culprit: '\treflogExpire = bogus',
      },
    ];

    /** The 1-based line `culprit` occupies in `dir`'s config — and proof it
     *  occupies exactly one, so the number is the file's answer, not a guess. */
    const culpritLineIn = async (dir: string, culprit: string): Promise<number> => {
      const lines = (await readFile(configPath(dir), 'utf8')).split('\n');
      expect(lines.indexOf(culprit)).toBe(lines.lastIndexOf(culprit));
      expect(lines.indexOf(culprit)).toBeGreaterThanOrEqual(0);
      return lines.indexOf(culprit) + 1;
    };

    /** git's own two refusal lines, rebuilt from tsgit's structured refusal
     *  data alone — the library never renders them, so this is the only place
     *  the two tools' messages can be compared. */
    const gitRefusalText = (
      data: Record<string, unknown>,
      repoDir: string,
      code: RefusalRow['code'],
    ): string => {
      const key = data['key'] as string;
      const first =
        code === 'CONFIG_MISSING_VALUE'
          ? `error: missing value for '${key}'`
          : `error: '${data['value'] as string}' for '${key}' is not a valid timestamp`;
      const source = path.relative(repoDir, data['source'] as string);
      return `${first}\nfatal: bad config variable '${key}' in file '${source}' at line ${data['line'] as number}\n`;
    };

    describe.each(refusalRows)('Given $label', (row) => {
      describe('When expire runs', () => {
        it('Then both tools name the same key, value and line, and write nothing', async () => {
          // Arrange
          const peer = await caseDir(`bad-peer-${row.label.replace(/\W+/g, '')}`);
          const ours = await caseDir(`bad-ours-${row.label.replace(/\W+/g, '')}`);
          await seedRow(peer, row.config);
          await seedRow(ours, row.config);
          const beforePeer = await readAllLogs(peer);
          const beforeOurs = await readAllLogs(ours);

          // Act
          const gitArgs = ['reflog', 'expire'];
          if (row.expire !== undefined) gitArgs.push(`--expire=${row.expire}`);
          if (row.expireUnreachable !== undefined)
            gitArgs.push(`--expire-unreachable=${row.expireUnreachable}`);
          if (row.noRef !== true) gitArgs.push(row.ref ?? 'refs/heads/main');
          const gitResult = tryRunGitWithExit(['-C', peer, ...gitArgs]);
          const ctx = createNodeContext({ workDir: ours });
          let caught: unknown;
          try {
            await reflog(ctx, {
              action: 'expire',
              ...(row.noRef === true ? {} : { ref: row.ref ?? 'refs/heads/main' }),
              ...(row.expire !== undefined ? { expire: row.expire } : {}),
              ...(row.expireUnreachable !== undefined
                ? { expireUnreachable: row.expireUnreachable }
                : {}),
            });
          } catch (err) {
            caught = err;
          }

          // Assert — the exact refusal, located; then git's own two stderr
          // lines rebuilt from that refusal data and matched against git's.
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data as unknown as Record<string, unknown>;
          expect(data).toEqual({
            code: row.code,
            key: row.key,
            source: configPath(ours),
            line: await culpritLineIn(ours, row.culprit),
            ...(row.value !== undefined ? { value: row.value } : {}),
          });
          expect(gitResult.exitCode).toBe(128);
          expect(gitResult.stderr).toBe(gitRefusalText(data, ours, row.code));
          expect(await readAllLogs(peer)).toEqual(beforePeer);
          expect(await readAllLogs(ours)).toEqual(beforeOurs);
        });
      });
    });

    describe('Given a bogus reflog-expiry value and a verb that never reads it', () => {
      const BOGUS = '[gc]\n\treflogExpire = bogus\n';

      const unaffectedVerbs: ReadonlyArray<{
        readonly label: string;
        readonly gitArgs: ReadonlyArray<string>;
        readonly run: (dir: string) => Promise<unknown>;
      }> = [
        {
          label: 'reflog show',
          gitArgs: ['reflog', 'show', 'HEAD'],
          run: (dir) =>
            reflog(createNodeContext({ workDir: dir }), { action: 'show', ref: 'HEAD' }),
        },
        {
          label: 'reflog delete',
          gitArgs: ['reflog', 'delete', 'HEAD@{0}'],
          run: (dir) =>
            reflog(createNodeContext({ workDir: dir }), {
              action: 'delete',
              ref: 'HEAD',
              index: 0,
            }),
        },
        {
          label: 'reflog exists',
          gitArgs: ['reflog', 'exists', 'HEAD'],
          run: (dir) =>
            reflog(createNodeContext({ workDir: dir }), { action: 'exists', ref: 'HEAD' }),
        },
        {
          label: 'status',
          gitArgs: ['status', '--porcelain'],
          run: (dir) => status(createNodeContext({ workDir: dir })),
        },
      ];

      describe.each(unaffectedVerbs)('When $label runs', (verb) => {
        it('Then neither tool refuses — only expire reads the reflog-expiry keys', async () => {
          // Arrange
          const peer = await caseDir(`unread-peer-${verb.label.replace(/\W+/g, '')}`);
          const ours = await caseDir(`unread-ours-${verb.label.replace(/\W+/g, '')}`);
          await seedRow(peer, BOGUS);
          await seedRow(ours, BOGUS);

          // Act
          const gitResult = tryRunGitWithExit(['-C', peer, ...verb.gitArgs]);
          const outcome = await verb.run(ours).then(
            () => 'resolved',
            (err: unknown) => (err as TsgitError).data.code,
          );

          // Assert
          expect(gitResult.exitCode).toBe(0);
          expect(outcome).toBe('resolved');
        });
      });
    });

    describe('Given a clean configuration and a cutoff flag nothing parses', () => {
      describe('When expire runs', () => {
        it('Then both refuse on the flag and leave every log untouched', async () => {
          // Arrange
          const peer = await caseDir('flag-bogus-peer');
          const ours = await caseDir('flag-bogus-ours');
          await seedRow(peer, undefined);
          await seedRow(ours, undefined);
          const before = await readAllLogs(ours);

          // Act
          const gitResult = tryRunGitWithExit([
            '-C',
            peer,
            'reflog',
            'expire',
            '--expire=bogus',
            'HEAD',
          ]);
          let caught: unknown;
          try {
            await reflog(createNodeContext({ workDir: ours }), {
              action: 'expire',
              ref: 'HEAD',
              expire: 'bogus',
            });
          } catch (err) {
            caught = err;
          }

          // Assert — git blames the flag by name; tsgit reports the same
          // unparseable expression through its revision-resolution refusal.
          expect(gitResult.exitCode).toBe(128);
          expect(gitResult.stderr).toBe("fatal: invalid timestamp 'bogus' given to '--expire'\n");
          expect((caught as TsgitError).data).toEqual({
            code: 'REVPARSE_UNRESOLVED',
            expression: 'bogus',
          });
          expect(await readAllLogs(peer)).toEqual(before);
          expect(await readAllLogs(ours)).toEqual(before);
        });
      });
    });

    describe('Given --all asked for alongside a named ref', () => {
      describe('When expire runs', () => {
        it('Then both sweep every log, the named one included, byte-identical', async () => {
          // Arrange
          const peer = await caseDir('all-plus-ref-peer');
          const ours = await caseDir('all-plus-ref-ours');
          await seedRow(peer, undefined);
          await seedRow(ours, undefined);

          // Act
          const gitResult = tryRunGitWithExit([
            '-C',
            peer,
            'reflog',
            'expire',
            '--all',
            '--expire=now',
            'HEAD',
          ]);
          await reflog(createNodeContext({ workDir: ours }), {
            action: 'expire',
            all: true,
            ref: 'HEAD',
            expire: 'now',
          });

          // Assert
          expect(gitResult.exitCode).toBe(0);
          expect(await survivingLabels(headLogPath(peer))).toEqual([]);
          expect(await survivingLabels(mainLogPath(peer))).toEqual([]);
          expect(await readAllLogs(ours)).toEqual(await readAllLogs(peer));
        });
      });
    });

    describe('Given the cutoffs set in the global scope rather than the repository', () => {
      describe('When expire runs', () => {
        it('Then git honours them and tsgit keeps reading the repository config alone', async () => {
          // Arrange — the same file is offered to both tools: git through
          // its global-config override, tsgit through the home directory its
          // layout resolves. tsgit reads these keys from the repository
          // config only, so the two answers differ by scope, not by grammar.
          const peer = await caseDir('global-scope-peer');
          const ours = await caseDir('global-scope-ours');
          await seedRow(peer, undefined);
          await seedRow(ours, undefined);
          const home = path.join(path.dirname(ours), 'home');
          await mkdir(home, { recursive: true });
          await writeFile(
            path.join(home, '.gitconfig'),
            '[gc]\n\treflogExpire = never\n\treflogExpireUnreachable = never\n',
          );
          const previousHome = process.env['HOME'];
          process.env['HOME'] = home;
          const ctx = createNodeContext({ workDir: ours });
          process.env['HOME'] = previousHome;

          // Act
          const gitResult = tryRunGitWithExit(['-C', peer, 'reflog', 'expire', 'refs/heads/main'], {
            env: { ...runGitEnv(), GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig') },
          });
          await reflog(ctx, { action: 'expire', ref: 'refs/heads/main' });

          // Assert
          expect(gitResult.exitCode).toBe(0);
          expect(await survivingLabels(mainLogPath(peer))).toEqual([
            'e1',
            'e2',
            'e3',
            'e4',
            'e5',
            'e6',
            'e7',
          ]);
          expect(await survivingLabels(mainLogPath(ours))).toEqual(['e6', 'e7']);
        });
      });
    });
  },
);
