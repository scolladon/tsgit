/**
 * Cross-tool interop — boolean config refusal tier boundaries. Drives tsgit's
 * operational commands and config porcelain (through the `openRepository`
 * facade) and canonical git via the CLI, against isolated tmpdirs whose
 * `.git/config` is written directly with `writeFile` — git's CLI cannot emit
 * a valueless entry, and X16 controls file-line order for a cross-class
 * tie-break, so raw fixture text is used uniformly across every row.
 *
 * @proves
 *   surface:        config
 *   bucket:         cross-tool-interop
 *   unique:         boolean refusal tier boundaries pinned against canonical git
 */
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TsgitError } from '../../src/domain/error.js';
import { encodePktStream } from '../../src/domain/protocol/pkt-line.js';
import { openRepository } from '../../src/index.node.js';
import type { HttpRequest, HttpResponse, HttpTransport } from '../../src/ports/http-transport.js';
import type { Repository } from '../../src/repository.js';
import {
  GIT_AVAILABLE,
  runGit,
  runGitEnv,
  tryRunGit,
  tryRunGitWithExit,
} from './interop-helpers.js';

const ENCODER = new TextEncoder();
const ZERO_OID = '0'.repeat(40);

interface BadBooleanData {
  readonly code: string;
  readonly key: string;
  readonly value?: string;
  readonly source: string;
}

const asBadBoolean = (err: unknown): BadBooleanData => {
  if (!(err instanceof TsgitError)) throw new Error('expected a TsgitError');
  return err.data as unknown as BadBooleanData;
};

/** Run `fn` against a fresh repo opened at `dir`, disposing it afterwards. */
const withRepo = async <T>(dir: string, fn: (repo: Repository) => Promise<T>): Promise<T> => {
  const repo = await openRepository({ cwd: dir });
  try {
    return await fn(repo);
  } finally {
    await repo.dispose();
  }
};

/** Run `fn` against `repo`, capturing a thrown error instead of propagating it. */
const captureThrow = async (fn: () => Promise<unknown>): Promise<unknown> => {
  try {
    await fn();
    return undefined;
  } catch (err) {
    return err;
  }
};

/**
 * A minimal `git-receive-pack` discovery-only transport: serves the
 * `info/refs` advertisement and fails the test if the pack POST is ever
 * reached — the `push.gpgSign` guard must fire before that, exactly as
 * canonical git's does.
 */
const receivePackDiscoveryOnlyTransport = (refName: string, remoteOid: string): HttpTransport => {
  const header = encodePktStream([ENCODER.encode('# service=git-receive-pack\n')]);
  const refLine = encodePktStream([
    ENCODER.encode(`${remoteOid} ${refName}\0report-status ofs-delta\n`),
  ]);
  const advertisement = new Uint8Array(header.length + refLine.length);
  advertisement.set(header, 0);
  advertisement.set(refLine, header.length);
  return {
    request: async (req: HttpRequest): Promise<HttpResponse> => {
      if (!req.url.includes('info/refs')) {
        throw new Error('push must not reach the pack POST — the boolean guard should fire first');
      }
      return {
        statusCode: 200,
        headers: {},
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(advertisement.slice());
            controller.close();
          },
        }),
      };
    },
  };
};

describe.skipIf(!GIT_AVAILABLE)('config boolean refusal tier interop', () => {
  let ours: string;

  beforeEach(async () => {
    ours = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-config-boolean-')));
    runGit(['init', '-q', '-b', 'main', ours]);
  });

  afterEach(async () => {
    await rm(ours, { recursive: true, force: true });
  });

  const writeConfig = (content: string): Promise<void> =>
    writeFile(path.join(ours, '.git', 'config'), content);

  describe('Given X11 — core.bare = maybe (T1)', () => {
    beforeEach(() => writeConfig('[core]\n\trepositoryformatversion = 0\n\tbare = maybe\n'));

    describe('When git status and tsgit status run', () => {
      it('Then both refuse with exit 128 / CONFIG_BAD_BOOLEAN_VALUE naming core.bare', async () => {
        // Arrange & Act — armed in beforeEach. The refusal now fires at
        // `openRepository` (Stage 2 of layout resolution), before any
        // command runs — `withRepo` would never return.
        const g = tryRunGit(['-C', ours, 'status'], { env: runGitEnv() });
        const caught = await captureThrow(() => openRepository({ cwd: ours }));

        // Assert — git
        expect(g.ok).toBe(false);
        expect(g.stderr).toContain("bad boolean config value 'maybe' for 'core.bare'");
        // Assert — tsgit
        const data = asBadBoolean(caught);
        expect(data.code).toBe('CONFIG_BAD_BOOLEAN_VALUE');
        expect(data.key).toBe('core.bare');
        expect(data.value).toBe('maybe');
      });
    });

    describe('When git config --list runs and tsgit opens the repository', () => {
      it('Then both refuse — the open-time refusal precedes any config porcelain call', async () => {
        // Arrange & Act — armed in beforeEach. Open-time refusal means a
        // single `openRepository` throw subsumes both porcelain calls: there
        // is no Repository handle to invoke `config.list()`/`config.get()` on.
        const g = tryRunGitWithExit(['-C', ours, 'config', '--list'], { env: runGitEnv() });
        const gGet = tryRunGitWithExit(['-C', ours, 'config', '--get', 'core.bare'], {
          env: runGitEnv(),
        });
        const caught = await captureThrow(() => openRepository({ cwd: ours }));

        // Assert — git, pinned to the exact refusal (any other failure —
        // ownership, a different config fault — must not satisfy this row)
        expect(g.exitCode).toBe(128);
        expect(g.stderr).toContain("bad boolean config value 'maybe' for 'core.bare'");
        expect(gGet.exitCode).toBe(128);
        expect(gGet.stderr).toContain("bad boolean config value 'maybe' for 'core.bare'");
        // Assert — tsgit
        expect(asBadBoolean(caught).code).toBe('CONFIG_BAD_BOOLEAN_VALUE');
      });
    });
  });

  describe('Given a T2 key on an earlier line than a malformed T1 key', () => {
    beforeEach(() =>
      writeConfig(
        '[core]\n\trepositoryformatversion = 0\n\tsparseCheckout = maybe\n\tbare = maybe\n',
      ),
    );

    describe('When git status and tsgit status run', () => {
      it('Then both name core.bare — the discovery pass precedes the default-config pass', async () => {
        // Arrange & Act — armed in beforeEach. Open time precedes the first
        // command either way, so the ordering guarantee survives the move.
        const g = tryRunGitWithExit(['-C', ours, 'status'], { env: runGitEnv() });
        const caught = await captureThrow(() => openRepository({ cwd: ours }));

        // Assert — git
        expect(g.exitCode).toBe(128);
        expect(g.stderr).toContain("bad boolean config value 'maybe' for 'core.bare'");
        // Assert — tsgit
        const data = asBadBoolean(caught);
        expect(data.code).toBe('CONFIG_BAD_BOOLEAN_VALUE');
        expect(data.key).toBe('core.bare');
      });
    });
  });

  describe('Given X12 — core.sparseCheckout = maybe (T2)', () => {
    beforeEach(() =>
      writeConfig('[core]\n\trepositoryformatversion = 0\n\tsparseCheckout = maybe\n'),
    );

    describe('When git status and tsgit status run', () => {
      it('Then both refuse with exit 128 / CONFIG_BAD_BOOLEAN_VALUE naming core.sparsecheckout', async () => {
        // Arrange & Act — armed in beforeEach
        const g = tryRunGit(['-C', ours, 'status'], { env: runGitEnv() });
        const caught = await withRepo(ours, (repo) => captureThrow(() => repo.status()));

        // Assert — git
        expect(g.ok).toBe(false);
        expect(g.stderr).toContain("bad boolean config value 'maybe' for 'core.sparsecheckout'");
        // Assert — tsgit
        const data = asBadBoolean(caught);
        expect(data.code).toBe('CONFIG_BAD_BOOLEAN_VALUE');
        expect(data.key).toBe('core.sparsecheckout');
      });
    });

    describe('When git config --get and tsgit config porcelain run', () => {
      it('Then both STILL succeed — the porcelain survives the T2 boundary', async () => {
        // Arrange & Act — armed in beforeEach
        const g = tryRunGit(['-C', ours, 'config', '--get', 'core.sparsecheckout'], {
          env: runGitEnv(),
        });
        const result = await withRepo(ours, (repo) =>
          repo.config.get({ key: 'core.sparsecheckout' }),
        );

        // Assert — git
        expect(g.ok).toBe(true);
        expect(g.stdout.trim()).toBe('maybe');
        // Assert — tsgit
        expect(result.value).toBe('maybe');
      });
    });
  });

  describe('Given X13 — commit.gpgSign = maybe (T3)', () => {
    const USER_CONFIG = '[user]\n\tname = Ada\n\temail = ada@example.com\n';

    beforeEach(async () => {
      // A base commit under a config WITHOUT the malformed key first, so
      // status/log have real history to report on once the tier is armed.
      await writeConfig(USER_CONFIG);
      await writeFile(path.join(ours, 'a.txt'), 'a');
      runGit(['-C', ours, 'add', 'a.txt']);
      runGit(['-C', ours, 'commit', '-q', '-m', 'base'], { env: runGitEnv() });
      // Arm the T3 key and stage a second change so the refusal has real work to refuse.
      await writeConfig(`${USER_CONFIG}[commit]\n\tgpgSign = maybe\n`);
      await writeFile(path.join(ours, 'b.txt'), 'b');
      runGit(['-C', ours, 'add', 'b.txt']);
    });

    describe('When git commit and tsgit commit run', () => {
      it('Then both refuse with exit 128 / CONFIG_BAD_BOOLEAN_VALUE naming commit.gpgsign', async () => {
        // Arrange & Act — armed in beforeEach
        const g = tryRunGit(['-C', ours, 'commit', '-q', '-m', 'second'], { env: runGitEnv() });
        const caught = await withRepo(ours, (repo) =>
          captureThrow(() => repo.commit({ message: 'second' })),
        );

        // Assert — git
        expect(g.ok).toBe(false);
        expect(g.stderr).toContain("bad boolean config value 'maybe' for 'commit.gpgsign'");
        // Assert — tsgit
        const data = asBadBoolean(caught);
        expect(data.code).toBe('CONFIG_BAD_BOOLEAN_VALUE');
        expect(data.key).toBe('commit.gpgsign');
      });
    });

    describe('When git status/log and tsgit status/log run', () => {
      it('Then neither refuses — commit.gpgsign is T3, unrelated commands must not refuse', async () => {
        // Arrange & Act — armed in beforeEach
        const gStatus = tryRunGit(['-C', ours, 'status', '--porcelain'], { env: runGitEnv() });
        const gLog = tryRunGit(['-C', ours, 'log', '--oneline'], { env: runGitEnv() });
        const statusCaught = await withRepo(ours, (repo) => captureThrow(() => repo.status()));
        const logCaught = await withRepo(ours, (repo) => captureThrow(() => repo.log()));

        // Assert — git
        expect(gStatus.ok).toBe(true);
        expect(gLog.ok).toBe(true);
        // Assert — tsgit
        expect(statusCaught).toBeUndefined();
        expect(logCaught).toBeUndefined();
      });
    });
  });

  describe('Given X14 — core.bare = 2 (accepted integer)', () => {
    beforeEach(() => writeConfig('[core]\n\trepositoryformatversion = 0\n\tbare = 2\n'));

    describe('When git add and tsgit add run', () => {
      it('Then neither refuses the value — both now report the repository as bare', async () => {
        // Arrange & Act — armed in beforeEach
        const g = tryRunGit(['-C', ours, 'add', 'nope.txt'], { env: runGitEnv() });
        const caught = await withRepo(ours, (repo) => captureThrow(() => repo.add(['nope.txt'])));

        // Assert — git: refuses for the missing-work-tree reason, not a
        // boolean-grammar reason
        expect(g.ok).toBe(false);
        expect(g.stderr).toContain('this operation must be run in a work tree');
        expect(g.stderr).not.toContain('bad boolean config value');
        // Assert — tsgit: same class of refusal — WORK_TREE_REQUIRED, not a
        // boolean-grammar throw. `layout.bare` is fixed at open time from
        // `core.bare = 2` (a valid boolean, true), so `add` refuses for
        // missing work tree, matching git's own message exactly.
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data;
        expect(data.code).toBe('WORK_TREE_REQUIRED');
      });
    });
  });

  describe('Given X15 — push.gpgSign = maybe (T3, distinct message)', () => {
    beforeEach(async () => {
      await writeConfig(
        '[user]\n\tname = Ada\n\temail = ada@example.com\n' +
          '[remote "origin"]\n\turl = https://example.invalid/r.git\n' +
          '[branch "main"]\n\tremote = origin\n\tmerge = refs/heads/main\n' +
          '[push]\n\tgpgSign = maybe\n',
      );
      await writeFile(path.join(ours, 'a.txt'), 'a');
      runGit(['-C', ours, 'add', 'a.txt']);
      runGit(['-C', ours, 'commit', '-q', '-m', 'base'], { env: runGitEnv() });
    });

    describe('When git push and tsgit push run', () => {
      it('Then both refuse — git with "invalid value for \'push.gpgsign\'", tsgit with CONFIG_BAD_BOOLEAN_LITERAL', async () => {
        // Arrange & Act — armed in beforeEach
        const g = tryRunGit(['-C', ours, 'push', 'origin', 'main'], { env: runGitEnv() });
        const repo = await openRepository({
          cwd: ours,
          transport: receivePackDiscoveryOnlyTransport('refs/heads/main', ZERO_OID),
          config: { allowPrivateNetworks: true, dnsResolver: async () => ['127.0.0.1'] },
        });
        let caught: unknown;
        try {
          caught = await captureThrow(() => repo.push({ remote: 'origin' }));
        } finally {
          await repo.dispose();
        }

        // Assert — git
        expect(g.ok).toBe(false);
        expect(g.stderr).toContain("invalid value for 'push.gpgsign'");
        // Assert — tsgit
        const data = asBadBoolean(caught);
        expect(data.code).toBe('CONFIG_BAD_BOOLEAN_LITERAL');
        expect(data.key).toBe('push.gpgsign');
      });
    });

    describe('When git status and tsgit status run', () => {
      it('Then neither refuses — push.gpgsign is T3, status must not refuse', async () => {
        // Arrange & Act — armed in beforeEach
        const g = tryRunGit(['-C', ours, 'status', '--porcelain'], { env: runGitEnv() });
        const caught = await withRepo(ours, (repo) => captureThrow(() => repo.status()));

        // Assert
        expect(g.ok).toBe(true);
        expect(caught).toBeUndefined();
      });
    });
  });

  describe('X16 — cross-class line-order tie-break (T2 boolean vs. missing-value)', () => {
    describe('Given core.sparseCheckout (line 3) precedes valueless core.excludesFile (line 4)', () => {
      describe('When git status and tsgit status run', () => {
        it('Then both tools name core.sparsecheckout — tsgit throws CONFIG_BAD_BOOLEAN_VALUE', async () => {
          // Arrange
          await writeConfig(
            '[core]\n\trepositoryformatversion = 0\n\tsparseCheckout = maybe\n\texcludesFile\n',
          );

          // Act
          const g = tryRunGit(['-C', ours, 'status'], { env: runGitEnv() });
          const caught = await withRepo(ours, (repo) => captureThrow(() => repo.status()));

          // Assert — git
          expect(g.ok).toBe(false);
          expect(g.stderr).toContain("bad boolean config value 'maybe' for 'core.sparsecheckout'");
          // Assert — tsgit
          const data = asBadBoolean(caught);
          expect(data.code).toBe('CONFIG_BAD_BOOLEAN_VALUE');
          expect(data.key).toBe('core.sparsecheckout');
        });
      });
    });

    describe('Given valueless core.excludesFile (line 3) precedes core.sparseCheckout (line 4)', () => {
      describe('When git status and tsgit status run', () => {
        it('Then both tools name core.excludesfile — tsgit throws CONFIG_MISSING_VALUE', async () => {
          // Arrange
          await writeConfig(
            '[core]\n\trepositoryformatversion = 0\n\texcludesFile\n\tsparseCheckout = maybe\n',
          );

          // Act
          const g = tryRunGit(['-C', ours, 'status'], { env: runGitEnv() });
          const caught = await withRepo(ours, (repo) => captureThrow(() => repo.status()));

          // Assert — git
          expect(g.ok).toBe(false);
          expect(g.stderr).toContain("missing value for 'core.excludesfile'");
          expect(g.stderr).toContain('at line 3');
          // Assert — tsgit
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data as { code: string; key: string; line: number };
          expect(data.code).toBe('CONFIG_MISSING_VALUE');
          expect(data.key).toBe('core.excludesfile');
          expect(data.line).toBe(3);
        });
      });
    });
  });
  describe('Given X17 — remote.origin.promisor = maybe, the command-split pin', () => {
    beforeEach(() =>
      writeConfig('[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\tpromisor = maybe\n'),
    );

    describe('When git and tsgit each run status (a refusing command)', () => {
      it('Then both refuse naming remote.origin.promisor', async () => {
        // Arrange & Act — armed in beforeEach
        const g = tryRunGitWithExit(['-C', ours, 'status'], { env: runGitEnv() });
        const caught = await withRepo(ours, (repo) => captureThrow(() => repo.status()));

        // Assert — git
        expect(g.exitCode).toBe(128);
        expect(g.stderr).toContain("bad boolean config value 'maybe' for 'remote.origin.promisor'");
        // Assert — tsgit
        const data = asBadBoolean(caught);
        expect(data.code).toBe('CONFIG_BAD_BOOLEAN_VALUE');
        expect(data.key).toBe('remote.origin.promisor');
      });
    });

    describe('When git and tsgit each run log (an accepting command)', () => {
      it('Then both succeed — the promisor read is command-scoped, not repo-wide', async () => {
        // Arrange — log needs history; commit it via git BEFORE arming would
        // hit git's own commit-time refusal, so use a scratch config swap.
        await writeConfig('[core]\n\trepositoryformatversion = 0\n');
        runGit(
          [
            '-C',
            ours,
            '-c',
            'user.name=t',
            '-c',
            'user.email=t@t',
            'commit',
            '--allow-empty',
            '-q',
            '-m',
            'c1',
          ],
          { env: runGitEnv() },
        );
        await writeConfig(
          '[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\tpromisor = maybe\n',
        );

        // Act
        const g = tryRunGitWithExit(['-C', ours, 'log', '--oneline'], { env: runGitEnv() });
        const entries = await withRepo(ours, (repo) => repo.log({ limit: 1 }));

        // Assert
        expect(g.exitCode).toBe(0);
        expect(entries).toHaveLength(1);
      });
    });
  });
  describe('Given X18 — a malformed [filter "zed"].required and a settled stat-clean index, When each tool re-adds then modifies the path', () => {
    it('Then both accept the stat-clean add and both refuse the modified one', async () => {
      // Arrange — commit a file with a healthy config, let the stat cache
      // settle (file mtime strictly older than the index write), THEN arm
      // the malformed driver section.
      await writeConfig('[core]\n\trepositoryformatversion = 0\n');
      await writeFile(path.join(ours, 'f.txt'), 'clean\n');
      // git's racy-clean guard is SECOND-resolution (USE_NSEC off in release
      // builds): the file's mtime must be a strictly older second than the
      // index write for the stat cache to settle.
      await new Promise((r) => setTimeout(r, 1100));
      runGit(['-C', ours, 'add', 'f.txt'], { env: runGitEnv() });
      runGit(
        ['-C', ours, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'c1'],
        { env: runGitEnv() },
      );
      await writeConfig(
        '[core]\n\trepositoryformatversion = 0\n[filter "zed"]\n\trequired = maybe\n',
      );

      // Act + Assert — stat-clean: git converts nothing and exits 0; tsgit
      // takes the same ie_match_stat short-circuit and must not refuse.
      const gClean = tryRunGitWithExit(['-C', ours, 'add', 'f.txt'], { env: runGitEnv() });
      expect(gClean.exitCode).toBe(0);
      await withRepo(ours, (repo) => repo.add(['f.txt']));

      // Act + Assert — modified: the clean conversion engages and both refuse.
      await writeFile(path.join(ours, 'f.txt'), 'changed\n');
      const gDirty = tryRunGitWithExit(['-C', ours, 'add', 'f.txt'], { env: runGitEnv() });
      expect(gDirty.exitCode).toBe(128);
      expect(gDirty.stderr).toContain("bad boolean config value 'maybe' for 'filter.zed.required'");
      const caught = await withRepo(ours, (repo) => captureThrow(() => repo.add(['f.txt'])));
      const data = asBadBoolean(caught);
      expect(data.code).toBe('CONFIG_BAD_BOOLEAN_VALUE');
      expect(data.key).toBe('filter.zed.required');
    }, 60_000);
  });
});
