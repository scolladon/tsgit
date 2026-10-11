/**
 * The upstream `branch.create` records for the new branch: git's
 * `setup_tracking` writes `branch.<name>.remote` / `.merge` (and `.rebase`)
 * from the start point, the `--track` mode and `branch.autoSetupMerge` /
 * `branch.autoSetupRebase`, and reports it as `upstream` on the result.
 */
import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import {
  type BranchCreateInput,
  branchCreate,
} from '../../../../src/application/commands/branch.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import { updateRef } from '../../../../src/application/primitives/update-ref.js';
import { writeSymbolicRef } from '../../../../src/application/primitives/write-symbolic-ref.js';
import type { TsgitError } from '../../../../src/domain/error.js';
import type { AuthorIdentity, ObjectId, RefName } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';

const AUTHOR: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

const ORIGIN = [
  '[remote "origin"]',
  '\turl = /up',
  '\tfetch = +refs/heads/*:refs/remotes/origin/*',
  '[branch "main"]',
  '\tremote = origin',
  '\tmerge = refs/heads/main',
  '',
].join('\n');

/** One logged line: the constant message, the variable parts in its context. */
interface LogRecord {
  readonly message: string;
  readonly context: Readonly<Record<string, unknown>> | undefined;
}

interface Seeded {
  readonly ctx: Context;
  readonly warnings: LogRecord[];
  readonly head: string;
}

const seed = async (extraConfig = ''): Promise<Seeded> => {
  const warnings: LogRecord[] = [];
  const base = createMemoryContext();
  const warn = (message: string, context?: Readonly<Record<string, unknown>>) =>
    warnings.push({ message, context });
  const ctx: Context = { ...base, logger: { warn } };
  await init(ctx);
  await writeSymbolicRef(ctx, 'HEAD' as RefName, 'refs/heads/main' as RefName);
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
  await add(ctx, ['a.txt']);
  const head = await commit(ctx, { message: 'first', author: AUTHOR });
  const reflogMessage = 'plant';
  await updateRef(ctx, 'refs/remotes/origin/main' as RefName, head.id, { reflogMessage });
  await updateRef(ctx, 'refs/remotes/origin/z' as RefName, head.id, { reflogMessage });
  await updateRef(ctx, 'refs/remotes/other/x' as RefName, head.id, { reflogMessage });
  await updateRef(ctx, 'refs/tags/t' as RefName, head.id, { reflogMessage });
  const configPath = `${ctx.layout.gitDir}/config`;
  const config = await ctx.fs.readUtf8(configPath);
  await ctx.fs.writeUtf8(configPath, `${config}${ORIGIN}${extraConfig}`);
  return { ctx, warnings, head: head.id };
};

const branchSection = async (ctx: Context, name: string): Promise<string | undefined> => {
  const config = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/config`);
  const header = `[branch "${name}"]\n`;
  const at = config.indexOf(header);
  if (at < 0) return undefined;
  const next = config.indexOf('\n[', at + header.length);
  return config.slice(at, next < 0 ? undefined : next + 1);
};

const refusalOf = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    await run();
  } catch (err) {
    return (err as TsgitError).data;
  }
  return undefined;
};

const ORIGIN_MAIN = { remote: 'origin', merges: ['refs/heads/main'], rebase: false };
const LOCAL_MAIN = { remote: '.', merges: ['refs/heads/main'], rebase: false };
const SECOND_MAIN_MERGE = '[branch "main"]\n\tmerge = refs/heads/z\n';
const MAIN_EXCLUDED = '[remote "origin"]\n\tfetch = ^refs/heads/main\n';
const ORIGIN_SECTION = '[branch "z"]\n\tremote = origin\n\tmerge = refs/heads/main\n';
const LOCAL_SECTION = '[branch "z"]\n\tremote = .\n\tmerge = refs/heads/main\n';

const OTHER_REMOTE_HEAD = '[remote "o2"]\n\turl = /up\n';
const OTHER_REMOTE_WILDCARD = '\tfetch = +refs/heads/*:refs/remotes/other/*\n';
const O2_X = { remote: 'o2', merges: ['refs/heads/x'], rebase: false };
const O2_SECTION = '[branch "z"]\n\tremote = o2\n\tmerge = refs/heads/x\n';

interface TrackingRow {
  readonly label: string;
  readonly config: string;
  readonly input: Omit<BranchCreateInput, 'name'>;
  readonly upstream: unknown;
  readonly section: string | undefined;
}

const ROWS: ReadonlyArray<TrackingRow> = [
  {
    label: 'a remote-tracking start by default',
    config: '',
    input: { startPoint: 'origin/main' },
    upstream: ORIGIN_MAIN,
    section: ORIGIN_SECTION,
  },
  {
    label: 'a local start by default',
    config: '',
    input: { startPoint: 'main' },
    upstream: undefined,
    section: undefined,
  },
  {
    label: 'a local start with --track',
    config: '',
    input: { startPoint: 'main', track: 'direct' },
    upstream: LOCAL_MAIN,
    section: LOCAL_SECTION,
  },
  {
    label: 'an omitted start with --track',
    config: '',
    input: { track: 'direct' },
    upstream: LOCAL_MAIN,
    section: LOCAL_SECTION,
  },
  {
    label: 'a remote-tracking start with --no-track',
    config: '',
    input: { startPoint: 'origin/main', noTrack: true },
    upstream: undefined,
    section: undefined,
  },
  {
    label: 'a local start with --track=inherit',
    config: '',
    input: { startPoint: 'main', track: 'inherit' },
    upstream: ORIGIN_MAIN,
    section: ORIGIN_SECTION,
  },
  {
    label: 'a local start under autoSetupMerge=always',
    config: '[branch]\n\tautoSetupMerge = always\n',
    input: { startPoint: 'main' },
    upstream: LOCAL_MAIN,
    section: LOCAL_SECTION,
  },
  {
    label: 'a local start under autoSetupMerge=inherit',
    config: '[branch]\n\tautoSetupMerge = inherit\n',
    input: { startPoint: 'main' },
    upstream: ORIGIN_MAIN,
    section: ORIGIN_SECTION,
  },
  {
    label: 'a differently named remote start under autoSetupMerge=simple',
    config: '[branch]\n\tautoSetupMerge = simple\n',
    input: { startPoint: 'origin/main' },
    upstream: undefined,
    section: undefined,
  },
  {
    label: 'a same-named remote start under autoSetupMerge=simple',
    config: '[branch]\n\tautoSetupMerge = simple\n',
    input: { startPoint: 'origin/z' },
    upstream: { remote: 'origin', merges: ['refs/heads/z'], rebase: false },
    section: '[branch "z"]\n\tremote = origin\n\tmerge = refs/heads/z\n',
  },
  {
    label: 'a remote start under autoSetupMerge=false',
    config: '[branch]\n\tautoSetupMerge = false\n',
    input: { startPoint: 'origin/main' },
    upstream: undefined,
    section: undefined,
  },
  {
    label: 'a remote start with --track under autoSetupMerge=false',
    config: '[branch]\n\tautoSetupMerge = false\n',
    input: { startPoint: 'origin/main', track: 'direct' },
    upstream: ORIGIN_MAIN,
    section: ORIGIN_SECTION,
  },
  {
    label: 'a remote start under autoSetupRebase=always',
    config: '[branch]\n\tautoSetupRebase = always\n',
    input: { startPoint: 'origin/main' },
    upstream: { ...ORIGIN_MAIN, rebase: true },
    section: `${ORIGIN_SECTION}\trebase = true\n`,
  },
  {
    label: 'a local start with --track under autoSetupRebase=local',
    config: '[branch]\n\tautoSetupRebase = local\n',
    input: { startPoint: 'main', track: 'direct' },
    upstream: { ...LOCAL_MAIN, rebase: true },
    section: `${LOCAL_SECTION}\trebase = true\n`,
  },
  {
    label: 'a remote start under autoSetupRebase=local',
    config: '[branch]\n\tautoSetupRebase = local\n',
    input: { startPoint: 'origin/main' },
    upstream: ORIGIN_MAIN,
    section: ORIGIN_SECTION,
  },
  {
    label: 'a remote start under autoSetupRebase=remote',
    config: '[branch]\n\tautoSetupRebase = remote\n',
    input: { startPoint: 'origin/main' },
    upstream: { ...ORIGIN_MAIN, rebase: true },
    section: `${ORIGIN_SECTION}\trebase = true\n`,
  },
  {
    label: 'a remote-tracking ref no remote fetches into',
    config: '',
    input: { startPoint: 'other/x' },
    upstream: undefined,
    section: undefined,
  },
  {
    label: 'a tag start by default',
    config: '',
    input: { startPoint: 't' },
    upstream: undefined,
    section: undefined,
  },
  {
    label: 'a revision expression start by default',
    config: '',
    input: { startPoint: 'HEAD~0' },
    upstream: undefined,
    section: undefined,
  },
  {
    label: 'a remote expression start by default',
    config: '',
    input: { startPoint: 'origin/main~0' },
    upstream: undefined,
    section: undefined,
  },
  {
    label: 'a local start with two merges and --track=inherit',
    config: SECOND_MAIN_MERGE,
    input: { startPoint: 'main', track: 'inherit' },
    upstream: { remote: 'origin', merges: ['refs/heads/main', 'refs/heads/z'], rebase: false },
    section: `${ORIGIN_SECTION}\tmerge = refs/heads/z\n`,
  },
  {
    label: 'a remote start a negative fetch refspec excludes',
    config: MAIN_EXCLUDED,
    input: { startPoint: 'origin/main' },
    upstream: undefined,
    section: undefined,
  },
  {
    label: 'a remote start a negative fetch refspec leaves alone',
    config: MAIN_EXCLUDED,
    input: { startPoint: 'origin/z', track: 'direct' },
    upstream: { remote: 'origin', merges: ['refs/heads/z'], rebase: false },
    section: '[branch "z"]\n\tremote = origin\n\tmerge = refs/heads/z\n',
  },
  {
    label: 'a remote start a negative pattern refspec excludes, with --track',
    config: '[remote "origin"]\n\tfetch = ^refs/heads/ma*\n',
    input: { startPoint: 'origin/z', track: 'direct' },
    upstream: { remote: 'origin', merges: ['refs/heads/z'], rebase: false },
    section: '[branch "z"]\n\tremote = origin\n\tmerge = refs/heads/z\n',
  },
  {
    label: 'a remote start under autoSetupMerge=true',
    config: '[branch]\n\tautoSetupMerge = true\n',
    input: { startPoint: 'origin/main' },
    upstream: ORIGIN_MAIN,
    section: ORIGIN_SECTION,
  },
  {
    label: 'a local start with --track under autoSetupRebase=remote',
    config: '[branch]\n\tautoSetupRebase = remote\n',
    input: { startPoint: 'main', track: 'direct' },
    upstream: LOCAL_MAIN,
    section: LOCAL_SECTION,
  },
  {
    label: 'a remote whose first fetch refspec maps another ref',
    config: `${OTHER_REMOTE_HEAD}\tfetch = +refs/heads/q:refs/remotes/o2x/q\n${OTHER_REMOTE_WILDCARD}`,
    input: { startPoint: 'other/x' },
    upstream: O2_X,
    section: O2_SECTION,
  },
  {
    label: 'a remote whose first fetch refspec has no destination',
    config: `${OTHER_REMOTE_HEAD}\tfetch = refs/heads/q\n${OTHER_REMOTE_WILDCARD}`,
    input: { startPoint: 'other/x' },
    upstream: O2_X,
    section: O2_SECTION,
  },
];

describe('branchCreate — upstream tracking', () => {
  describe.each(ROWS)('Given $label', ({ config, input, upstream, section }) => {
    describe('When branchCreate cuts z', () => {
      it('Then it records the upstream git would, and reports it', async () => {
        // Arrange
        const { ctx } = await seed(config);
        const sut = branchCreate;

        // Act
        const result = await sut(ctx, { name: 'z', ...input });

        // Assert
        expect(result.upstream).toEqual(upstream);
        expect(await branchSection(ctx, 'z')).toBe(section);
      });
    });
  });

  describe.each([
    { label: 'a tag', start: () => 't', code: 'UPSTREAM_NOT_BRANCH' },
    { label: 'an object id', start: (head: string) => head, code: 'UPSTREAM_NOT_BRANCH' },
    { label: 'an untracked remote ref', start: () => 'other/x', code: 'UPSTREAM_NOT_BRANCH' },
    { label: 'a missing name', start: () => 'absent', code: 'UPSTREAM_MISSING' },
    { label: 'a revision expression', start: () => 'HEAD~0', code: 'UPSTREAM_NOT_BRANCH' },
    { label: 'a local expression', start: () => 'main~0', code: 'UPSTREAM_NOT_BRANCH' },
    {
      label: 'a remote ref a negative refspec excludes',
      start: () => 'origin/main',
      code: 'UPSTREAM_NOT_BRANCH',
      config: MAIN_EXCLUDED,
    },
    {
      label: 'a remote ref a negative pattern refspec excludes',
      start: () => 'origin/main',
      code: 'UPSTREAM_NOT_BRANCH',
      config: '[remote "origin"]\n\tfetch = ^refs/heads/m*\n',
    },
  ])('Given --track from $label', ({ start, code, config }) => {
    describe('When branchCreate cuts z', () => {
      it('Then it refuses before writing the branch', async () => {
        // Arrange
        const { ctx, head } = await seed(config);
        const startPoint = start(head);
        const sut = branchCreate;

        // Act
        const result = await refusalOf(() => sut(ctx, { name: 'z', startPoint, track: 'direct' }));

        // Assert
        expect(result).toEqual({ code, startPoint });
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/refs/heads/z`)).toBe(false);
      });
    });
  });

  describe('Given two remotes fetching into the same tracking ref', () => {
    describe('When branchCreate cuts z from it', () => {
      it('Then it refuses after writing the branch, naming both remotes', async () => {
        // Arrange
        const { ctx } = await seed(
          '[remote "o2"]\n\turl = /up\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n',
        );
        const sut = branchCreate;

        // Act
        const result = await refusalOf(() => sut(ctx, { name: 'z', startPoint: 'origin/main' }));

        // Assert
        expect(result).toEqual({
          code: 'TRACKING_AMBIGUOUS',
          ref: 'refs/remotes/origin/main',
          remotes: ['origin', 'o2'],
        });
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/refs/heads/z`)).toBe(true);
        expect(await branchSection(ctx, 'z')).toBeUndefined();
      });
    });
  });

  describe('Given --track=inherit from a start with two merges under autoSetupRebase=always', () => {
    describe('When branchCreate cuts z', () => {
      it('Then it refuses after writing the branch, naming the merges', async () => {
        // Arrange
        const { ctx } = await seed(`${SECOND_MAIN_MERGE}[branch]\n\tautoSetupRebase = always\n`);
        const sut = branchCreate;

        // Act
        const result = await refusalOf(() =>
          sut(ctx, { name: 'z', startPoint: 'main', track: 'inherit' }),
        );

        // Assert
        expect(result).toEqual({
          code: 'TRACKING_INHERIT_REBASE_MULTIPLE',
          merges: ['refs/heads/main', 'refs/heads/z'],
        });
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/refs/heads/z`)).toBe(true);
        expect(await branchSection(ctx, 'z')).toBeUndefined();
      });
    });
  });

  describe('Given --track=inherit from a start holding a valueless merge', () => {
    describe('When branchCreate cuts z', () => {
      it('Then it refuses naming the valueless key', async () => {
        // Arrange
        const { ctx } = await seed('[branch "main"]\n\tmerge\n');
        const sut = branchCreate;

        // Act
        const result = await refusalOf(() =>
          sut(ctx, { name: 'z', startPoint: 'main', track: 'inherit' }),
        );

        // Assert
        expect(result).toMatchObject({ code: 'CONFIG_MISSING_VALUE', key: 'branch.main.merge' });
        expect(await branchSection(ctx, 'z')).toBeUndefined();
      });
    });
  });

  describe('Given --track=inherit from a start with no upstream', () => {
    describe.each([
      {
        label: 'a remote-tracking ref',
        startPoint: 'origin/main',
        extra: '',
        warning: {
          message: 'asked to inherit tracking, but no remote is set',
          context: { branch: 'refs/remotes/origin/main' },
        },
      },
      {
        label: 'a branch with a remote but no merge',
        startPoint: 'side',
        extra: '[branch "side"]\n\tremote = origin\n',
        warning: {
          message: 'asked to inherit tracking, but no merge configuration is set',
          context: { branch: 'side' },
        },
      },
    ])('When branchCreate cuts z from $label', ({ startPoint, extra, warning }) => {
      it('Then it warns and records nothing', async () => {
        // Arrange
        const { ctx, warnings } = await seed(extra);
        await branchCreate(ctx, { name: 'side' });
        const sut = branchCreate;

        // Act
        const result = await sut(ctx, { name: 'z', startPoint, track: 'inherit' });

        // Assert
        expect(result.upstream).toBeUndefined();
        expect(warnings).toEqual([warning]);
        expect(await branchSection(ctx, 'z')).toBeUndefined();
      });
    });
  });

  describe('Given autoSetupMerge=always and a forced reset of a branch onto itself', () => {
    describe('When branchCreate resets side from side', () => {
      it('Then it warns it will not track itself and leaves the config alone', async () => {
        // Arrange
        const { ctx, warnings } = await seed('[branch]\n\tautoSetupMerge = always\n');
        await branchCreate(ctx, { name: 'side', noTrack: true });
        const sut = branchCreate;

        // Act
        const result = await sut(ctx, { name: 'side', startPoint: 'side', force: true });

        // Assert
        expect(result.upstream).toBeUndefined();
        expect(warnings).toEqual([
          { message: 'not setting a branch as its own upstream', context: { branch: 'side' } },
        ]);
        expect(await branchSection(ctx, 'side')).toBeUndefined();
      });
    });
  });

  describe('Given --track from a name both a branch and a tag carry', () => {
    describe('When branchCreate cuts z', () => {
      it('Then it refuses as ambiguous rather than as a missing upstream', async () => {
        // Arrange
        const { ctx, head } = await seed();
        await branchCreate(ctx, { name: 'amb' });
        await updateRef(ctx, 'refs/tags/amb' as RefName, head as ObjectId, {
          reflogMessage: 'plant',
        });
        const sut = branchCreate;

        // Act
        const result = await refusalOf(() =>
          sut(ctx, { name: 'z', startPoint: 'amb', track: 'direct' }),
        );

        // Assert
        expect(result).toEqual({
          code: 'REVPARSE_AMBIGUOUS',
          expression: 'amb',
          candidates: [head, head],
        });
      });
    });
  });

  describe('Given a branch already tracking another upstream', () => {
    describe('When branchCreate resets it onto a remote start', () => {
      it('Then the new upstream replaces the old merge entries', async () => {
        // Arrange
        const { ctx } = await seed('[branch "z"]\n\tremote = old\n\tmerge = refs/heads/old\n');
        await branchCreate(ctx, { name: 'z', noTrack: true });
        const sut = branchCreate;

        // Act
        await sut(ctx, { name: 'z', startPoint: 'origin/main', force: true });

        // Assert
        expect(await branchSection(ctx, 'z')).toBe(ORIGIN_SECTION);
      });
    });
  });
});
