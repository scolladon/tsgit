/**
 * `git diff <a> <b>` parses both expressions into one object-type table
 * before peeling either, so a typing the first one makes can turn the second
 * into a bad object.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { diff } from '../../src/application/commands/diff.js';
import { GIT_AVAILABLE, runGit, tryRunGitWithExit } from './interop-helpers.js';

const IDENT = 'author a <a@b> 1700000000 +0000\ncommitter a <a@b> 1700000000 +0000\n\nm\n';

describe.skipIf(!GIT_AVAILABLE)(
  'diff interop — one object-type table across both expressions',
  () => {
    const dirs: string[] = [];

    afterAll(() => {
      for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    });

    /** A blob and a commit stored naming that blob as its tree. */
    const buildRepo = (): {
      readonly dir: string;
      readonly blob: string;
      readonly named: string;
    } => {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'tsgit-interop-diff-types-'));
      dirs.push(dir);
      runGit(['init', '-q', '-b', 'main', dir]);
      const blob = runGit(['-C', dir, 'hash-object', '-w', '--stdin'], { input: 'hi\n' }).trim();
      const named = runGit(
        ['-C', dir, 'hash-object', '-t', 'commit', '-w', '--stdin', '--literally'],
        { input: `tree ${blob}\n${IDENT}` },
      ).trim();
      return { dir, blob, named };
    };

    describe.each([
      ['the blob, then the commit', false],
      ['the commit, then the blob', true],
    ] as const)('Given %s naming it as its tree', (_label, commitFirst) => {
      describe('When both tools diff them', () => {
        it('Then both log the same typing conflict and die on the same bad object', async () => {
          // Arrange
          const { dir, blob, named } = buildRepo();
          const [from, to] = commitFirst ? [named, blob] : [blob, named];
          const git = tryRunGitWithExit(['-C', dir, 'diff', '--no-ext-diff', from, to]);
          const logged: string[] = [];
          const base = createNodeContext({ workDir: dir });
          const ctx = { ...base, logger: { error: (line: string) => logged.push(line) } };
          const sut = diff;

          // Act
          const thrown = await sut(ctx, { from, to }).then(
            () => undefined,
            (error: unknown) => error,
          );

          // Assert
          const { id } = (thrown as { data: { id: string } }).data;
          expect(git.exitCode).toBe(128);
          expect(git.stderr).toBe(
            `${logged.map((line) => `error: ${line}\n`).join('')}fatal: bad object ${id}\n`,
          );
        });
      });
    });
  },
);
