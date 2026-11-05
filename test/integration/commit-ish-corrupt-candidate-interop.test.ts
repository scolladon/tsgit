/**
 * Cross-tool interop — a commit-ish whose first ref candidate names a corrupt object: a tag
 * whose `object` line does not parse or names a missing object, or a ref to a missing object.
 * Each row builds the same fixture for git and tsgit, runs one route on each, and rebuilds
 * git's warning, error and fatal lines from tsgit's structured logs and refusal data.
 *
 * @proves
 *   surface:        revParse, cherryPick, revert, blame, describe, merge, rebase
 *   bucket:         cross-tool-interop
 *   unique:         a corrupt first commit-ish candidate wins the ladder and every route refuses on it as git does
 *   interopSurface: revParse, cherryPick, revert, merge
 */
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { blame } from '../../src/application/commands/blame.js';
import { cherryPickRun } from '../../src/application/commands/cherry-pick.js';
import { describe as describeCommand } from '../../src/application/commands/describe.js';
import { diff } from '../../src/application/commands/diff.js';
import { log } from '../../src/application/commands/log.js';
import { mergeRun } from '../../src/application/commands/merge.js';
import { rebaseRun } from '../../src/application/commands/rebase.js';
import { type RevParseEntry, revParse } from '../../src/application/commands/rev-parse.js';
import { revertRun } from '../../src/application/commands/revert.js';
import type { TsgitError } from '../../src/domain/error.js';
import type { Context } from '../../src/ports/context.js';
import {
  disableAutoMaintenance,
  GIT_AVAILABLE,
  git,
  revParseStdout,
  runGit,
  runGitEnv,
  tryRunGitWithExit,
} from './interop-helpers.js';

const SETUP_TIMEOUT = 60_000;
const NON_HEX_OBJECT = 'z'.repeat(40);
const TRUNCATED_OBJECT = 'abc';
const ABSENT_OBJECT = 'a'.repeat(40);
const MISSING_REF_TARGET = 'b'.repeat(40);
const WARNING_LOG = /^refname '|^ignoring dangling symref /;
const GIT_HINT = /^hint: /;

const identity: NodeJS.ProcessEnv = {
  ...runGitEnv(),
  GIT_AUTHOR_NAME: 'A',
  GIT_AUTHOR_EMAIL: 'a@x',
  GIT_AUTHOR_DATE: '1700000000 +0000',
  GIT_COMMITTER_NAME: 'A',
  GIT_COMMITTER_EMAIL: 'a@x',
  GIT_COMMITTER_DATE: '1700000000 +0000',
};

type Variant = 'non-hex' | 'truncated' | 'absent' | 'valid' | 'missing-ref' | 'tag-of-tree';

const VARIANTS: ReadonlyArray<Variant> = ['non-hex', 'truncated', 'absent', 'valid', 'missing-ref'];
const TEMPLATE_VARIANTS: ReadonlyArray<Variant> = [...VARIANTS, 'tag-of-tree'];
const TREE_TAG_NAME = 't';

interface Fixture {
  readonly dir: string;
  readonly c1: string;
  readonly c2: string;
  readonly tag: string;
}

interface Captured {
  readonly lines: string[];
  readonly logger: NonNullable<Context['logger']>;
}

interface Refusal {
  readonly code: string;
  readonly revision?: string;
  readonly expression?: string;
  readonly name?: string;
  readonly type?: string;
  readonly printed?: ReadonlyArray<RevParseEntry>;
}

interface Outcome {
  readonly refused: boolean;
  readonly stdout: string;
  readonly diagnostics: ReadonlyArray<string>;
}

const templates = new Map<Variant, string>();
const scratch: string[] = [];

const tagObjectFor = (variant: Variant, c1: string): string => {
  if (variant === 'non-hex') return NON_HEX_OBJECT;
  if (variant === 'truncated') return TRUNCATED_OBJECT;
  if (variant === 'absent') return ABSENT_OBJECT;
  return c1;
};

const tagRefName = (variant: Variant): string => (variant === 'tag-of-tree' ? TREE_TAG_NAME : 'x');

const writeTagRef = (dir: string, name: string, oid: string): void =>
  writeFileSync(path.join(dir, '.git', 'refs', 'tags', name), `${oid}\n`);

const plantTag = (dir: string, variant: Variant, c1: string): string => {
  if (variant === 'missing-ref') {
    writeTagRef(dir, 'x', MISSING_REF_TARGET);
    return MISSING_REF_TARGET;
  }
  const [object, type] =
    variant === 'tag-of-tree'
      ? [git(dir, 'rev-parse', 'main^{tree}').trim(), 'tree']
      : [tagObjectFor(variant, c1), 'commit'];
  const body = `object ${object}\ntype ${type}\ntag ${tagRefName(variant)}\ntagger A <a@x> 1700000000 +0000\n\nmsg\n`;
  const bodyFile = path.join(mkdtempSync(path.join(os.tmpdir(), 'tsgit-corrupt-tag-body-')), 'tag');
  scratch.push(path.dirname(bodyFile));
  writeFileSync(bodyFile, body);
  const oid = git(dir, 'hash-object', '-t', 'tag', '-w', '--literally', bodyFile).trim();
  writeTagRef(dir, tagRefName(variant), oid);
  return oid;
};

const buildTemplate = async (variant: Variant): Promise<string> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), `tsgit-corrupt-candidate-${variant}-`));
  templates.set(variant, dir);
  runGit(['init', '-q', '-b', 'main', dir]);
  git(dir, 'config', 'user.name', 'A');
  git(dir, 'config', 'user.email', 'a@x');
  disableAutoMaintenance(dir);
  writeFileSync(path.join(dir, 'f'), 'hi\n');
  git(dir, 'add', 'f');
  runGit(['-C', dir, 'commit', '-q', '-m', 'c1'], { env: identity });
  git(dir, 'branch', 'x');
  writeFileSync(path.join(dir, 'f'), 'hi\ntwo\n');
  runGit(['-C', dir, 'commit', '-q', '-am', 'c2'], { env: identity });
  plantTag(dir, variant, git(dir, 'rev-parse', 'main~1').trim());
  return dir;
};

const copyFixture = async (variant: Variant): Promise<Fixture> => {
  const template = templates.get(variant) as string;
  const dir = await mkdtemp(path.join(os.tmpdir(), `tsgit-corrupt-candidate-row-${variant}-`));
  scratch.push(dir);
  await cp(template, dir, { recursive: true });
  return {
    dir,
    c1: git(dir, 'rev-parse', 'main~1').trim(),
    c2: git(dir, 'rev-parse', 'main').trim(),
    tag: (await readTagRef(dir, tagRefName(variant))).trim(),
  };
};

const readTagRef = async (dir: string, name: string): Promise<string> =>
  readFile(path.join(dir, '.git', 'refs', 'tags', name), 'utf8');

const capture = (): Captured => {
  const lines: string[] = [];
  return {
    lines,
    logger: {
      warn: (message: string) => {
        if (WARNING_LOG.test(message)) lines.push(`warning: ${message}`);
      },
      error: (message: string) => {
        lines.push(`error: ${message}`);
      },
    },
  };
};

/** git's stderr as lines, its closing newline dropped, its `hint:` lines removed. */
const gitStderrLines = (stderr: string): ReadonlyArray<string> =>
  stderr === ''
    ? []
    : stderr
        .replace(/\n$/, '')
        .split('\n')
        .filter((line) => !GIT_HINT.test(line));

const AMBIGUOUS_ARGUMENT = (arg: string): ReadonlyArray<string> => [
  `fatal: ambiguous argument '${arg}': unknown revision or path not in the working tree.`,
  "Use '--' to separate paths from revisions, like this:",
  "'git <command> [<revision>...] -- [<file>...]'",
];

const refusalLines = (data: Refusal, route = 'cherry-pick'): ReadonlyArray<string> => {
  switch (data.code) {
    case 'OBJECT_NOT_FOUND': {
      const entry = data.printed?.find((printed) => printed.kind === 'path');
      return entry?.kind === 'path' ? AMBIGUOUS_ARGUMENT(entry.path) : [];
    }
    case 'BAD_OBJECT':
      return [`fatal: bad object ${data.revision}`];
    case 'INVALID_REVISION_RANGE':
      return [`fatal: Invalid revision range ${data.expression}`];
    case 'CANNOT_PICK_NON_COMMIT':
      return [
        `error: ${data.revision}: can't cherry-pick a ${data.type}`,
        `fatal: ${route} failed`,
      ];
    case 'DESCRIBE_NEITHER_COMMIT_NOR_BLOB':
      return [`fatal: ${data.revision} is neither a commit nor blob`];
    case 'BLAME_NON_COMMIT':
      return [`fatal: Non commit ${data.revision}?`];
    case 'REF_NOT_FOUND':
      if (route !== 'merge') throw new Error(`unexpected refusal ${data.code} on ${route}`);
      return [`merge: ${data.name} - not something we can merge`];
    default:
      throw new Error(`unexpected refusal ${data.code}`);
  }
};

const gitOutcome = (dir: string, args: ReadonlyArray<string>): Outcome => {
  const result = tryRunGitWithExit(['-C', dir, ...args], { env: runGitEnv() });
  return {
    refused: result.exitCode !== 0,
    stdout: result.stdout.replace(/\n$/, ''),
    diagnostics: gitStderrLines(result.stderr),
  };
};

const tsgitRevParse = async (dir: string, arg: string): Promise<Outcome> => {
  const captured = capture();
  const ctx: Context = { ...createNodeContext({ workDir: dir }), logger: captured.logger };
  const sut = revParse;
  try {
    const entries = await sut(ctx, arg);
    return { refused: false, stdout: revParseStdout(entries), diagnostics: captured.lines };
  } catch (error) {
    const data = (error as TsgitError).data as unknown as Refusal;
    return {
      refused: true,
      stdout: revParseStdout(data.printed ?? []),
      diagnostics: [...captured.lines, ...refusalLines(data)],
    };
  }
};

const tsgitDescribe = async (
  dir: string,
  options: { readonly always?: true },
): Promise<Outcome> => {
  const captured = capture();
  const ctx: Context = { ...createNodeContext({ workDir: dir }), logger: captured.logger };
  const sut = describeCommand;
  try {
    await sut(ctx, 'x', options);
    return { refused: false, stdout: '', diagnostics: captured.lines };
  } catch (error) {
    const data = (error as TsgitError).data as unknown as Refusal;
    return { refused: true, stdout: '', diagnostics: [...captured.lines, ...refusalLines(data)] };
  }
};

interface ReadRefusal {
  readonly refused: boolean;
  readonly code: string | undefined;
  readonly warnings: ReadonlyArray<string>;
}

const tsgitRefusal = async (
  dir: string,
  read: (ctx: Context) => Promise<unknown>,
): Promise<ReadRefusal> => {
  const captured = capture();
  const ctx: Context = { ...createNodeContext({ workDir: dir }), logger: captured.logger };
  try {
    await read(ctx);
    return { refused: false, code: undefined, warnings: captured.lines };
  } catch (error) {
    return { refused: true, code: (error as TsgitError).data.code, warnings: captured.lines };
  }
};

interface ReplayState {
  readonly cherryPickHead: boolean;
  readonly revertHead: boolean;
  readonly sequencer: boolean;
  readonly head: string;
  readonly status: string;
}

const stateOf = (dir: string): ReplayState => ({
  cherryPickHead: existsSync(path.join(dir, '.git', 'CHERRY_PICK_HEAD')),
  revertHead: existsSync(path.join(dir, '.git', 'REVERT_HEAD')),
  sequencer: existsSync(path.join(dir, '.git', 'sequencer')),
  head: git(dir, 'rev-parse', 'HEAD').trim(),
  status: git(dir, 'status', '--porcelain'),
});

interface ReplayRoute {
  readonly route: 'cherry-pick' | 'revert' | 'merge';
  readonly args: ReadonlyArray<string>;
  readonly run: (ctx: Context, commits: ReadonlyArray<string>) => Promise<unknown>;
}

const cherryPick: ReplayRoute['run'] = (ctx, commits) => cherryPickRun(ctx, { commits });
const revert: ReplayRoute['run'] = (ctx, commits) => revertRun(ctx, { commits });

const tsgitReplay = async (
  dir: string,
  route: ReplayRoute['route'],
  run: ReplayRoute['run'],
  commits: ReadonlyArray<string>,
): Promise<Outcome> => {
  const captured = capture();
  const ctx: Context = { ...createNodeContext({ workDir: dir }), logger: captured.logger };
  try {
    await run(ctx, commits);
    return { refused: false, stdout: '', diagnostics: captured.lines };
  } catch (error) {
    const data = (error as TsgitError).data as unknown as Refusal;
    return {
      refused: true,
      stdout: '',
      diagnostics: [...captured.lines, ...refusalLines(data, route)],
    };
  }
};

const tsgitBlame = async (dir: string, revision: string): Promise<Outcome> => {
  const captured = capture();
  const ctx: Context = { ...createNodeContext({ workDir: dir }), logger: captured.logger };
  const sut = blame;
  try {
    await sut(ctx, 'f', { rev: revision });
    return { refused: false, stdout: '', diagnostics: captured.lines };
  } catch (error) {
    const data = (error as TsgitError).data as unknown as Refusal;
    return { refused: true, stdout: '', diagnostics: [...captured.lines, ...refusalLines(data)] };
  }
};

const mergeRoute: ReplayRoute['run'] = (ctx, rev) =>
  mergeRun(ctx, {
    rev: [...rev],
    author: { name: 'A', email: 'a@x', timestamp: 1_700_000_000, timezoneOffset: '+0000' },
  });

const ambiguityWarnings = (lines: ReadonlyArray<string>): ReadonlyArray<string> =>
  lines.filter((line) => line.startsWith('warning: refname '));

describe.skipIf(!GIT_AVAILABLE)('integration — a corrupt first commit-ish candidate', () => {
  beforeAll(async () => {
    await Promise.all(TEMPLATE_VARIANTS.map(buildTemplate));
  }, SETUP_TIMEOUT);

  afterAll(async () => {
    await Promise.all(
      [...templates.values(), ...scratch].map((d) => rm(d, { recursive: true, force: true })),
    );
  });

  describe.each(VARIANTS)(
    'Given a tag ref x that names a %s object ahead of branch x',
    (variant) => {
      describe('When git rev-parse and revParse read x', () => {
        it("Then tsgit prints the tag ref's own id and warns once, as git does", async () => {
          // Arrange
          const { dir, tag } = await copyFixture(variant);
          const expected = gitOutcome(dir, ['rev-parse', 'x']);

          // Act
          const result = await tsgitRevParse(dir, 'x');

          // Assert
          expect(expected.stdout).toBe(tag);
          expect(result).toEqual(expected);
          expect(result.diagnostics).toEqual(["warning: refname 'x' is ambiguous."]);
        });
      });
    },
  );

  describe('Given the valid tag variant', () => {
    describe('When git rev-parse and revParse read x~5', () => {
      it('Then tsgit refuses on the printed path and warns twice, as git does', async () => {
        // Arrange
        const { dir } = await copyFixture('valid');
        const expected = gitOutcome(dir, ['rev-parse', 'x~5']);

        // Act
        const result = await tsgitRevParse(dir, 'x~5');

        // Assert
        expect(expected.refused).toBe(true);
        expect(result).toEqual(expected);
      });
    });
  });

  describe.each([
    { variant: 'absent', arg: 'x^{commit}' },
    { variant: 'absent', arg: 'x^{blob}' },
    { variant: 'missing-ref', arg: 'x^{commit}' },
    { variant: 'missing-ref', arg: 'x^{blob}' },
    { variant: 'valid', arg: 'x^{blob}' },
  ] as const)('Given $variant, $arg', ({ variant, arg }) => {
    describe('When git rev-parse and revParse read the argument', () => {
      it('Then tsgit warns and errs as often as git, and refuses on the printed path', async () => {
        // Arrange
        const { dir } = await copyFixture(variant);
        const expected = gitOutcome(dir, ['rev-parse', arg]);

        // Act
        const result = await tsgitRevParse(dir, arg);

        // Assert
        expect(expected.refused).toBe(true);
        expect(result).toEqual(expected);
      });
    });
  });

  describe.each([
    { variant: 'non-hex', arg: 'x^{commit}' },
    { variant: 'non-hex', arg: 'x^{blob}' },
    { variant: 'truncated', arg: 'x^{commit}' },
    { variant: 'truncated', arg: 'x^{blob}' },
  ] as const)('Given $variant, $arg', ({ variant, arg }) => {
    describe('When git rev-parse and revParse read the argument', () => {
      it('Then tsgit prints the argument, warns once and refuses on it, as git does', async () => {
        // Arrange
        const { dir } = await copyFixture(variant);
        const expected = gitOutcome(dir, ['rev-parse', arg]);

        // Act
        const result = await tsgitRevParse(dir, arg);

        // Assert
        expect(expected).toEqual({
          refused: true,
          stdout: arg,
          diagnostics: ["warning: refname 'x' is ambiguous.", ...AMBIGUOUS_ARGUMENT(arg)],
        });
        expect(result).toEqual(expected);
      });
    });
  });

  describe.each([
    {
      route: 'log',
      git: ['log', '-1', 'x^{commit}'],
      read: (ctx: Context) => log(ctx, { rev: 'x^{commit}', limit: 1 }),
    },
    {
      route: 'diff',
      git: ['diff', 'x^{commit}'],
      read: (ctx: Context) => diff(ctx, { from: 'x^{commit}' }),
    },
  ])('Given a corrupt tag ref x, $route reading x^{commit}', ({ git: args, read }) => {
    describe.each(['non-hex', 'truncated'] as const)('When the tag is %s', (variant) => {
      it('Then tsgit refuses OBJECT_NOT_FOUND and warns once, as git does', async () => {
        // Arrange
        const { dir } = await copyFixture(variant);
        const expected = gitOutcome(dir, args);

        // Act
        const result = await tsgitRefusal(dir, read);

        // Assert
        expect(expected.diagnostics).toEqual([
          "warning: refname 'x' is ambiguous.",
          ...AMBIGUOUS_ARGUMENT('x^{commit}'),
        ]);
        expect(result).toEqual({
          refused: expected.refused,
          code: 'OBJECT_NOT_FOUND',
          warnings: expected.diagnostics.slice(0, 1),
        });
      });
    });
  });

  describe.each([
    { variant: 'non-hex', data: { code: 'INVALID_OBJECT_ID', value: NON_HEX_OBJECT } },
    { variant: 'truncated', data: { code: 'INVALID_OBJECT_ID', value: TRUNCATED_OBJECT } },
    { variant: 'absent', data: { code: 'OBJECT_NOT_FOUND', id: ABSENT_OBJECT } },
    { variant: 'missing-ref', data: { code: 'OBJECT_NOT_FOUND', id: MISSING_REF_TARGET } },
  ] as const)('Given $variant', ({ variant, data }) => {
    describe('When git rebase -i and rebaseRun take the todo pick x', () => {
      it('Then both refuse and tsgit writes no rebase state', async () => {
        // Arrange
        const { dir, c1, c2 } = await copyFixture(variant);
        const expected = tryRunGitWithExit(['-C', dir, 'rebase', '-i', c1], {
          env: { ...runGitEnv(), ...identity, GIT_SEQUENCE_EDITOR: "printf 'pick x\\n' >" },
        });
        runGit(['-C', dir, 'rebase', '--abort'], { env: identity });
        const ctx = createNodeContext({ workDir: dir });
        const sut = rebaseRun;

        // Act
        const result = await sut(ctx, {
          upstream: c1,
          interactive: [{ action: 'pick', oid: 'x' }],
        }).catch((error: TsgitError) => error);

        // Assert
        expect(expected.exitCode).toBe(1);
        expect(expected.stderr).toContain('error: invalid line 1: pick x');
        expect((result as TsgitError).data).toMatchObject(data);
        expect(existsSync(path.join(dir, '.git', 'rebase-merge'))).toBe(false);
        expect(git(dir, 'rev-parse', 'HEAD').trim()).toBe(c2);
      });
    });
  });

  describe.each([
    { options: {}, flags: [] },
    { options: { always: true }, flags: ['--always'] },
  ] as const)('Given describe with $flags', ({ options, flags }) => {
    describe.each(['non-hex', 'truncated', 'absent', 'missing-ref'] as const)(
      'When the tag ref x names a %s object',
      (variant) => {
        it('Then git and describe warn the ambiguity and refuse neither a commit nor blob', async () => {
          // Arrange
          const { dir } = await copyFixture(variant);
          const expected = gitOutcome(dir, ['describe', ...flags, 'x']);

          // Act
          const result = await tsgitDescribe(dir, options);

          // Assert
          expect(expected.diagnostics).toEqual([
            "warning: refname 'x' is ambiguous.",
            'fatal: x is neither a commit nor blob',
          ]);
          expect(result).toEqual(expected);
        });
      },
    );
  });

  describe.each([
    { variant: 'non-hex', names: ['x'], lines: 1 },
    { variant: 'truncated', names: ['x'], lines: 1 },
    { variant: 'missing-ref', names: ['x'], lines: 1 },
    { variant: 'absent', names: ['x'], lines: 2 },
    { variant: 'tag-of-tree', names: ['t'], lines: 0 },
  ] as const)('Given the $variant variant', ({ variant, names, lines }) => {
    describe.each([
      { route: 'cherry-pick', verb: 'cherry-pick', run: cherryPick, tail: [] },
      { route: 'cherry-pick', verb: 'cherry-pick', run: cherryPick, tail: ['main'] },
      { route: 'revert', verb: 'revert', run: revert, tail: [] },
    ] as const)('When $verb takes $names then $tail', ({ route, verb, run, tail }) => {
      it('Then tsgit refuses with git lines and writes no state, as git does', async () => {
        // Arrange
        const commits = [...names, ...tail];
        const twinGit = await copyFixture(variant);
        const twinTsgit = await copyFixture(variant);
        const expected = gitOutcome(twinGit.dir, [verb, ...commits]);

        // Act
        const result = await tsgitReplay(twinTsgit.dir, route, run, commits);

        // Assert
        expect(expected.refused).toBe(true);
        expect(ambiguityWarnings(expected.diagnostics)).toHaveLength(
          variant === 'tag-of-tree' ? 0 : lines,
        );
        expect(result.diagnostics).toEqual(expected.diagnostics);
        expect(stateOf(twinTsgit.dir)).toEqual(stateOf(twinGit.dir));
        expect(stateOf(twinGit.dir)).toEqual({
          cherryPickHead: false,
          revertHead: false,
          sequencer: false,
          head: twinGit.c2,
          status: '',
        });
      });
    });
  });

  describe.each([
    { variant: 'non-hex', refusal: 'fatal: bad object x' },
    { variant: 'missing-ref', refusal: 'fatal: bad object x' },
  ] as const)('Given the $variant variant', ({ variant, refusal }) => {
    describe.each([
      { commits: ['^x', 'main'], last: refusal },
      { commits: ['main', '^x'], last: refusal },
      { commits: ['x..main'], last: 'fatal: Invalid revision range x..main' },
    ])('When cherry-pick takes $commits', ({ commits, last }) => {
      it('Then tsgit refuses on the first read with git lines and writes no state, as git does', async () => {
        // Arrange
        const twinGit = await copyFixture(variant);
        const twinTsgit = await copyFixture(variant);
        const expected = gitOutcome(twinGit.dir, ['cherry-pick', ...commits]);

        // Act
        const result = await tsgitReplay(twinTsgit.dir, 'cherry-pick', cherryPick, commits);

        // Assert
        expect(expected.refused).toBe(true);
        expect(ambiguityWarnings(expected.diagnostics)).toHaveLength(1);
        expect(expected.diagnostics.at(-1)).toBe(last);
        expect(result).toEqual(expected);
        expect(stateOf(twinTsgit.dir)).toEqual(stateOf(twinGit.dir));
      });
    });
  });

  describe.each([
    { verb: 'cherry-pick', run: cherryPick, commits: ['x'] },
    { verb: 'cherry-pick', run: cherryPick, commits: ['x..main'] },
    { verb: 'cherry-pick', run: cherryPick, commits: ['^x', 'main'] },
    { verb: 'revert', run: revert, commits: ['x'] },
  ] as const)('Given a valid x ambiguous between tag and branch', ({ verb, run, commits }) => {
    describe('When $verb takes $commits', () => {
      it('Then tsgit warns the ambiguity as often as git does', async () => {
        // Arrange
        const twinGit = await copyFixture('valid');
        const twinTsgit = await copyFixture('valid');
        const expected = gitOutcome(twinGit.dir, [verb, ...commits]);

        // Act
        const result = await tsgitReplay(twinTsgit.dir, verb, run, commits);

        // Assert
        expect(ambiguityWarnings(expected.diagnostics)).toHaveLength(2);
        expect(ambiguityWarnings(result.diagnostics)).toEqual(
          ambiguityWarnings(expected.diagnostics),
        );
      });
    });
  });

  describe.each([
    { variant: 'non-hex', refusal: 'fatal: bad object x', lines: 1 },
    { variant: 'truncated', refusal: 'fatal: bad object x', lines: 1 },
    { variant: 'missing-ref', refusal: 'fatal: bad object x', lines: 1 },
    { variant: 'absent', refusal: 'fatal: Non commit x?', lines: 1 },
  ] as const)('Given the $variant variant', ({ variant, refusal, lines }) => {
    describe('When git blame and blame read f at x', () => {
      it('Then tsgit refuses with git lines, as git does', async () => {
        // Arrange
        const { dir } = await copyFixture(variant);
        const expected = gitOutcome(dir, ['blame', 'x', '--', 'f']);

        // Act
        const result = await tsgitBlame(dir, 'x');

        // Assert
        expect(expected.refused).toBe(true);
        expect(ambiguityWarnings(expected.diagnostics)).toHaveLength(lines);
        expect(expected.diagnostics.at(-1)).toBe(refusal);
        expect(result).toEqual(expected);
      });
    });
  });

  describe.each(['non-hex', 'truncated', 'absent', 'missing-ref'] as const)(
    'Given the %s variant',
    (variant) => {
      describe.each([{ revs: ['x'] }, { revs: ['main', 'x'] }])(
        'When merge takes $revs',
        ({ revs }) => {
          it('Then tsgit refuses with git lines and writes no MERGE_HEAD, as git does', async () => {
            // Arrange
            const commits = [...revs];
            const twinGit = await copyFixture(variant);
            const twinTsgit = await copyFixture(variant);
            const expected = gitOutcome(twinGit.dir, ['merge', ...commits]);

            // Act
            const result = await tsgitReplay(twinTsgit.dir, 'merge', mergeRoute, commits);

            // Assert
            expect(expected.refused).toBe(true);
            expect(expected.diagnostics.at(-1)).toBe('merge: x - not something we can merge');
            expect(result.diagnostics).toEqual(expected.diagnostics);
            expect(existsSync(path.join(twinTsgit.dir, '.git', 'MERGE_HEAD'))).toBe(false);
            expect(stateOf(twinTsgit.dir)).toEqual(stateOf(twinGit.dir));
            expect(stateOf(twinGit.dir).head).toBe(twinGit.c2);
          });
        },
      );
    },
  );
});
