/**
 * Cross-tool interop — a malformed `core.bigFileThreshold` while fetching.
 * git's index-pack (and unpack-objects, for a small pack) reads the key on the
 * first non-delta blob entry of the received pack, so a fetch refuses or runs
 * depending on what the pack carries. Each row runs real git and tsgit on twin
 * clones of one upstream and rebuilds git's first fatal line from tsgit's
 * structured error data.
 *
 * @proves
 *   surface:        fetch
 *   bucket:         cross-tool-interop
 *   unique:         a malformed core.bigFileThreshold refuses a fetch exactly when the received pack holds a non-delta blob
 *   interopSurface: fetch
 */
import { execFile } from 'node:child_process';
import { mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openRepository } from '../../src/index.node.js';
import {
  findGitHttpBackend,
  type GitHttpBackend,
  startGitHttpBackend,
} from '../bench/support/http-backend-server.js';
import { GIT_AVAILABLE, runGit, runGitEnv } from './interop-helpers.js';

const ROW_TIMEOUT = 30_000;
const MALFORMED = '[core]\n\tbigFileThreshold = x\n';
const NO_FETCH_BACKEND =
  !GIT_AVAILABLE || findGitHttpBackend() === undefined || process.cwd().includes('.stryker-tmp');

let root: string;
let server: GitHttpBackend;
let count = 0;

beforeAll(async () => {
  if (NO_FETCH_BACKEND) return;
  root = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'tsgit-interop-big-file-fetch-')));
  server = await startGitHttpBackend({ projectRoot: root, forwardGitProtocol: true });
});

afterAll(async () => {
  if (NO_FETCH_BACKEND) return;
  await server.close();
  rmSync(root, { recursive: true, force: true });
});

const commitAll = (dir: string, message: string): void => {
  runGit(['-C', dir, 'add', '-A']);
  runGit(['-C', dir, 'commit', '-q', '--allow-empty', '-m', message]);
};

/** git's stderr, exit status aside — it fetches over the in-process server, so it must not block. */
const gitStderr = (args: ReadonlyArray<string>): Promise<string> =>
  new Promise((resolve) => {
    execFile('git', [...args], { env: runGitEnv() }, (_error, _stdout, stderr) => resolve(stderr));
  });

interface Upstream {
  readonly bare: string;
  readonly seed: string;
  readonly url: string;
}

/** An upstream seeded with two files, plus its working seed. */
const upstream = (): Upstream => {
  count += 1;
  const bare = path.join(root, `up-${count}.git`);
  const seed = path.join(root, `seed-${count}`);
  runGit(['init', '--bare', '-q', '-b', 'main', bare]);
  runGit(['init', '-q', '-b', 'main', seed]);
  writeFileSync(path.join(seed, 'f1.txt'), 'content 1\n');
  writeFileSync(path.join(seed, 'f2.txt'), 'content 2\n');
  commitAll(seed, 'seed');
  runGit(['-C', seed, 'push', '-q', bare, 'main']);
  return { bare, seed, url: `http://127.0.0.1:${server.port}/up-${count}.git` };
};

/** A clone of `from` fetching over the server, under a malformed threshold. */
const cloneOf = (from: Upstream, name: string): string => {
  const dir = path.join(root, `${name}-${count}`);
  runGit(['clone', '-q', from.bare, dir]);
  runGit(['-C', dir, 'remote', 'set-url', 'origin', from.url]);
  writeFileSync(path.join(dir, '.git', 'config'), MALFORMED, { flag: 'a' });
  return dir;
};

const tsgitFatal = async (dir: string): Promise<string | undefined> => {
  const repo = await openRepository({
    cwd: dir,
    allowInsecureHttp: true,
    config: {
      allowInsecure: true,
      allowPrivateNetworks: true,
      dnsResolver: async () => ['127.0.0.1'],
    },
  });
  try {
    await repo.fetch({ remote: 'origin' });
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

const firstFatalLine = (stderr: string): string | undefined => {
  const line = stderr.split('\n').find((candidate) => candidate.startsWith('fatal: '));
  return line === undefined ? undefined : `${line}\n`;
};

const ROWS: ReadonlyArray<{ readonly name: string; readonly advance: (seed: string) => void }> = [
  { name: 'a commit alone', advance: () => undefined },
  {
    name: 'a commit and its trees',
    advance: (seed) => {
      mkdirSync(path.join(seed, 'd'));
      renameSync(path.join(seed, 'f1.txt'), path.join(seed, 'd', 'f1.txt'));
    },
  },
  {
    name: 'a new blob',
    advance: (seed) => writeFileSync(path.join(seed, 'n.txt'), 'new\n'),
  },
];

describe.skipIf(NO_FETCH_BACKEND)('interop — malformed core.bigFileThreshold on fetch', () => {
  describe.each(ROWS)('Given an upstream advanced by $name', ({ advance }) => {
    describe('When git and tsgit fetch it', () => {
      it(
        'Then both refuse with the same fatal line, or both fetch',
        async () => {
          // Arrange
          const origin = upstream();
          const gitDir = cloneOf(origin, 'git');
          const dir = cloneOf(origin, 'tsgit');
          advance(origin.seed);
          commitAll(origin.seed, 'advance');
          runGit(['-C', origin.seed, 'push', '-q', origin.bare, 'main']);
          const gitStderrLines = await gitStderr(['-C', gitDir, 'fetch', '-q', 'origin']);
          const sut = tsgitFatal;

          // Act
          const result = await sut(dir);

          // Assert
          expect(result).toBe(firstFatalLine(gitStderrLines));
        },
        ROW_TIMEOUT,
      );
    });
  });
});
