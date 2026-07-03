/**
 * Cross-tool interop: real git's ssh transport argv vs tsgit's computed
 * `resolveSshCommand` + `buildSshArgs`. A fake ssh recorder script stands in
 * for the ssh program (via each of `GIT_SSH_COMMAND`, `core.sshCommand`, and
 * `GIT_SSH`) and records the argv real git invokes it with; that recording is
 * compared against tsgit's own computation for the same remote URL.
 *
 * Real git auto-detects an "ssh variant" from the resolved program's basename
 * to decide which flags it dares emit; an unrecognised basename (our
 * recorder's) falls back to a conservative "simple" variant that refuses to
 * emit `-p` at all. Forcing `ssh.variant=ssh` makes real git assume the
 * OpenSSH-compatible argv shape tsgit itself always assumes (this transport
 * never does per-variant detection). With that forced, real git's argv is
 * identical to tsgit's except for one pinned, intentional divergence: git
 * 2's default protocol v2 adds `-o SendEnv=GIT_PROTOCOL`, which tsgit (v0/v1
 * only) never emits — that pair is stripped before comparing.
 */
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createMemoryContext } from '../../src/adapters/memory/memory-adapter.js';
import {
  parseRemoteUrl,
  type RemoteUrl,
} from '../../src/application/commands/internal/remote-url.js';
import { buildSshArgs } from '../../src/application/commands/internal/ssh-argv.js';
import { resolveSshCommand } from '../../src/application/commands/internal/ssh-command.js';
import { TsgitError } from '../../src/domain/index.js';
import { GIT_AVAILABLE, runGitEnv, tryRunGit } from './interop-helpers.js';

type SshRemoteUrl = Extract<RemoteUrl, { kind: 'ssh' }>;

const SEND_ENV_OPTION = '-o';
const SEND_ENV_VALUE = 'SendEnv=GIT_PROTOCOL';

/** Remove real git's protocol-v2 `-o SendEnv=GIT_PROTOCOL` pair — the one pinned, intentional divergence. */
const stripSendEnv = (argv: ReadonlyArray<string>): ReadonlyArray<string> => {
  const index = argv.findIndex(
    (token, i) => token === SEND_ENV_OPTION && argv[i + 1] === SEND_ENV_VALUE,
  );
  return index === -1 ? argv : [...argv.slice(0, index), ...argv.slice(index + 2)];
};

const readRecordedArgv = async (logFile: string): Promise<ReadonlyArray<string>> => {
  const raw = await readFile(logFile, 'utf8');
  return raw === '' ? [] : raw.split('\n').slice(0, -1);
};

const installRecorder = async (dir: string, logFile: string): Promise<string> => {
  const scriptPath = path.join(dir, 'record-argv.sh');
  await writeFile(scriptPath, `#!/bin/sh\nprintf '%s\\n' "$@" > "${logFile}"\nexit 1\n`);
  await chmod(scriptPath, 0o755);
  return scriptPath;
};

const envOf = (
  map: Readonly<Record<string, string>>,
): { readonly get: (name: string) => string | undefined } => ({
  get: (name) => map[name],
});

const expectStrippedArgvMatches = async (
  logFile: string,
  ctx: Parameters<typeof resolveSshCommand>[0],
  url: string,
): Promise<void> => {
  const recordedArgv = await readRecordedArgv(logFile);
  const resolved = await resolveSshCommand(ctx);
  const parsed = parseRemoteUrl(url) as SshRemoteUrl;
  const expectedArgv = buildSshArgs({
    service: 'git-upload-pack',
    parsed,
    baseArgs: resolved.baseArgs,
  });
  expect(stripSendEnv(recordedArgv)).toEqual(expectedArgv);
};

describe.skipIf(!GIT_AVAILABLE)('ssh argv interop', () => {
  let dir: string;
  let logFile: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-ssh-argv-interop-'));
    logFile = path.join(dir, 'recorded.txt');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe('Given ssh is resolved via GIT_SSH_COMMAND (shell string carrying an extra base arg, explicit port)', () => {
    describe('When ls-remote drives the recorder over an ssh:// URL', () => {
      it("Then the recorded argv matches tsgit's computed argv modulo the SendEnv divergence", async () => {
        // Arrange
        const url = 'ssh://alice@example.invalid:2222/srv/repo.git';
        const recorder = await installRecorder(dir, logFile);
        const env = { ...runGitEnv(), GIT_SSH_COMMAND: `${recorder} -v` };
        const ctx = createMemoryContext({ env: envOf(env) });

        // Act
        tryRunGit(['-c', 'ssh.variant=ssh', 'ls-remote', url], { env });

        // Assert
        await expectStrippedArgvMatches(logFile, ctx, url);
      });
    });
  });

  describe('Given ssh is resolved via core.sshCommand (shell string carrying an extra base arg, default port)', () => {
    describe('When ls-remote drives the recorder over an ssh:// URL', () => {
      it("Then the recorded argv matches tsgit's computed argv modulo the SendEnv divergence", async () => {
        // Arrange
        const url = 'ssh://bob@example.invalid:22/srv/repo2.git';
        const recorder = await installRecorder(dir, logFile);
        const env = runGitEnv();
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/config`,
          `[core]\n  sshCommand = ${recorder} -v\n`,
        );

        // Act
        tryRunGit(
          ['-c', 'ssh.variant=ssh', '-c', `core.sshCommand=${recorder} -v`, 'ls-remote', url],
          { env },
        );

        // Assert
        await expectStrippedArgvMatches(logFile, ctx, url);
      });
    });
  });

  describe('Given ssh is resolved via GIT_SSH (lone program, no base args, no explicit port)', () => {
    describe('When ls-remote drives the recorder over an ssh:// URL', () => {
      it("Then the recorded argv matches tsgit's computed argv modulo the SendEnv divergence", async () => {
        // Arrange
        const url = 'ssh://carol@example.invalid/srv/repo3.git';
        const recorder = await installRecorder(dir, logFile);
        const env = { ...runGitEnv(), GIT_SSH: recorder };
        const ctx = createMemoryContext({ env: envOf(env) });

        // Act
        tryRunGit(['-c', 'ssh.variant=ssh', 'ls-remote', url], { env });

        // Assert
        await expectStrippedArgvMatches(logFile, ctx, url);
      });
    });
  });

  describe('Given a dash-prefixed host in a scp-like remote URL', () => {
    describe('When both real git and tsgit evaluate the URL', () => {
      it('Then both refuse it with a strange-hostname guard', () => {
        // Arrange
        const url = '-evilhost:/srv/repo.git';

        // Act
        const gitResult = tryRunGit(['ls-remote', '--', url], { env: runGitEnv() });
        let caught: unknown;
        try {
          parseRemoteUrl(url);
        } catch (error) {
          caught = error;
        }

        // Assert
        expect(gitResult.ok).toBe(false);
        expect(gitResult.stderr).toContain('blocked');
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data).toEqual({
          code: 'INVALID_URL',
          reason: expect.stringContaining('blocked'),
        });
      });
    });
  });

  describe('Given a dash-prefixed host in an ssh:// remote URL', () => {
    describe('When both real git and tsgit evaluate the URL', () => {
      it('Then both refuse it with a strange-hostname guard', () => {
        // Arrange
        const url = 'ssh://-oProxyCommand=evil/repo.git';

        // Act
        const gitResult = tryRunGit(['ls-remote', '--', url], { env: runGitEnv() });
        let caught: unknown;
        try {
          parseRemoteUrl(url);
        } catch (error) {
          caught = error;
        }

        // Assert
        expect(gitResult.ok).toBe(false);
        expect(gitResult.stderr).toContain('blocked');
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data).toEqual({
          code: 'INVALID_URL',
          reason: expect.stringContaining('blocked'),
        });
      });
    });
  });

  describe('Given a dash-prefixed path in a scp-like remote URL', () => {
    describe('When both real git and tsgit evaluate the URL', () => {
      it('Then both refuse it with a strange-pathname guard', () => {
        // Arrange
        const url = 'git@example.invalid:-leadingdash/repo.git';

        // Act
        const gitResult = tryRunGit(['ls-remote', '--', url], { env: runGitEnv() });
        let caught: unknown;
        try {
          parseRemoteUrl(url);
        } catch (error) {
          caught = error;
        }

        // Assert
        expect(gitResult.ok).toBe(false);
        expect(gitResult.stderr).toContain('blocked');
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data).toEqual({
          code: 'INVALID_URL',
          reason: expect.stringContaining('blocked'),
        });
      });
    });
  });

  describe('Given a normal scp-like remote URL with no dash-prefixed tokens', () => {
    describe('When both real git and tsgit evaluate the URL', () => {
      it('Then neither refuses it via the dash guard', () => {
        // Arrange
        const url = 'alice@example.invalid:/srv/repo.git';

        // Act
        const gitResult = tryRunGit(['ls-remote', '--', url], { env: runGitEnv() });

        // Assert
        expect(gitResult.stderr).not.toContain('blocked');
        expect(() => parseRemoteUrl(url)).not.toThrow();
      });
    });
  });
});
