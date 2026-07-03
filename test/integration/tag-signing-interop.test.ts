/**
 * Cross-tool interop — tag signing (`tag -s` / `tag.gpgSign`) faithfulness.
 *
 * Pins: a deterministic canned signer (recorded via a `gpg.program` script)
 * produces byte-identical annotated tag objects between tsgit and real git —
 * including the *untrimmed* trailing newline in the stored armor. Unlike a
 * commit's `gpgsig` header value, a tag's signature is appended straight onto
 * the message body with no trailing-newline trim, so this suite is the
 * durable, automated pin for that divergence from the commit path. Also
 * pins: the signer receives the unsigned tag payload (message only, no
 * signature) on stdin; a real GnuPG key produces a signature `git verify-tag`
 * accepts; and both tools refuse identically — writing no tag ref — when the
 * signer exits non-zero.
 *
 * Isolation: `GNUPGHOME` points at a per-suite scratch dir (never the
 * developer's real keyring), saved/restored around the suite. Every git
 * invocation still goes through `runGit`'s `GIT_*` scrub + `GIT_CONFIG_NOSYSTEM=1`.
 */
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/index.js';
import { tagCreate } from '../../src/application/commands/tag.js';
import { __resetConfigCacheForTests } from '../../src/application/primitives/config-read.js';
import { readObject } from '../../src/application/primitives/read-object.js';
import { TsgitError } from '../../src/domain/index.js';
import { GIT_AVAILABLE, runGit, runGitEnv, tryRunGit } from './interop-helpers.js';

const SETUP_TIMEOUT = 60_000;
const PINNED_UNIX = 1_700_050_000;
const IDENTITY_NAME = 'Ada';
const IDENTITY_EMAIL = 'ada@example.com';

const hasGpg = (): boolean => {
  try {
    execFileSync('gpg', ['--version']);
    return true;
  } catch {
    return false;
  }
};

const GPG_AVAILABLE = hasGpg();

// The signer's raw stdout, terminated by a trailing newline — a tag stores
// this armor byte-for-byte in its message body, with no trim (contrast the
// commit path's CANNED_ARMOR_STORED, which drops that trailing newline).
const CANNED_ARMOR =
  '-----BEGIN PGP SIGNATURE-----\n\niQEzBAAA/CANNEDSIGNATUREBLOCK==\n-----END PGP SIGNATURE-----\n';

/** git env with a pinned tagger identity/date — tagCreate resolves the tagger the same way. */
const pinnedEnv = (): NodeJS.ProcessEnv => ({
  ...runGitEnv(),
  GIT_AUTHOR_NAME: IDENTITY_NAME,
  GIT_AUTHOR_EMAIL: IDENTITY_EMAIL,
  GIT_AUTHOR_DATE: `${PINNED_UNIX} +0000`,
  GIT_COMMITTER_NAME: IDENTITY_NAME,
  GIT_COMMITTER_EMAIL: IDENTITY_EMAIL,
  GIT_COMMITTER_DATE: `${PINNED_UNIX} +0000`,
});

describe.skipIf(!GIT_AVAILABLE || !GPG_AVAILABLE)('tag signing interop', () => {
  let scriptsDir = '';
  let gitDir = '';
  let tsDir = '';
  let gnupgHome = '';
  let previousGnupgHome: string | undefined;
  let ctx: ReturnType<typeof createNodeContext>;

  let openpgpRecorder = '';
  let openpgpRecorderLog = '';
  let failSigner = '';

  const initPeer = (dir: string): void => {
    runGit(['init', '-q', '-b', 'main', dir]);
    runGit(['-C', dir, 'config', 'user.name', IDENTITY_NAME]);
    runGit(['-C', dir, 'config', 'user.email', IDENTITY_EMAIL]);
  };

  /** Seed a fresh matching empty commit (pinned identity/date) in both peer and ours. */
  const seedMatchingRootCommit = (): string => {
    const env = pinnedEnv();
    runGit(['-C', gitDir, 'commit', '-q', '--allow-empty', '-m', 'seed'], { env });
    runGit(['-C', tsDir, 'commit', '-q', '--allow-empty', '-m', 'seed'], { env });
    const gitSha = runGit(['-C', gitDir, 'rev-parse', 'HEAD']).trim();
    const tsSha = runGit(['-C', tsDir, 'rev-parse', 'HEAD']).trim();
    expect(tsSha).toBe(gitSha);
    return gitSha;
  };

  beforeAll(async () => {
    scriptsDir = await realpath(
      await mkdtemp(path.join(os.tmpdir(), 'tsgit-tag-signing-scripts-')),
    );
    gitDir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-tag-signing-git-')));
    tsDir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-tag-signing-ts-')));
    // See commit-signing-interop.test.ts for why gnupgHome uses /tmp directly
    // rather than os.tmpdir() — the agent socket path has a platform length limit.
    gnupgHome = await realpath(await mkdtemp('/tmp/tsgit-ts-gnupg-'));
    await chmod(gnupgHome, 0o700);
    previousGnupgHome = process.env.GNUPGHOME;
    process.env.GNUPGHOME = gnupgHome;

    initPeer(gitDir);
    initPeer(tsDir);
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

    failSigner = path.join(scriptsDir, 'fail-signer.sh');
    await writeFile(failSigner, '#!/bin/sh\nexit 1\n');
    await chmod(failSigner, 0o755);
  }, SETUP_TIMEOUT);

  afterAll(async () => {
    if (previousGnupgHome === undefined) delete process.env.GNUPGHOME;
    else process.env.GNUPGHOME = previousGnupgHome;
    await rm(scriptsDir, { recursive: true, force: true });
    await rm(gitDir, { recursive: true, force: true });
    await rm(tsDir, { recursive: true, force: true });
    await rm(gnupgHome, { recursive: true, force: true });
  });

  afterEach(() => {
    __resetConfigCacheForTests();
    vi.useRealTimers();
  });

  describe('Given real git and tsgit both wired to the same canned openpgp recorder', () => {
    describe('When git tags with tag -s -m and tsgit tags with sign: true', () => {
      it('Then the two tag objects are byte-identical, including the untrimmed signer newline', async () => {
        // Arrange
        runGit(['-C', gitDir, 'config', 'gpg.program', openpgpRecorder]);
        runGit(['-C', tsDir, 'config', 'gpg.program', openpgpRecorder]);
        const commitSha = seedMatchingRootCommit();

        // Act — real git golden
        runGit(['-C', gitDir, 'tag', '-s', '-m', 'signed tag', 'v1', commitSha], {
          env: pinnedEnv(),
        });
        const gitTagSha = runGit(['-C', gitDir, 'rev-parse', 'v1']).trim();

        // Act — tsgit
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(PINNED_UNIX * 1000);
        const result = await tagCreate(ctx, {
          name: 'v1',
          target: commitSha,
          message: 'signed tag',
          sign: true,
        });

        // Assert
        expect(result.id).toBe(gitTagSha);
        const peerOut = runGit(['-C', gitDir, 'cat-file', '-p', gitTagSha]);
        const oursOut = runGit(['-C', tsDir, 'cat-file', '-p', result.id]);
        expect(oursOut).toBe(peerOut);
        const stored = await readObject(ctx, result.id);
        if (stored.type !== 'tag') throw new Error('expected a tag object');
        expect(stored.data.gpgSignature).toBe(CANNED_ARMOR);
      });
    });
  });

  describe('Given the canned openpgp recorder wired as gpg.program', () => {
    describe('When tsgit tags with sign: true', () => {
      it('Then the signer receives the unsigned payload on stdin — no signature armor', async () => {
        // Arrange
        runGit(['-C', tsDir, 'config', 'gpg.program', openpgpRecorder]);
        const commitSha = seedMatchingRootCommit();
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(PINNED_UNIX * 1000);

        // Act
        await tagCreate(ctx, {
          name: 'v-payload',
          target: commitSha,
          message: 'payload check tag',
          sign: true,
        });

        // Assert
        const stdinCaptured = await readFile(openpgpRecorderLog, 'utf8');
        expect(stdinCaptured).toContain('payload check tag');
        expect(stdinCaptured).not.toContain('BEGIN PGP SIGNATURE');
      });
    });
  });

  describe('Given a real GnuPG signing key generated in an isolated GNUPGHOME', () => {
    describe('When tsgit tags with sign: true and signKey set to the key fingerprint', () => {
      it('Then git verify-tag accepts the resulting signature', async () => {
        // Arrange — real gpg.program (undo the recorder wiring from earlier
        // tests) and generate a fresh signing-capable key with no passphrase.
        runGit(['-C', tsDir, 'config', 'gpg.format', 'openpgp']);
        runGit(['-C', tsDir, 'config', 'gpg.program', 'gpg']);
        execFileSync('gpg', [
          '--batch',
          '--pinentry-mode',
          'loopback',
          '--passphrase',
          '',
          '--quick-generate-key',
          `${IDENTITY_NAME} <${IDENTITY_EMAIL}>`,
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
        const commitSha = seedMatchingRootCommit();
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(PINNED_UNIX * 1000);

        // Act
        const result = await tagCreate(ctx, {
          name: 'v-real-gpg',
          target: commitSha,
          message: 'real gpg signed tag',
          sign: true,
          signKey: fingerprint,
        });

        // Assert — structurally valid signature per real gpg
        const stored = await readObject(ctx, result.id);
        if (stored.type !== 'tag') throw new Error('expected a tag object');
        expect(stored.data.gpgSignature).toContain('-----BEGIN PGP SIGNATURE-----');

        const verify = tryRunGit(['-C', tsDir, 'verify-tag', 'v-real-gpg'], {
          env: { ...runGitEnv(), GNUPGHOME: gnupgHome },
        });
        expect(verify.ok).toBe(true);
      });
    });
  });

  describe('Given both peers wired to an always-failing signer', () => {
    describe('When git tags with tag -s and tsgit tags with sign: true', () => {
      it('Then both refuse and neither writes a tag ref', async () => {
        // Arrange
        runGit(['-C', gitDir, 'config', 'gpg.program', failSigner]);
        runGit(['-C', tsDir, 'config', 'gpg.format', 'openpgp']);
        runGit(['-C', tsDir, 'config', 'gpg.program', failSigner]);
        const commitSha = seedMatchingRootCommit();

        // Act — real git golden refusal
        const gitResult = tryRunGit(
          ['-C', gitDir, 'tag', '-s', '-m', 'should fail', 'v-fail', commitSha],
          { env: pinnedEnv() },
        );

        // Act — tsgit refusal
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(PINNED_UNIX * 1000);
        let caught: unknown;
        try {
          await tagCreate(ctx, {
            name: 'v-fail',
            target: commitSha,
            message: 'should fail',
            sign: true,
          });
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
        expect(tryRunGit(['-C', gitDir, 'rev-parse', 'refs/tags/v-fail']).ok).toBe(false);
        expect(tryRunGit(['-C', tsDir, 'rev-parse', 'refs/tags/v-fail']).ok).toBe(false);
      });
    });
  });
});
