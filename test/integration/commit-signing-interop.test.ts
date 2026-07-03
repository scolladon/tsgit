/**
 * Cross-tool interop — commit signing (`-S` / `commit.gpgsign`) faithfulness.
 *
 * Pins: a deterministic canned signer (recorded via a `gpg.program` /
 * `gpg.ssh.program` script) produces byte-identical commit objects between
 * tsgit and real git; the signer receives the unsigned payload (no `gpgsig`
 * header) on stdin; the ssh format invokes the program with the documented
 * `-Y sign -n git -f <selector> <file>` argv shape; a real GnuPG key produces
 * a signature `git verify-commit` accepts; and both tools refuse identically
 * when the signer exits non-zero.
 *
 * Isolation: `GNUPGHOME` points at a per-suite scratch dir (never the
 * developer's real keyring), saved/restored around the suite the same way
 * `ssh-transport-interop.test.ts` saves/restores `GIT_SSH_COMMAND`. Every git
 * invocation still goes through `runGit`'s `GIT_*` scrub + `GIT_CONFIG_NOSYSTEM=1`.
 */
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/index.js';
import { add } from '../../src/application/commands/add.js';
import { commit } from '../../src/application/commands/commit.js';
import { __resetConfigCacheForTests } from '../../src/application/primitives/config-read.js';
import { readObject } from '../../src/application/primitives/read-object.js';
import { TsgitError } from '../../src/domain/index.js';
import type { AuthorIdentity } from '../../src/domain/objects/index.js';
import { GIT_AVAILABLE, git, runGit, runGitEnv, tryRunGit } from './interop-helpers.js';

const SETUP_TIMEOUT = 60_000;

const hasGpg = (): boolean => {
  try {
    execFileSync('gpg', ['--version']);
    return true;
  } catch {
    return false;
  }
};

const GPG_AVAILABLE = hasGpg();

const FIXED_EPOCH = 1_700_050_000;

const author: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: FIXED_EPOCH,
  timezoneOffset: '+0000',
};

// The signer's raw stdout (as gpg / ssh-keygen actually emit it, terminated
// by a trailing newline). Both tsgit and real git strip that one trailing
// newline when embedding the armor as the commit's gpgsig header — see
// CANNED_ARMOR_STORED / CANNED_SSH_ARMOR_STORED below for the stored form.
const CANNED_ARMOR =
  '-----BEGIN PGP SIGNATURE-----\n\niQEzBAAA/CANNEDSIGNATUREBLOCK==\n-----END PGP SIGNATURE-----\n';
const CANNED_SSH_ARMOR =
  '-----BEGIN SSH SIGNATURE-----\nU1NIU0lHAAAAAQAAADMAAAALc3NoLWVkMjU1MTkAAAAg\n-----END SSH SIGNATURE-----\n';
const CANNED_ARMOR_STORED = CANNED_ARMOR.slice(0, -1);
const CANNED_SSH_ARMOR_STORED = CANNED_SSH_ARMOR.slice(0, -1);

const gitDateEnv = (): NodeJS.ProcessEnv => ({
  ...runGitEnv(),
  GIT_AUTHOR_NAME: author.name,
  GIT_AUTHOR_EMAIL: author.email,
  GIT_COMMITTER_NAME: author.name,
  GIT_COMMITTER_EMAIL: author.email,
  GIT_AUTHOR_DATE: `${FIXED_EPOCH} +0000`,
  GIT_COMMITTER_DATE: `${FIXED_EPOCH} +0000`,
});

describe.skipIf(!GIT_AVAILABLE || !GPG_AVAILABLE)('commit signing interop', () => {
  let scriptsDir = '';
  let gitDir = '';
  let tsDir = '';
  let gnupgHome = '';
  let previousGnupgHome: string | undefined;
  let ctx: ReturnType<typeof createNodeContext>;

  let openpgpRecorder = '';
  let openpgpRecorderLog = '';
  let sshRecorder = '';
  let sshRecorderLog = '';
  let failSigner = '';
  let fakeSshKey = '';

  const initPeer = (dir: string): void => {
    runGit(['init', '-q', '-b', 'main', dir]);
    runGit(['-C', dir, 'config', 'user.name', author.name]);
    runGit(['-C', dir, 'config', 'user.email', author.email]);
    runGit(['-C', dir, 'config', 'commit.gpgsign', 'false']);
  };

  beforeAll(async () => {
    scriptsDir = await realpath(
      await mkdtemp(path.join(os.tmpdir(), 'tsgit-commit-signing-scripts-')),
    );
    gitDir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-commit-signing-git-')));
    tsDir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-commit-signing-ts-')));
    // GnuPG's agent socket path is derived from GNUPGHOME and is subject to
    // the platform UNIX-socket path-length limit (~104-108 bytes) — the
    // os.tmpdir() prefix (e.g. macOS's /private/var/folders/.../T/) is often
    // already close to that limit, so gnupgHome uses the shorter /tmp root
    // directly rather than os.tmpdir().
    gnupgHome = await realpath(await mkdtemp('/tmp/tsgit-cs-gnupg-'));
    await chmod(gnupgHome, 0o700);
    previousGnupgHome = process.env.GNUPGHOME;
    process.env.GNUPGHOME = gnupgHome;

    initPeer(gitDir);
    initPeer(tsDir);
    runGit(['-C', tsDir, 'config', 'user.signingKey', 'TSGITTESTKEY']);
    ctx = createNodeContext({ workDir: tsDir });

    // Deterministic openpgp recorder: captures the signer's stdin, emits
    // SIG_CREATED on the status-fd (real git refuses without it) and a fixed
    // armor block on stdout, exit 0 — ignores its own argv entirely.
    openpgpRecorderLog = path.join(scriptsDir, 'openpgp-recorder-stdin.log');
    openpgpRecorder = path.join(scriptsDir, 'openpgp-recorder.sh');
    await writeFile(
      openpgpRecorder,
      [
        '#!/bin/sh',
        `cat > "${openpgpRecorderLog}"`,
        "echo '[GNUPG:] SIG_CREATED D 22 10 00 1700000000 CANNEDFPR0123456789' >&2",
        `printf '%s' '${CANNED_ARMOR}'`,
        '',
      ].join('\n'),
    );
    await chmod(openpgpRecorder, 0o755);

    // Deterministic ssh recorder: logs its argv, writes a fixed armor block to
    // <last-positional-arg>.sig (the payload temp file signWithSsh passes).
    sshRecorderLog = path.join(scriptsDir, 'ssh-recorder-argv.log');
    sshRecorder = path.join(scriptsDir, 'ssh-recorder.sh');
    await writeFile(
      sshRecorder,
      [
        '#!/bin/bash',
        `echo "$@" > "${sshRecorderLog}"`,
        'for last in "$@"; do :; done',
        `printf '%s' '${CANNED_SSH_ARMOR}' > "$last.sig"`,
        'exit 0',
        '',
      ].join('\n'),
    );
    await chmod(sshRecorder, 0o755);

    failSigner = path.join(scriptsDir, 'fail-signer.sh');
    await writeFile(failSigner, '#!/bin/sh\nexit 1\n');
    await chmod(failSigner, 0o755);

    fakeSshKey = path.join(scriptsDir, 'id_fake');
    await writeFile(fakeSshKey, 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFAKE fake@example.com\n');
  }, SETUP_TIMEOUT);

  afterAll(async () => {
    if (previousGnupgHome === undefined) delete process.env.GNUPGHOME;
    else process.env.GNUPGHOME = previousGnupgHome;
    await rm(scriptsDir, { recursive: true, force: true });
    await rm(gitDir, { recursive: true, force: true });
    await rm(tsDir, { recursive: true, force: true });
    await rm(gnupgHome, { recursive: true, force: true });
  });

  afterEach(() => __resetConfigCacheForTests());

  describe('Given real git and tsgit both wired to the same canned openpgp recorder', () => {
    describe('When git commits with -S and tsgit commits with sign: true', () => {
      it('Then the two commit objects are byte-identical (same OID)', async () => {
        // Arrange
        runGit(['-C', gitDir, 'config', 'gpg.program', openpgpRecorder]);
        runGit(['-C', tsDir, 'config', 'gpg.program', openpgpRecorder]);
        await writeFile(path.join(gitDir, 'a.txt'), 'hello\n');
        await writeFile(path.join(tsDir, 'a.txt'), 'hello\n');

        // Act — real git golden
        git(gitDir, 'add', 'a.txt');
        runGit(['-C', gitDir, 'commit', '-q', '-S', '-m', 'signed commit'], {
          env: gitDateEnv(),
        });
        const gitOid = git(gitDir, 'rev-parse', 'HEAD').trim();

        // Act — tsgit
        await add(ctx, ['a.txt']);
        const result = await commit(ctx, { message: 'signed commit', author, sign: true });

        // Assert
        expect(result.id).toBe(gitOid);
        const stored = await readObject(ctx, result.id);
        if (stored.type !== 'commit') throw new Error('expected a commit object');
        expect(stored.data.gpgSignature).toBe(CANNED_ARMOR_STORED);
      });
    });
  });

  describe('Given the canned openpgp recorder wired as gpg.program', () => {
    describe('When tsgit commits with sign: true', () => {
      it('Then the signer receives the unsigned payload on stdin — no gpgsig header', async () => {
        // Arrange
        runGit(['-C', tsDir, 'config', 'gpg.program', openpgpRecorder]);
        await writeFile(path.join(tsDir, 'payload-check.txt'), 'payload\n');
        await add(ctx, ['payload-check.txt']);

        // Act
        await commit(ctx, { message: 'payload check commit', author, sign: true });

        // Assert
        const stdinCaptured = await readFile(openpgpRecorderLog, 'utf8');
        expect(stdinCaptured).toContain('payload check commit');
        expect(stdinCaptured).not.toContain('gpgsig');
      });
    });
  });

  describe('Given gpg.format=ssh and the canned ssh recorder wired as gpg.ssh.program', () => {
    describe('When tsgit commits with sign: true and signKey pointing at a key file', () => {
      it('Then the recorder is invoked as "-Y sign -n git -f <selector> <file>" and the armor round-trips', async () => {
        // Arrange
        runGit(['-C', tsDir, 'config', 'gpg.format', 'ssh']);
        runGit(['-C', tsDir, 'config', 'gpg.ssh.program', sshRecorder]);
        await writeFile(path.join(tsDir, 'ssh-check.txt'), 'ssh\n');
        await add(ctx, ['ssh-check.txt']);

        // Act
        const result = await commit(ctx, {
          message: 'ssh signed commit',
          author,
          sign: true,
          signKey: fakeSshKey,
        });

        // Assert — invocation shape
        const argv = (await readFile(sshRecorderLog, 'utf8')).trim();
        const tokens = argv.split(/\s+/);
        expect(tokens.slice(0, 5)).toEqual(['-Y', 'sign', '-n', 'git', '-f']);
        expect(tokens[5]).toBe(fakeSshKey);

        // Assert — armor round-trips into the stored commit object
        const stored = await readObject(ctx, result.id);
        if (stored.type !== 'commit') throw new Error('expected a commit object');
        expect(stored.data.gpgSignature).toBe(CANNED_SSH_ARMOR_STORED);
      });
    });
  });

  describe('Given a real GnuPG signing key generated in an isolated GNUPGHOME', () => {
    describe('When tsgit commits with sign: true and signKey set to the key fingerprint', () => {
      it('Then git verify-commit accepts the resulting signature', async () => {
        // Arrange — real gpg.program (undo the recorder wiring from earlier tests)
        // and generate a fresh signing-capable key with no passphrase.
        runGit(['-C', tsDir, 'config', 'gpg.format', 'openpgp']);
        runGit(['-C', tsDir, 'config', 'gpg.program', 'gpg']);
        execFileSync('gpg', [
          '--batch',
          '--pinentry-mode',
          'loopback',
          '--passphrase',
          '',
          '--quick-generate-key',
          `${author.name} <${author.email}>`,
          'ed25519',
          'sign',
          'never',
        ]);
        const fingerprint = execFileSync('gpg', ['--list-secret-keys', '--with-colons'])
          .toString()
          .split('\n')
          .find((line) => line.startsWith('fpr:'))
          ?.split(':')[9];
        if (!fingerprint) throw new Error('expected gpg to report a generated key fingerprint');
        await writeFile(path.join(tsDir, 'real-gpg-check.txt'), 'real\n');
        await add(ctx, ['real-gpg-check.txt']);

        // Act
        const result = await commit(ctx, {
          message: 'real gpg signed commit',
          author,
          sign: true,
          signKey: fingerprint,
        });

        // Assert — structurally valid signature per real gpg
        const stored = await readObject(ctx, result.id);
        if (stored.type !== 'commit') throw new Error('expected a commit object');
        expect(stored.data.gpgSignature).toContain('-----BEGIN PGP SIGNATURE-----');

        const verify = tryRunGit(['-C', tsDir, 'verify-commit', result.id], {
          env: { ...runGitEnv(), GNUPGHOME: gnupgHome },
        });
        expect(verify.ok).toBe(true);
      });
    });
  });

  describe('Given both peers wired to an always-failing signer', () => {
    describe('When git commits with -S and tsgit commits with sign: true', () => {
      it('Then both refuse and neither writes a new commit', async () => {
        // Arrange
        runGit(['-C', gitDir, 'config', 'gpg.program', failSigner]);
        runGit(['-C', tsDir, 'config', 'gpg.format', 'openpgp']);
        runGit(['-C', tsDir, 'config', 'gpg.program', failSigner]);
        const gitHeadBefore = git(gitDir, 'rev-parse', 'HEAD').trim();
        const tsHeadBefore = git(tsDir, 'rev-parse', 'HEAD').trim();
        await writeFile(path.join(gitDir, 'fail-check.txt'), 'fail\n');
        await writeFile(path.join(tsDir, 'fail-check.txt'), 'fail\n');
        git(gitDir, 'add', 'fail-check.txt');
        await add(ctx, ['fail-check.txt']);

        // Act — real git golden refusal
        const gitResult = tryRunGit(['-C', gitDir, 'commit', '-q', '-S', '-m', 'should fail'], {
          env: gitDateEnv(),
        });

        // Act — tsgit refusal
        let caught: unknown;
        try {
          await commit(ctx, { message: 'should fail', author, sign: true });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(gitResult.ok).toBe(false);
        expect(caught).toBeInstanceOf(TsgitError);
        const error = caught as TsgitError;
        expect(error.data).toEqual({
          code: 'SIGNING_FAILED',
          reason: 'signer-failed',
          format: 'openpgp',
        });
        expect(git(gitDir, 'rev-parse', 'HEAD').trim()).toBe(gitHeadBefore);
        expect(git(tsDir, 'rev-parse', 'HEAD').trim()).toBe(tsHeadBefore);
      });
    });
  });
});
