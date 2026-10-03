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
import type { AuthorIdentity, RefName } from '../../../../src/domain/objects/index.js';
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

interface Seeded {
  readonly ctx: Context;
  readonly warnings: string[];
  readonly head: string;
}

const seed = async (extraConfig = ''): Promise<Seeded> => {
  const warnings: string[] = [];
  const base = createMemoryContext();
  const ctx: Context = { ...base, logger: { warn: (message: string) => warnings.push(message) } };
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
        warning: "asked to inherit tracking from 'refs/remotes/origin/main', but no remote is set",
      },
      {
        label: 'a branch with a remote but no merge',
        startPoint: 'side',
        extra: '[branch "side"]\n\tremote = origin\n',
        warning: "asked to inherit tracking from 'side', but no merge configuration is set",
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
        expect(warnings).toEqual(["not setting branch 'side' as its own upstream"]);
        expect(await branchSection(ctx, 'side')).toBeUndefined();
      });
    });
  });
});
