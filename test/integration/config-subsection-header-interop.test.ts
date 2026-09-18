/**
 * Cross-tool interop — the two spellings of a config subsection header.
 *
 * git keeps ONE flat variable name: `get_base_var` folds every byte of the
 * unquoted span to lower case, dots included, and the quoted span is appended
 * verbatim behind a dot. `[a.b]`, `[a.B]` and `[a "b"]` therefore name the same
 * variable, `[a "B"]` names a different one, and `[a.]` and `[a ""]` name the
 * same empty-subsection variable. Every row below offers one config file to
 * both tools and compares the names and values each reports.
 *
 * `--remove-section` is the exception that proves the rule: it matches the
 * header's OWN bytes, so `[s.X]` answers to `s.X` and not to `s.x`.
 *
 * @proves
 *   surface:        config
 *   bucket:         cross-tool-interop
 *   unique:         dotted and quoted subsection headers name one variable; section ops stay byte-matched
 *   interopSurface: config
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import {
  configGetAll,
  configList,
  configRemoveSection,
} from '../../src/application/commands/config.js';
import { __resetConfigCacheForTests } from '../../src/application/primitives/config-read.js';
import { TsgitError } from '../../src/domain/error.js';
import type { Context } from '../../src/ports/context.js';
import { GIT_AVAILABLE, runGit, tryRunGitWithExit } from './interop-helpers.js';

const SETUP_TIMEOUT = 60_000;

const caseRoots: string[] = [];

afterAll(async () => {
  await Promise.all(caseRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface ConfigCase {
  readonly dir: string;
  readonly ctx: Context;
  readonly configPath: string;
}

/**
 * A repository of its own whose `.git/config` ends with `text` verbatim. Raw
 * bytes are mandatory: `git config` will not write a dotted subsection header,
 * and every row below turns on exactly which header spelling was used.
 */
const repoWithConfigText = async (slug: string, text: string): Promise<ConfigCase> => {
  const root = await mkdtemp(path.join(os.tmpdir(), `tsgit-config-subsection-${slug}-`));
  caseRoots.push(root);
  const dir = path.join(root, 'repo');
  runGit(['init', '-q', '-b', 'main', dir]);
  const configPath = path.join(dir, '.git', 'config');
  await writeFile(configPath, `[core]\n\trepositoryformatversion = 0\n${text}`);
  __resetConfigCacheForTests();
  return { dir, ctx: createNodeContext({ workDir: dir }), configPath };
};

/** git's `--get-all` output as a list of values, or `[]` when the key is absent. */
const gitGetAll = (dir: string, key: string): ReadonlyArray<string> => {
  const result = tryRunGitWithExit(['-C', dir, 'config', '--get-all', key]);
  if (result.exitCode !== 0) return [];
  return result.stdout.split('\n').filter((line) => line.length > 0);
};

/** tsgit's `--get-all` equivalent, reduced to the same list of values. */
const tsgitGetAll = async (ctx: Context, key: string): Promise<ReadonlyArray<string>> => {
  const result = await configGetAll(ctx, { key });
  return result.values.flatMap(({ value }) => (value === null ? [] : [value]));
};

const caughtFrom = async (act: () => Promise<unknown>): Promise<TsgitError> => {
  let caught: unknown;
  try {
    await act();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(TsgitError);
  return caught as TsgitError;
};

describe.skipIf(!GIT_AVAILABLE)(
  'integration — subsection header spellings against canonical git',
  () => {
    describe.each([
      {
        slug: 'dotted',
        text: '[a.b]\n\tc = one\n',
        key: 'a.b.c',
        label: 'a dotted header answers to the dotted key',
      },
      {
        slug: 'dotted-folded',
        text: '[a.B]\n\tc = one\n',
        key: 'a.b.c',
        label: 'a mixed-case dotted subsection folds down to the lower-case key',
      },
      {
        slug: 'quoted-cased',
        text: '[a "B"]\n\tc = one\n',
        key: 'a.B.c',
        label: 'a quoted subsection keeps its case',
      },
      {
        slug: 'quoted-mismatch',
        text: '[a "B"]\n\tc = one\n',
        key: 'a.b.c',
        label: 'a quoted subsection does not answer to a differently-cased key',
      },
      {
        slug: 'merge',
        text: '[a.b]\n\tc = one\n[a "b"]\n\tc = two\n',
        key: 'a.b.c',
        label: 'both spellings feed one key, in file order',
      },
      {
        slug: 'merge-reversed',
        text: '[a "b"]\n\tc = two\n[a.b]\n\tc = one\n',
        key: 'a.b.c',
        label: 'the merge follows file order rather than a fixed spelling precedence',
      },
      {
        slug: 'empty-both',
        text: '[a.]\n\tb = one\n[a ""]\n\tb = two\n',
        key: 'a..b',
        label: 'a trailing dot and an empty quoted subsection name one variable',
      },
      {
        slug: 'mixed',
        text: '[a.B "C"]\n\td = one\n',
        key: 'a.b.C.d',
        label: 'a dotted section with a quoted subsection folds only its dotted half',
      },
      {
        slug: 'quoted-dot',
        text: '[a "b.c"]\n\td = one\n',
        key: 'a.b.c.d',
        label: 'a dot inside a quoted subsection is part of the name',
      },
    ])('Given $label', ({ slug, text, key }) => {
      describe('When both tools read that key', () => {
        it(
          'Then they name the same values in the same order',
          async () => {
            // Arrange
            const { dir, ctx } = await repoWithConfigText(slug, text);

            // Act
            const fromGit = gitGetAll(dir, key);
            const fromTsgit = await tsgitGetAll(ctx, key);

            // Assert
            expect(fromTsgit).toEqual(fromGit);
          },
          SETUP_TIMEOUT,
        );
      });
    });

    describe('Given a dotted header and a quoted one over the same name', () => {
      describe('When both tools list the whole file', () => {
        it(
          'Then the two spellings collapse onto one listed key',
          async () => {
            // Arrange
            const { dir, ctx } = await repoWithConfigText(
              'list',
              '[a.b]\n\tc = one\n[a "b"]\n\tc = two\n',
            );

            // Act
            const fromGit = tryRunGitWithExit(['-C', dir, 'config', '--list', '--local'])
              .stdout.split('\n')
              .filter((line) => line.startsWith('a.'));
            const listed = await configList(ctx, { scope: 'local' });
            const fromTsgit = listed.entries
              .filter((entry) => entry.key.startsWith('a.'))
              .map((entry) => `${entry.key}=${entry.value}`);

            // Assert
            expect(fromTsgit).toEqual(fromGit);
          },
          SETUP_TIMEOUT,
        );
      });
    });

    describe('Given a deprecated `[s.X]` header and a lower-cased section name to remove', () => {
      describe('When both tools are asked to remove it', () => {
        it(
          'Then both refuse — the section ops match the header bytes, not the folded key',
          async () => {
            // Arrange
            const { dir, ctx, configPath } = await repoWithConfigText('remove', '[s.X]\n\tk = a\n');

            // Act
            const fromGit = tryRunGitWithExit(['-C', dir, 'config', '--remove-section', 's.x']);
            const caught = await caughtFrom(() => configRemoveSection(ctx, { name: 's.x' }));

            // Assert
            expect(fromGit.exitCode).toBe(128);
            expect(fromGit.stderr).toBe('fatal: no such section: s.x\n');
            expect(caught.data).toEqual({
              code: 'CONFIG_SECTION_NOT_FOUND',
              name: 's.x',
              scope: 'local',
            });
            expect(await readFile(configPath, 'utf8')).toContain('[s.X]');
          },
          SETUP_TIMEOUT,
        );
      });
    });

    describe('Given a deprecated `[s.X]` header and its own byte-exact section name', () => {
      describe('When both tools are asked to remove it', () => {
        it(
          'Then both drop the block',
          async () => {
            // Arrange
            const ours = await repoWithConfigText('remove-exact-ours', '[s.X]\n\tk = a\n');
            const theirs = await repoWithConfigText('remove-exact-git', '[s.X]\n\tk = a\n');

            // Act
            const fromGit = tryRunGitWithExit([
              '-C',
              theirs.dir,
              'config',
              '--remove-section',
              's.X',
            ]);
            await configRemoveSection(ours.ctx, { name: 's.X' });

            // Assert
            expect(fromGit.exitCode).toBe(0);
            expect(await readFile(theirs.configPath, 'utf8')).not.toContain('[s.X]');
            expect(await readFile(ours.configPath, 'utf8')).not.toContain('[s.X]');
          },
          SETUP_TIMEOUT,
        );
      });
    });
  },
);
