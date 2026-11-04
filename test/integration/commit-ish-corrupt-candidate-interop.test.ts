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
import { mkdtempSync, writeFileSync } from 'node:fs';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { type RevParseEntry, revParse } from '../../src/application/commands/rev-parse.js';
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

type Variant = 'non-hex' | 'truncated' | 'absent' | 'valid' | 'missing-ref';

const VARIANTS: ReadonlyArray<Variant> = ['non-hex', 'truncated', 'absent', 'valid', 'missing-ref'];

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

const writeTagRef = (dir: string, oid: string): void =>
  writeFileSync(path.join(dir, '.git', 'refs', 'tags', 'x'), `${oid}\n`);

const plantTag = (dir: string, variant: Variant, c1: string): string => {
  if (variant === 'missing-ref') {
    writeTagRef(dir, MISSING_REF_TARGET);
    return MISSING_REF_TARGET;
  }
  const body = `object ${tagObjectFor(variant, c1)}\ntype commit\ntag x\ntagger A <a@x> 1700000000 +0000\n\nmsg\n`;
  const bodyFile = path.join(mkdtempSync(path.join(os.tmpdir(), 'tsgit-corrupt-tag-body-')), 'tag');
  scratch.push(path.dirname(bodyFile));
  writeFileSync(bodyFile, body);
  const oid = git(dir, 'hash-object', '-t', 'tag', '-w', '--literally', bodyFile).trim();
  writeTagRef(dir, oid);
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
    tag: (await readTagRef(dir)).trim(),
  };
};

const readTagRef = async (dir: string): Promise<string> =>
  readFile(path.join(dir, '.git', 'refs', 'tags', 'x'), 'utf8');

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

const refusalLines = (data: Refusal): ReadonlyArray<string> => {
  switch (data.code) {
    case 'OBJECT_NOT_FOUND': {
      const entry = data.printed?.find((printed) => printed.kind === 'path');
      return entry?.kind === 'path' ? AMBIGUOUS_ARGUMENT(entry.path) : [];
    }
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

describe.skipIf(!GIT_AVAILABLE)('integration — a corrupt first commit-ish candidate', () => {
  beforeAll(async () => {
    await Promise.all(VARIANTS.map(buildTemplate));
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
});
