import { describe, expect, it, vi } from 'vitest';

import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import {
  resolveSigningSelector,
  signPayload,
} from '../../../../src/application/primitives/sign-payload.js';
import { TsgitError } from '../../../../src/domain/error.js';
import type { Context } from '../../../../src/ports/context.js';
import { stubCommandRunner } from './helpers/stub-command-runner.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

const pgpArmor = (body: string): string =>
  `-----BEGIN PGP SIGNATURE-----\n\n${body}\n-----END PGP SIGNATURE-----\n`;

const sshArmor = (body: string): string =>
  `-----BEGIN SSH SIGNATURE-----\n${body}\n-----END SSH SIGNATURE-----\n`;

// Deterministic ssh signing temp-file path — never parsed out of the
// (now shell-quoted) command string.
const sshTempPath = (ctx: Context): string => `${ctx.layout.gitDir}/GIT_SIGNING_BUFFER`;

describe('signPayload', () => {
  describe('Given format openpgp and a runner returning exit 0 with a PGP armor on stdout', () => {
    describe('When signPayload runs', () => {
      it('Then result is ok:true and the armor round-trips the stdout text', async () => {
        // Arrange
        const armor = pgpArmor('c2lnbmF0dXJl');
        const runner = stubCommandRunner({ exitCode: 0, stdout: enc(armor) });
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
        const runner = stubCommandRunner({ exitCode: 0, stdout: enc(armor) });
        const ctx = createMemoryContext({ command: runner });
        const payload = enc('tree deadbeef\n');

        // Act
        await signPayload(ctx, payload, { format: 'openpgp', selector: 'ABCD1234' });

        // Assert
        const call = runner.calls[0];
        expect(call?.command).toBe("'gpg' --status-fd=2 -bsau 'ABCD1234'");
        expect(call?.stdin).toBe(payload);
      });
    });
  });

  describe('Given format openpgp', () => {
    describe('When signPayload runs', () => {
      it('Then the runner request env carries GIT_DIR set to the repo gitDir', async () => {
        // Arrange
        const runner = stubCommandRunner({ exitCode: 0, stdout: enc(pgpArmor('YWJj')) });
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
        const runner = stubCommandRunner({ exitCode: 0, stdout: enc(armor) });
        const ctx = createMemoryContext({ command: runner });

        // Act
        await signPayload(ctx, enc('payload'), {
          format: 'openpgp',
          selector: 'ABCD1234',
          program: '/usr/bin/gpg2',
        });

        // Assert
        expect(runner.calls[0]?.command).toBe("'/usr/bin/gpg2' --status-fd=2 -bsau 'ABCD1234'");
      });
    });
  });

  describe('Given no gpg.program is set', () => {
    describe('When signPayload openpgp runs', () => {
      it('Then the command defaults to "gpg"', async () => {
        // Arrange
        const armor = pgpArmor('YWJj');
        const runner = stubCommandRunner({ exitCode: 0, stdout: enc(armor) });
        const ctx = createMemoryContext({ command: runner });

        // Act
        await signPayload(ctx, enc('payload'), { format: 'openpgp', selector: 'ABCD1234' });

        // Assert
        expect(runner.calls[0]?.command.startsWith("'gpg' ")).toBe(true);
      });
    });
  });

  describe('Given an openpgp selector that is the committer-identity fallback ("Name <email>")', () => {
    describe('When signPayload runs', () => {
      it('Then the command single-quotes the selector so the redirection metacharacters are inert and signing still succeeds', async () => {
        // Arrange
        const armor = pgpArmor('YWJj');
        const runner = stubCommandRunner({ exitCode: 0, stdout: enc(armor) });
        const ctx = createMemoryContext({ command: runner });
        const selector = 'Name <committer@example.com>';

        // Act
        const result = await signPayload(ctx, enc('payload'), { format: 'openpgp', selector });

        // Assert
        expect(runner.calls[0]?.command).toBe(
          "'gpg' --status-fd=2 -bsau 'Name <committer@example.com>'",
        );
        expect(result).toEqual({ ok: true, armor });
      });
    });
  });

  describe('Given an openpgp selector containing an embedded single quote', () => {
    describe('When signPayload runs', () => {
      it('Then the quote is escaped as close-quote, escaped-quote, reopen-quote', async () => {
        // Arrange
        const runner = stubCommandRunner({ exitCode: 0, stdout: enc(pgpArmor('YWJj')) });
        const ctx = createMemoryContext({ command: runner });

        // Act
        await signPayload(ctx, enc('payload'), { format: 'openpgp', selector: "O'Brien" });

        // Assert
        expect(runner.calls[0]?.command).toBe("'gpg' --status-fd=2 -bsau 'O'\\''Brien'");
      });
    });
  });

  describe('Given an openpgp selector containing a shell command-injection payload', () => {
    describe('When signPayload runs', () => {
      it('Then the payload is wrapped as a single literal argument, not executed by the shell', async () => {
        // Arrange
        const runner = stubCommandRunner({ exitCode: 0, stdout: enc(pgpArmor('YWJj')) });
        const ctx = createMemoryContext({ command: runner });

        // Act
        await signPayload(ctx, enc('payload'), {
          format: 'openpgp',
          selector: 'KEYID; touch pwned',
        });

        // Assert
        expect(runner.calls[0]?.command).toBe("'gpg' --status-fd=2 -bsau 'KEYID; touch pwned'");
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
          onRun: async () => {
            const tmp = sshTempPath(ctx);
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
        const tmp = sshTempPath(ctx);
        expect(runner.calls[0]?.command).toBe(
          `'ssh-keygen' -Y sign -n git -f '/home/user/.ssh/id_ed25519' '${tmp}'`,
        );
        expect(capturedPayload !== undefined && dec(capturedPayload)).toBe(dec(payload));
        expect(await ctx.fs.exists(tmp)).toBe(false);
        expect(await ctx.fs.exists(`${tmp}.sig`)).toBe(false);
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
          onRun: async () => {
            const tmp = sshTempPath(ctx);
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
          onRun: async () => {
            const tmp = sshTempPath(ctx);
            await ctx.fs.write(`${tmp}.sig`, enc(sshArmor('YWJj')));
          },
        });
        ctx = createMemoryContext({ command: runner });

        // Act
        await signPayload(ctx, enc('payload'), { format: 'ssh', selector: '/key' });

        // Assert
        expect(runner.calls[0]?.command.startsWith("'ssh-keygen' ")).toBe(true);
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

  describe('Given a runner returning a non-zero exit', () => {
    describe('When signPayload runs (openpgp format)', () => {
      it('Then result is { ok: false, reason: "signer-failed" }', async () => {
        // Arrange
        const runner = stubCommandRunner({ exitCode: 1, stdout: enc('') });
        const ctx = createMemoryContext({ command: runner });

        // Act
        const result = await signPayload(ctx, enc('payload'), {
          format: 'openpgp',
          selector: 'ABCD1234',
        });

        // Assert
        expect(result).toEqual({ ok: false, reason: 'signer-failed' });
      });
    });
  });

  describe('Given a runner returning exit 0 but stdout without a well-formed armor', () => {
    describe('When signPayload runs (openpgp format)', () => {
      it('Then result is { ok: false, reason: "signer-failed" }', async () => {
        // Arrange
        const runner = stubCommandRunner({ exitCode: 0, stdout: enc('not an armor block') });
        const ctx = createMemoryContext({ command: runner });

        // Act
        const result = await signPayload(ctx, enc('payload'), {
          format: 'openpgp',
          selector: 'ABCD1234',
        });

        // Assert
        expect(result).toEqual({ ok: false, reason: 'signer-failed' });
      });
    });
  });

  describe('Given an ssh runner that fails without writing a .sig file', () => {
    describe('When signPayload runs', () => {
      it('Then result is { ok: false, reason: "signer-failed" } and temp files are still cleaned up', async () => {
        // Arrange
        const runner = stubCommandRunner({ exitCode: 1 });
        const ctx = createMemoryContext({ command: runner });
        const tmpPath = sshTempPath(ctx);

        // Act
        const result = await signPayload(ctx, enc('payload'), {
          format: 'ssh',
          selector: '/key',
        });

        // Assert
        expect(result).toEqual({ ok: false, reason: 'signer-failed' });
        expect(await ctx.fs.exists(tmpPath)).toBe(false);
        expect(await ctx.fs.exists(`${tmpPath}.sig`)).toBe(false);
      });
    });
  });

  describe('Given an ssh runner that exits 0 without writing a .sig file', () => {
    describe('When signPayload runs', () => {
      it('Then result is { ok: false, reason: "signer-failed" } and temp files are still cleaned up', async () => {
        // Arrange
        const runner = stubCommandRunner({ exitCode: 0 });
        const ctx = createMemoryContext({ command: runner });
        const tmpPath = sshTempPath(ctx);

        // Act
        const result = await signPayload(ctx, enc('payload'), {
          format: 'ssh',
          selector: '/key',
        });

        // Assert
        expect(result).toEqual({ ok: false, reason: 'signer-failed' });
        expect(await ctx.fs.exists(tmpPath)).toBe(false);
        expect(await ctx.fs.exists(`${tmpPath}.sig`)).toBe(false);
      });
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
          onRun: async () => {
            const tmp = sshTempPath(ctx);
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
        expect(result).toEqual({ ok: false, reason: 'signer-failed' });
      });
    });
  });

  describe('Given a runner returning exit 0 with no stdout captured', () => {
    describe('When signPayload runs (openpgp format)', () => {
      it('Then result is { ok: false, reason: "signer-failed" }', async () => {
        // Arrange — kills the `result.stdout ?? EMPTY` mutant: an absent
        // stdout must decode to an empty (non-armor) string, not crash.
        const runner = stubCommandRunner({ exitCode: 0 });
        const ctx = createMemoryContext({ command: runner });

        // Act
        const result = await signPayload(ctx, enc('payload'), {
          format: 'openpgp',
          selector: 'ABCD1234',
        });

        // Assert
        expect(result).toEqual({ ok: false, reason: 'signer-failed' });
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
            onRun: async () => {
              const tmp = sshTempPath(baseCtx);
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
        const runner = stubCommandRunner({ exitCode: 0, stdout: enc(armor) });
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
          onRun: async () => {
            const tmp = sshTempPath(ctx);
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
        const runner = stubCommandRunner({ exitCode: 0, stdout: enc(pgpArmor('YWJj')) });
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
          onRun: async () => {
            const tmp = sshTempPath(ctx);
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
});

describe('resolveSigningSelector', () => {
  describe('Given a keyOverride', () => {
    describe('When resolveSigningSelector runs', () => {
      it('Then it returns the keyOverride', () => {
        // Arrange
        const sut = resolveSigningSelector({
          keyOverride: 'OVERRIDE',
          signingKey: 'CONFIGURED',
          fallbackIdent: 'Name <email>',
        });

        // Assert
        expect(sut).toBe('OVERRIDE');
      });
    });
  });

  describe('Given no keyOverride but a signingKey', () => {
    describe('When resolveSigningSelector runs', () => {
      it('Then it returns the signingKey', () => {
        // Arrange
        const sut = resolveSigningSelector({
          signingKey: 'CONFIGURED',
          fallbackIdent: 'Name <email>',
        });

        // Assert
        expect(sut).toBe('CONFIGURED');
      });
    });
  });

  describe('Given neither keyOverride nor signingKey', () => {
    describe('When resolveSigningSelector runs', () => {
      it('Then it returns the fallbackIdent', () => {
        // Arrange
        const sut = resolveSigningSelector({ fallbackIdent: 'Name <email>' });

        // Assert
        expect(sut).toBe('Name <email>');
      });
    });
  });
});
