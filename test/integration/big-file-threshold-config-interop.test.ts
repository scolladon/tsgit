/**
 * Cross-tool interop — a malformed `core.bigFileThreshold` under `fsck`. git
 * reads the key (last entry wins) the first time fsck reads an object's
 * content, so it refuses over a repository holding one, but never over an
 * empty one nor under `--connectivity-only`. Each row runs real `git fsck`
 * and tsgit's on the same state and rebuilds git's fatal line from tsgit's
 * structured error data.
 *
 * @proves
 *   surface:        fsck
 *   bucket:         cross-tool-interop
 *   unique:         fsck refuses a malformed core.bigFileThreshold exactly when git reads object content
 *   interopSurface: fsck
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FsckOptions } from '../../src/application/commands/fsck.js';
import { openRepository } from '../../src/index.node.js';
import { GIT_AVAILABLE, runGit, tryRunGitWithExit } from './interop-helpers.js';

const ROW_TIMEOUT = 30_000;

let root: string;

beforeAll(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'tsgit-interop-big-file-threshold-')));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A repository holding one loose blob, or none, under `config`'s `[core]` lines. */
const repoWith = (slug: string, lines: string, withObject: boolean): string => {
  const dir = path.join(root, slug);
  runGit(['init', '-q', '-b', 'main', dir]);
  if (withObject) runGit(['-C', dir, 'hash-object', '-w', '--stdin'], { input: 'x\n' });
  writeFileSync(path.join(dir, '.git', 'config'), `[core]\n${lines}`, { flag: 'a' });
  return dir;
};

/** git's fatal line, rebuilt from tsgit's refusal; `undefined` when fsck ran. */
const tsgitFatal = async (dir: string, opts: FsckOptions): Promise<string | undefined> => {
  const repo = await openRepository({ cwd: dir });
  try {
    await repo.fsck(opts);
    return undefined;
  } catch (err) {
    const data = (err as { readonly data?: Record<string, string> }).data;
    if (data?.code !== 'CONFIG_BAD_NUMERIC_VALUE') throw err;
    const source = path.relative(dir, data.source as string);
    return `fatal: bad numeric config value '${data.value}' for '${data.key}' in file ${source}: ${data.reason}\n`;
  } finally {
    await repo.dispose();
  }
};

const ROWS = [
  {
    name: 'a loose object, fsck',
    lines: '\tbigFileThreshold = x\n',
    withObject: true,
    flags: [],
    opts: {},
  },
  {
    name: 'a loose object, fsck --no-full',
    lines: '\tbigFileThreshold = x\n',
    withObject: true,
    flags: ['--no-full'],
    opts: { full: false },
  },
  {
    name: 'a loose object, fsck --connectivity-only',
    lines: '\tbigFileThreshold = x\n',
    withObject: true,
    flags: ['--connectivity-only'],
    opts: { connectivityOnly: true },
  },
  {
    name: 'no object, fsck',
    lines: '\tbigFileThreshold = x\n',
    withObject: false,
    flags: [],
    opts: {},
  },
  {
    name: 'a loose object, a valid entry after the malformed one',
    lines: '\tbigFileThreshold = x\n\tbigFileThreshold = 1m\n',
    withObject: true,
    flags: [],
    opts: {},
  },
  {
    name: 'a loose object, a malformed entry after a valid one',
    lines: '\tbigFileThreshold = 1m\n\tbigFileThreshold = -1\n',
    withObject: true,
    flags: [],
    opts: {},
  },
] as const;

describe.skipIf(!GIT_AVAILABLE)('fsck interop — malformed core.bigFileThreshold', () => {
  describe.each(ROWS.map((row, index) => ({ ...row, slug: `row-${index}` })))(
    'Given $name',
    ({ lines, withObject, flags, opts, slug }) => {
      describe('When git fsck and tsgit fsck run', () => {
        it(
          'Then both refuse with the same fatal line, or both audit',
          async () => {
            // Arrange
            const dir = repoWith(slug, lines, withObject);
            const git = tryRunGitWithExit(['-C', dir, 'fsck', ...flags]);
            const sut = tsgitFatal;

            // Act
            const result = await sut(dir, opts);

            // Assert
            const gitFatal = git.exitCode === 128 ? git.stderr : undefined;
            expect(result).toBe(gitFatal);
          },
          ROW_TIMEOUT,
        );
      });
    },
  );
});
