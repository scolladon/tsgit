import { afterEach, describe, expect, it, vi } from 'vitest';

import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import {
  resolveSigningSelector,
  signPayload,
  stripCrBeforeLf,
} from '../../../../src/application/primitives/sign-payload.js';
import { TsgitError } from '../../../../src/domain/error.js';
import type { CommandRequest } from '../../../../src/ports/command-runner.js';
import type { Context } from '../../../../src/ports/context.js';
import { stubCommandRunner } from './helpers/stub-command-runner.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

const pgpArmor = (body: string): string =>
  `-----BEGIN PGP SIGNATURE-----\n\n${body}\n-----END PGP SIGNATURE-----\n`;

const sshArmor = (body: string): string =>
  `-----BEGIN SSH SIGNATURE-----\n${body}\n-----END SSH SIGNATURE-----\n`;

/** gpg's status-fd line announcing a created signature, as `--status-fd=2` writes it. */
const SIG_CREATED_LINE = '[GNUPG:] SIG_CREATED D 22 10 00 1700000000 FPR\n';

/** The staged payload file a signer was handed — ssh-keygen's last argument. */
const stagedBuffer = (request: CommandRequest | undefined): string => request?.args?.at(-1) ?? '';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('signPayload', () => {
  describe('Given format openpgp and a runner returning exit 0 with a PGP armor on stdout', () => {
    describe('When signPayload runs', () => {
      it('Then result is ok:true and the armor round-trips the stdout text', async () => {
        // Arrange
        const armor = pgpArmor('c2lnbmF0dXJl');
        const runner = stubCommandRunner({
          exitCode: 0,
          stdout: enc(armor),
          stderr: enc(SIG_CREATED_LINE),
        });
        const ctx = createMemoryContext({ command: runner });

        // Act
        const result = await signPayload(ctx, enc('payload bytes'), {
          format: 'openpgp',
          selector: 'ABCD1234',
        });

        // Assert
        expect(result).toEqual({ ok: true, armor });
      });
    });
  });

  describe('Given format openpgp', () => {
    describe('When signPayload runs', () => {
      it('Then the runner command is "<program> --status-fd=2 -bsau <selector>" and stdin equals the payload bytes', async () => {
        // Arrange
        const armor = pgpArmor('YWJj');
        const runner = stubCommandRunner({
          exitCode: 0,
          stdout: enc(armor),
          stderr: enc(SIG_CREATED_LINE),
        });
        const ctx = createMemoryContext({ command: runner });
        const payload = enc('tree deadbeef\n');

        // Act
        await signPayload(ctx, payload, { format: 'openpgp', selector: 'ABCD1234' });

        // Assert
        const call = runner.calls[0];
        expect([call?.command, call?.args]).toEqual([
          'gpg',
          ['--status-fd=2', '-bsau', 'ABCD1234'],
        ]);
        expect(call?.stdin).toBe(payload);
      });

      it('Then the runner request env carries GIT_DIR set to the repo gitDir', async () => {
        // Arrange
        const runner = stubCommandRunner({
          exitCode: 0,
          stdout: enc(pgpArmor('YWJj')),
          stderr: enc(SIG_CREATED_LINE),
        });
        const ctx = createMemoryContext({ command: runner });

        // Act
        await signPayload(ctx, enc('payload'), { format: 'openpgp', selector: 'ABCD1234' });

        // Assert
        expect(runner.calls[0]?.env).toEqual({ GIT_DIR: ctx.layout.gitDir });
      });
    });
  });

  describe('Given gpg.program is set', () => {
    describe('When signPayload openpgp runs', () => {
      it('Then the command uses that program, not "gpg"', async () => {
        // Arrange
        const armor = pgpArmor('YWJj');
        const runner = stubCommandRunner({
          exitCode: 0,
          stdout: enc(armor),
          stderr: enc(SIG_CREATED_LINE),
        });
        const ctx = createMemoryContext({ command: runner });

        // Act
        await signPayload(ctx, enc('payload'), {
          format: 'openpgp',
          selector: 'ABCD1234',
          program: '/usr/bin/gpg2',
        });

        // Assert
        expect([runner.calls[0]?.command, runner.calls[0]?.args]).toEqual([
          '/usr/bin/gpg2',
          ['--status-fd=2', '-bsau', 'ABCD1234'],
        ]);
      });
    });
  });

  describe('Given no gpg.program is set', () => {
    describe('When signPayload openpgp runs', () => {
      it('Then the command defaults to "gpg"', async () => {
        // Arrange
        const armor = pgpArmor('YWJj');
        const runner = stubCommandRunner({
          exitCode: 0,
          stdout: enc(armor),
          stderr: enc(SIG_CREATED_LINE),
        });
        const ctx = createMemoryContext({ command: runner });

        // Act
        await signPayload(ctx, enc('payload'), { format: 'openpgp', selector: 'ABCD1234' });

        // Assert
        expect(runner.calls[0]?.command).toBe('gpg');
      });
    });
  });

  describe('Given an openpgp selector that is the committer-identity fallback ("Name <email>")', () => {
    describe('When signPayload runs', () => {
      it('Then the selector travels as one verbatim argument and signing still succeeds', async () => {
        // Arrange
        const armor = pgpArmor('YWJj');
        const runner = stubCommandRunner({
          exitCode: 0,
          stdout: enc(armor),
          stderr: enc(SIG_CREATED_LINE),
        });
        const ctx = createMemoryContext({ command: runner });
        const selector = 'Name <committer@example.com>';

        // Act
        const result = await signPayload(ctx, enc('payload'), { format: 'openpgp', selector });

        // Assert
        expect([runner.calls[0]?.command, runner.calls[0]?.args]).toEqual([
          'gpg',
          ['--status-fd=2', '-bsau', 'Name <committer@example.com>'],
        ]);
        expect(result).toEqual({ ok: true, armor });
      });
    });
  });

  describe('Given an openpgp selector containing an embedded single quote', () => {
    describe('When signPayload runs', () => {
      it('Then the quote reaches the program verbatim', async () => {
        // Arrange
        const runner = stubCommandRunner({
          exitCode: 0,
          stdout: enc(pgpArmor('YWJj')),
          stderr: enc(SIG_CREATED_LINE),
        });
        const ctx = createMemoryContext({ command: runner });

        // Act
        await signPayload(ctx, enc('payload'), { format: 'openpgp', selector: "O'Brien" });

        // Assert
        expect([runner.calls[0]?.command, runner.calls[0]?.args]).toEqual([
          'gpg',
          ['--status-fd=2', '-bsau', "O'Brien"],
        ]);
      });
    });
  });

  describe('Given an openpgp selector containing a shell command-injection payload', () => {
    describe('When signPayload runs', () => {
      it('Then the payload reaches the program as one literal argument, no shell between', async () => {
        // Arrange
        const runner = stubCommandRunner({
          exitCode: 0,
          stdout: enc(pgpArmor('YWJj')),
          stderr: enc(SIG_CREATED_LINE),
        });
        const ctx = createMemoryContext({ command: runner });

        // Act
        await signPayload(ctx, enc('payload'), {
          format: 'openpgp',
          selector: 'KEYID; touch pwned',
        });

        // Assert
        expect([runner.calls[0]?.command, runner.calls[0]?.args]).toEqual([
          'gpg',
          ['--status-fd=2', '-bsau', 'KEYID; touch pwned'],
        ]);
      });
    });
  });

  describe('Given format ssh, a stub runner, and a shared memory context', () => {
    describe('When signPayload runs', () => {
      it('Then the payload is written to a temp file, the ssh-keygen argv matches, <tmp>.sig is read as the armor, and both temp files are removed', async () => {
        // Arrange
        const armor = sshArmor('c2lnbmF0dXJl');
        let ctx!: Context;
        let capturedPayload: Uint8Array | undefined;
        const runner = stubCommandRunner({
          exitCode: 0,
          onRun: async (request) => {
            const tmp = stagedBuffer(request);
            capturedPayload = await ctx.fs.read(tmp);
            await ctx.fs.write(`${tmp}.sig`, enc(armor));
          },
        });
        ctx = createMemoryContext({ command: runner });
        const payload = enc('unsigned tag object bytes\n');

        // Act
        const result = await signPayload(ctx, payload, {
          format: 'ssh',
          selector: '/home/user/.ssh/id_ed25519',
        });

        // Assert
        expect(result).toEqual({ ok: true, armor });
        const tmp = stagedBuffer(runner.calls[0]);
        expect(runner.calls[0]).toMatchObject({
          command: 'ssh-keygen',
          args: ['-Y', 'sign', '-n', 'git', '-f', '/home/user/.ssh/id_ed25519', tmp],
        });
        expect(tmp).toMatch(
          new RegExp(`^${ctx.layout.gitDir}/\\.git_signing_buffer_tmp[A-Za-z0-9]{6}$`),
        );
        expect(capturedPayload !== undefined && dec(capturedPayload)).toBe(dec(payload));
        expect(await ctx.fs.exists(tmp)).toBe(false);
        expect(await ctx.fs.exists(`${tmp}.sig`)).toBe(false);
      });
    });
  });

  describe('Given format ssh and a file planted at the first name drawn for the payload', () => {
    describe('When signPayload runs', () => {
      it('Then the planted file stays untouched and the signer reads the payload elsewhere', async () => {
        // Arrange
        let ctx!: Context;
        let seen = '';
        const runner = stubCommandRunner({
          exitCode: 0,
          onRun: async (request) => {
            const tmp = stagedBuffer(request);
            seen = dec(await ctx.fs.read(tmp));
            await ctx.fs.write(`${tmp}.sig`, enc(sshArmor('YWJj')));
          },
        });
        ctx = createMemoryContext({ command: runner });
        const planted = `${ctx.layout.gitDir}/.git_signing_buffer_tmpAAAAAA`;
        await ctx.fs.write(planted, enc('precious'));
        const draws = [0, 0, 0, 0, 0, 0];
        vi.spyOn(Math, 'random').mockImplementation(() => draws.shift() ?? 0.5);

        // Act
        const result = await signPayload(ctx, enc('payload'), { format: 'ssh', selector: '/key' });

        // Assert
        expect(result).toEqual({ ok: true, armor: sshArmor('YWJj') });
        expect(dec(await ctx.fs.read(planted))).toBe('precious');
        expect(stagedBuffer(runner.calls[0])).toBe(planted.replace('AAAAAA', 'f'.repeat(6)));
        expect(seen).toBe('payload');
      });
    });
  });

  describe('Given format ssh', () => {
    describe('When signPayload runs', () => {
      it('Then the runner request env carries GIT_DIR set to the repo gitDir', async () => {
        // Arrange
        let ctx!: Context;
        const runner = stubCommandRunner({
          exitCode: 0,
          onRun: async (request) => {
            const tmp = stagedBuffer(request);
            await ctx.fs.write(`${tmp}.sig`, enc(sshArmor('YWJj')));
          },
        });
        ctx = createMemoryContext({ command: runner });

        // Act
        await signPayload(ctx, enc('payload'), { format: 'ssh', selector: '/key' });

        // Assert
        expect(runner.calls[0]?.env).toEqual({ GIT_DIR: ctx.layout.gitDir });
      });
    });
  });

  describe('Given format ssh and no gpg.ssh.program', () => {
    describe('When signPayload runs', () => {
      it('Then the program defaults to "ssh-keygen"', async () => {
        // Arrange
        let ctx!: Context;
        const runner = stubCommandRunner({
          exitCode: 0,
          onRun: async (request) => {
            const tmp = stagedBuffer(request);
            await ctx.fs.write(`${tmp}.sig`, enc(sshArmor('YWJj')));
          },
        });
        ctx = createMemoryContext({ command: runner });

        // Act
        await signPayload(ctx, enc('payload'), { format: 'ssh', selector: '/key' });

        // Assert
        expect(runner.calls[0]?.command).toBe('ssh-keygen');
      });
    });
  });

  describe('Given ctx.command is undefined', () => {
    describe('When signPayload runs (ssh format)', () => {
      it('Then result is { ok: false, reason: "off-node" } and no filesystem write occurs', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const writeSpy = vi.spyOn(ctx.fs, 'write');

        // Act
        const result = await signPayload(ctx, enc('payload'), {
          format: 'ssh',
          selector: '/key',
        });

        // Assert
        expect(result).toEqual({ ok: false, reason: 'off-node' });
        expect(writeSpy).not.toHaveBeenCalled();
      });
    });
  });

  describe('Given format x509', () => {
    describe('When signPayload runs', () => {
      it('Then result is { ok: false, reason: "unsupported-format" } and the runner is never called', async () => {
        // Arrange
        const runner = stubCommandRunner();
        const ctx = createMemoryContext({ command: runner });

        // Act
        const result = await signPayload(ctx, enc('payload'), {
          format: 'x509',
          selector: 'ABCD1234',
        });

        // Assert
        expect(result).toEqual({ ok: false, reason: 'unsupported-format' });
        expect(runner.calls.length).toBe(0);
      });
    });
  });

  describe('Given an openpgp runner result that yields no usable armor', () => {
    describe('When signPayload runs (openpgp format)', () => {
      it.each([
        { exitCode: 1, stdout: enc(''), label: 'a non-zero exit code' },
        {
          exitCode: 0,
          stdout: enc('not an armor block'),
          label: 'a malformed armor on stdout',
        },
        { exitCode: 0, stdout: undefined, label: 'no stdout captured' },
      ])(
        'Then $label yields result { ok: false, reason: "signer-failed" }',
        async ({ exitCode, stdout }) => {
          // Arrange
          const stderr = enc(SIG_CREATED_LINE);
          const runner = stubCommandRunner(
            stdout === undefined ? { exitCode, stderr } : { exitCode, stdout, stderr },
          );
          const ctx = createMemoryContext({ command: runner });

          // Act
          const result = await signPayload(ctx, enc('payload'), {
            format: 'openpgp',
            selector: 'ABCD1234',
          });

          // Assert
          expect(result).toEqual({ ok: false, reason: 'signer-failed', output: SIG_CREATED_LINE });
        },
      );
    });
  });

  describe('Given an openpgp signer exiting non-zero after emitting a well-formed armor and its SIG_CREATED status', () => {
    describe('When signPayload runs (openpgp format)', () => {
      it('Then signing fails, carrying the signer diagnostic', async () => {
        // Arrange
        const runner = stubCommandRunner({
          exitCode: 1,
          stdout: enc(pgpArmor('YWJj')),
          stderr: enc(SIG_CREATED_LINE),
        });
        const ctx = createMemoryContext({ command: runner });
        const sut = signPayload;

        // Act
        const result = await sut(ctx, enc('payload'), { format: 'openpgp', selector: 'K' });

        // Assert
        expect(result).toEqual({ ok: false, reason: 'signer-failed', output: SIG_CREATED_LINE });
      });
    });
  });

  describe('Given an openpgp signer exiting 0 with a well-formed armor', () => {
    describe.each([
      { stderr: 'gpg: using key FPR\n', label: 'a status with no SIG_CREATED line' },
      { stderr: `x${SIG_CREATED_LINE}`, label: 'SIG_CREATED in the middle of a line' },
      { stderr: '[GNUPG:] SIG_CREATED\n', label: 'SIG_CREATED with no field after it' },
      { stderr: '', label: 'no status at all' },
    ])('When the signer reports $label', ({ stderr }) => {
      it('Then signing fails, carrying the signer diagnostic', async () => {
        // Arrange
        const runner = stubCommandRunner({
          exitCode: 0,
          stdout: enc(pgpArmor('YWJj')),
          stderr: enc(stderr),
        });
        const ctx = createMemoryContext({ command: runner });
        const sut = signPayload;

        // Act
        const result = await sut(ctx, enc('payload'), { format: 'openpgp', selector: 'K' });

        // Assert
        expect(result).toEqual({ ok: false, reason: 'signer-failed', output: stderr });
      });
    });

    describe.each([
      { stderr: SIG_CREATED_LINE, label: 'SIG_CREATED opening the status' },
      {
        stderr: `gpg: using key FPR\n${SIG_CREATED_LINE}`,
        label: 'SIG_CREATED after a diagnostic line',
      },
      { stderr: '[GNUPG:] SIG_CREATED D', label: 'an unterminated SIG_CREATED line' },
    ])('When the signer reports $label', ({ stderr }) => {
      it('Then the signature is accepted and the status kept out of the result', async () => {
        // Arrange
        const armor = pgpArmor('YWJj');
        const runner = stubCommandRunner({ exitCode: 0, stdout: enc(armor), stderr: enc(stderr) });
        const ctx = createMemoryContext({ command: runner });
        const sut = signPayload;

        // Act
        const result = await sut(ctx, enc('payload'), { format: 'openpgp', selector: 'K' });

        // Assert
        expect(result).toEqual({ ok: true, armor });
      });
    });
  });

  describe.each([
    { format: 'openpgp', label: 'an openpgp signer' },
    { format: 'ssh', label: 'an ssh signer' },
  ] as const)('Given $label', ({ format }) => {
    describe('When signPayload runs', () => {
      it('Then the signer stderr is captured, not shown', async () => {
        // Arrange
        const runner = stubCommandRunner({ exitCode: 1 });
        const ctx = createMemoryContext({ command: runner });
        const sut = signPayload;

        // Act
        await sut(ctx, enc('payload'), { format, selector: '/key' });

        // Assert
        expect(runner.calls[0]?.stderr).toBe('capture');
      });
    });
  });

  describe('Given an ssh signer failing with a diagnostic', () => {
    describe('When signPayload runs', () => {
      it('Then signing fails, carrying the diagnostic', async () => {
        // Arrange
        const runner = stubCommandRunner({ exitCode: 255, stderr: enc('Load key: denied\n') });
        const ctx = createMemoryContext({ command: runner });
        const sut = signPayload;

        // Act
        const result = await sut(ctx, enc('payload'), { format: 'ssh', selector: '/key' });

        // Assert
        expect(result).toEqual({
          ok: false,
          reason: 'signer-failed',
          output: 'Load key: denied\n',
        });
      });
    });
  });

  describe('Given an ssh runner that exits without writing a .sig file', () => {
    describe('When signPayload runs', () => {
      it.each([
        { exitCode: 1, label: 'a non-zero exit (1)' },
        { exitCode: 0, label: 'a zero exit (0)' },
      ])(
        'Then result is { ok: false, reason: "signer-failed" } and temp files are still cleaned up ($label)',
        async ({ exitCode }) => {
          // Arrange
          const runner = stubCommandRunner({ exitCode });
          const ctx = createMemoryContext({ command: runner });

          // Act
          const result = await signPayload(ctx, enc('payload'), {
            format: 'ssh',
            selector: '/key',
          });

          // Assert
          const tmpPath = stagedBuffer(runner.calls[0]);
          expect(result).toEqual({ ok: false, reason: 'signer-failed', output: '' });
          expect(tmpPath).not.toBe('');
          expect(await ctx.fs.exists(tmpPath)).toBe(false);
          expect(await ctx.fs.exists(`${tmpPath}.sig`)).toBe(false);
        },
      );
    });
  });

  describe('Given an ssh runner that exits non-zero but a well-formed .sig is present', () => {
    describe('When signPayload runs', () => {
      it('Then result is { ok: false, reason: "signer-failed" } — the non-zero exit is honoured before any .sig is read', async () => {
        // Arrange — the early non-zero-exit refusal must win even when a stale,
        // well-formed .sig happens to sit on disk from a prior run.
        let ctx!: Context;
        const runner = stubCommandRunner({
          exitCode: 1,
          onRun: async (request) => {
            const tmp = stagedBuffer(request);
            await ctx.fs.write(`${tmp}.sig`, enc(sshArmor('c2ln')));
          },
        });
        ctx = createMemoryContext({ command: runner });

        // Act
        const result = await signPayload(ctx, enc('payload'), {
          format: 'ssh',
          selector: '/key',
        });

        // Assert
        expect(result).toEqual({ ok: false, reason: 'signer-failed', output: '' });
      });
    });
  });

  describe('Given the ssh temp-file cleanup fails with an error other than FILE_NOT_FOUND', () => {
    describe('When signPayload runs', () => {
      it('Then the error propagates (not swallowed as a best-effort cleanup)', async () => {
        // Arrange — kills the `isFileNotFound(error)` branch mutant in the
        // cleanup helper: under a `true` mutation, any rm error would be
        // swallowed instead of propagating.
        const armor = sshArmor('YWJj');
        const baseCtx = createMemoryContext({
          command: stubCommandRunner({
            exitCode: 0,
            onRun: async (request) => {
              const tmp = stagedBuffer(request);
              await baseCtx.fs.write(`${tmp}.sig`, enc(armor));
            },
          }),
        });
        const ctx = {
          ...baseCtx,
          fs: {
            ...baseCtx.fs,
            rm: async () => {
              throw new TsgitError({ code: 'PERMISSION_DENIED', path: '/x' });
            },
          },
        };

        // Act / Assert
        try {
          await signPayload(ctx, enc('payload'), { format: 'ssh', selector: '/key' });
          expect.unreachable();
        } catch (error) {
          expect(error).toBeInstanceOf(TsgitError);
          expect((error as TsgitError).data.code).toBe('PERMISSION_DENIED');
        }
      });
    });
  });

  describe('Given the ssh .sig read fails with an error other than FILE_NOT_FOUND', () => {
    describe('When signPayload runs', () => {
      it('Then the error propagates (not converted to a signer-failed refusal)', async () => {
        // Arrange — kills the `isFileNotFound(error)` branch mutant: under a
        // `true` mutation, any read error (not just FILE_NOT_FOUND) would be
        // swallowed into an `undefined` armor instead of propagating.
        const baseCtx = createMemoryContext({ command: stubCommandRunner({ exitCode: 0 }) });
        const ctx = {
          ...baseCtx,
          fs: {
            ...baseCtx.fs,
            read: async (path: string) =>
              path.endsWith('.sig')
                ? Promise.reject(new TsgitError({ code: 'PERMISSION_DENIED', path }))
                : baseCtx.fs.read(path),
          },
        };

        // Act / Assert
        try {
          await signPayload(ctx, enc('payload'), { format: 'ssh', selector: '/key' });
          expect.unreachable();
        } catch (error) {
          expect(error).toBeInstanceOf(TsgitError);
          expect((error as TsgitError).data.code).toBe('PERMISSION_DENIED');
        }
      });
    });
  });

  describe('Given ctx.signal is set', () => {
    describe('When signPayload runs', () => {
      it('Then the runner request carries that signal', async () => {
        // Arrange
        const controller = new AbortController();
        const armor = pgpArmor('YWJj');
        const runner = stubCommandRunner({
          exitCode: 0,
          stdout: enc(armor),
          stderr: enc(SIG_CREATED_LINE),
        });
        const ctx = createMemoryContext({ command: runner, signal: controller.signal });

        // Act
        await signPayload(ctx, enc('payload'), { format: 'openpgp', selector: 'ABCD1234' });

        // Assert
        expect(runner.calls[0]?.signal).toBe(controller.signal);
      });
    });

    describe('When signPayload runs (ssh format)', () => {
      it('Then the runner request carries that signal', async () => {
        // Arrange
        const controller = new AbortController();
        const armor = sshArmor('YWJj');
        let ctx!: Context;
        const runner = stubCommandRunner({
          exitCode: 0,
          onRun: async (request) => {
            const tmp = stagedBuffer(request);
            await ctx.fs.write(`${tmp}.sig`, enc(armor));
          },
        });
        ctx = createMemoryContext({ command: runner, signal: controller.signal });

        // Act
        await signPayload(ctx, enc('payload'), { format: 'ssh', selector: '/key' });

        // Assert
        expect(runner.calls[0]?.signal).toBe(controller.signal);
      });
    });
  });

  describe('Given ctx.signal is not set', () => {
    describe('When signPayload runs (openpgp format)', () => {
      it('Then the runner request omits the signal key entirely (never a signal: undefined)', async () => {
        // Arrange
        const runner = stubCommandRunner({
          exitCode: 0,
          stdout: enc(pgpArmor('YWJj')),
          stderr: enc(SIG_CREATED_LINE),
        });
        const ctx = createMemoryContext({ command: runner });

        // Act
        await signPayload(ctx, enc('payload'), { format: 'openpgp', selector: 'ABCD1234' });

        // Assert
        const call = runner.calls[0];
        expect(runner.calls.length).toBe(1);
        expect(call !== undefined && 'signal' in call).toBe(false);
      });
    });

    describe('When signPayload runs (ssh format)', () => {
      it('Then the runner request omits the signal key entirely (never a signal: undefined)', async () => {
        // Arrange
        let ctx!: Context;
        const runner = stubCommandRunner({
          exitCode: 0,
          onRun: async (request) => {
            const tmp = stagedBuffer(request);
            await ctx.fs.write(`${tmp}.sig`, enc(sshArmor('YWJj')));
          },
        });
        ctx = createMemoryContext({ command: runner });

        // Act
        await signPayload(ctx, enc('payload'), { format: 'ssh', selector: '/key' });

        // Assert
        const call = runner.calls[0];
        expect(runner.calls.length).toBe(1);
        expect(call !== undefined && 'signal' in call).toBe(false);
      });
    });
  });

  describe('Given an openpgp signer writing its armor with carriage returns', () => {
    describe('When signPayload runs', () => {
      it('Then only a carriage return before a line feed is dropped from the armor', async () => {
        // Arrange
        const runner = stubCommandRunner({
          exitCode: 0,
          stdout: enc(
            '-----BEGIN PGP SIGNATURE-----\r\n\r\nab\rcd\r\n-----END PGP SIGNATURE-----\r\n',
          ),
          stderr: enc(SIG_CREATED_LINE),
        });
        const ctx = createMemoryContext({ command: runner });
        const sut = signPayload;

        // Act
        const result = await sut(ctx, enc('payload'), { format: 'openpgp', selector: 'K' });

        // Assert
        expect(result).toEqual({ ok: true, armor: pgpArmor('ab\rcd') });
      });
    });
  });

  describe('Given an ssh signer writing its armor with carriage returns', () => {
    describe('When signPayload runs', () => {
      it('Then only a carriage return before a line feed is dropped from the armor', async () => {
        // Arrange
        let ctx!: Context;
        const runner = stubCommandRunner({
          exitCode: 0,
          onRun: async (request) => {
            await ctx.fs.write(
              `${stagedBuffer(request)}.sig`,
              enc('-----BEGIN SSH SIGNATURE-----\r\nab\rcd\r\n-----END SSH SIGNATURE-----\r\n'),
            );
          },
        });
        ctx = createMemoryContext({ command: runner });
        const sut = signPayload;

        // Act
        const result = await sut(ctx, enc('payload'), { format: 'ssh', selector: '/k' });

        // Assert
        expect(result).toEqual({ ok: true, armor: sshArmor('ab\rcd') });
      });
    });
  });
});

describe('stripCrBeforeLf', () => {
  describe('Given a lone carriage return inside a line', () => {
    describe('When stripCrBeforeLf runs', () => {
      it('Then the carriage return is kept', () => {
        // Arrange
        const sut = stripCrBeforeLf;

        // Act
        const result = sut('ab\rcd');

        // Assert
        expect(result).toBe('ab\rcd');
      });
    });
  });

  describe('Given two carriage returns before a line feed', () => {
    describe('When stripCrBeforeLf runs', () => {
      it('Then only the one preceding the line feed is removed', () => {
        // Arrange
        const sut = stripCrBeforeLf;

        // Act
        const result = sut('ef\r\r\n');

        // Assert
        expect(result).toBe('ef\r\n');
      });
    });
  });

  describe('Given a carriage return ending the text', () => {
    describe('When stripCrBeforeLf runs', () => {
      it('Then the trailing carriage return is kept', () => {
        // Arrange
        const sut = stripCrBeforeLf;

        // Act
        const result = sut('x\r');

        // Assert
        expect(result).toBe('x\r');
      });
    });
  });
});

describe('resolveSigningSelector', () => {
  describe('Given a signing-selector precedence input', () => {
    describe('When resolveSigningSelector runs', () => {
      it.each([
        {
          options: {
            keyOverride: 'OVERRIDE',
            signingKey: 'CONFIGURED',
            fallbackIdent: 'Name <email>',
          },
          expected: 'OVERRIDE',
          label: 'returns the keyOverride',
        },
        {
          options: { signingKey: 'CONFIGURED', fallbackIdent: 'Name <email>' },
          expected: 'CONFIGURED',
          label: 'returns the signingKey (no keyOverride)',
        },
        {
          options: { fallbackIdent: 'Name <email>' },
          expected: 'Name <email>',
          label: 'returns the fallbackIdent (neither keyOverride nor signingKey)',
        },
      ])('Then it $label', ({ options, expected }) => {
        // Arrange & Act
        const result = resolveSigningSelector(options);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });
});
