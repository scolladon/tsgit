import { describe, expect, it } from 'vitest';

import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { verifyCommitSignature } from '../../../../../src/application/primitives/internal/verify-commit-signature.js';
import type {
  CommandRequest,
  CommandResult,
  CommandRunner,
} from '../../../../../src/ports/command-runner.js';
import type { Context } from '../../../../../src/ports/context.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

const PGP_SIG = '-----BEGIN PGP SIGNATURE-----\n\nabc\n-----END PGP SIGNATURE-----\n';
const SSH_SIG = '-----BEGIN SSH SIGNATURE-----\nabc\n-----END SSH SIGNATURE-----\n';
const X509_SIG = '-----BEGIN SIGNED MESSAGE-----\nabc\n-----END SIGNED MESSAGE-----\n';
const PAYLOAD = enc('tree 0\n\nmsg\n');
const FPR = 'SHA256:58jgAsSNMbfeb/dT6phjcmxBcoEZOiA07RjWl53ba9o';

interface Scripted {
  readonly exitCode?: number;
  readonly stdout?: string;
  readonly stderr?: string;
}

interface Harness {
  readonly ctx: Context;
  readonly requests: CommandRequest[];
  readonly bufferPath: string;
  readonly seenBuffer: string[];
}

const harness = (script: (request: CommandRequest) => Scripted | 'throw'): Harness => {
  const requests: CommandRequest[] = [];
  const seenBuffer: string[] = [];
  const holder: { ctx?: Context } = {};
  const runner: CommandRunner = {
    async run(request): Promise<CommandResult> {
      requests.push(request);
      const gitDir = holder.ctx?.layout.gitDir ?? '';
      seenBuffer.push(
        new TextDecoder().decode(await holder.ctx?.fs.read(`${gitDir}/GIT_VERIFY_BUFFER`)),
      );
      const scripted = script(request);
      if (scripted === 'throw') throw new Error('spawn failed');
      await holder.ctx?.fs.write(`${gitDir}/GIT_VERIFY_BUFFER.err`, enc(scripted.stderr ?? ''));
      return { exitCode: scripted.exitCode ?? 0, stdout: enc(scripted.stdout ?? '') };
    },
  };
  const ctx = createMemoryContext({ command: runner });
  holder.ctx = ctx;
  return { ctx, requests, bufferPath: `${ctx.layout.gitDir}/GIT_VERIFY_BUFFER`, seenBuffer };
};

const status = (...lines: string[]): string => lines.map((l) => `[GNUPG:] ${l}\n`).join('');

const gpgContext = (stdout: string, stderr = ''): Context =>
  harness(() => ({ stdout, stderr })).ctx;

const GPG_INPUT = { payload: PAYLOAD, signature: PGP_SIG };

describe('verifyCommitSignature', () => {
  describe.each([
    ['GOODSIG', 'G'],
    ['BADSIG', 'B'],
    ['EXPSIG', 'X'],
    ['EXPKEYSIG', 'Y'],
    ['REVKEYSIG', 'R'],
  ] as const)('Given a gpg status line %s', (keyword, letter) => {
    describe('When the signature is verified', () => {
      it(`Then the result is ${letter} with the key and signer`, async () => {
        // Arrange
        const ctx = gpgContext(status(`${keyword} 1122334455667788 Jane Doe <j@x.y>`));

        // Act
        const result = await verifyCommitSignature(ctx, GPG_INPUT);

        // Assert
        expect(result).toMatchObject({
          result: letter,
          key: '1122334455667788',
          signer: 'Jane Doe <j@x.y>',
        });
      });
    });
  });

  describe('Given an ERRSIG status line', () => {
    describe('When the signature is verified', () => {
      it('Then the result is E with the key and no signer', async () => {
        // Arrange
        const ctx = gpgContext(status('ERRSIG AAAA 1 8 00 1700000000 9 FFFF'));

        // Act
        const result = await verifyCommitSignature(ctx, GPG_INPUT);

        // Assert
        expect(result).toMatchObject({ result: 'E', key: 'AAAA', signer: '' });
      });
    });
  });

  describe.each([
    ['TRUST_UNDEFINED', 'undefined'],
    ['TRUST_NEVER', 'never'],
    ['TRUST_MARGINAL', 'marginal'],
    ['TRUST_FULLY', 'fully'],
    ['TRUST_ULTIMATE', 'ultimate'],
  ] as const)('Given a gpg status line %s', (keyword, trust) => {
    describe('When the signature is verified', () => {
      it(`Then the trust is ${trust}`, async () => {
        // Arrange
        const ctx = gpgContext(status('GOODSIG K Who', `${keyword} 0 pgp`));

        // Act
        const result = await verifyCommitSignature(ctx, GPG_INPUT);

        // Assert
        expect(result.trust).toBe(trust);
      });
    });
  });

  describe('Given a VALIDSIG status line', () => {
    describe('When the signature is verified', () => {
      it('Then the fingerprint and the primary key fingerprint are extracted', async () => {
        // Arrange
        const ctx = gpgContext(
          status('GOODSIG K Who', 'VALIDSIG FFFF 2024-01-01 1700000000 0 4 0 1 10 01 PPPP'),
        );

        // Act
        const result = await verifyCommitSignature(ctx, GPG_INPUT);

        // Assert
        expect(result).toMatchObject({ fingerprint: 'FFFF', primaryKeyFingerprint: 'PPPP' });
      });
    });
  });

  describe('Given a VALIDSIG status line without the primary key field', () => {
    describe('When the signature is verified', () => {
      it('Then the primary key fingerprint is empty', async () => {
        // Arrange
        const ctx = gpgContext(status('VALIDSIG FFFF'));

        // Act
        const result = await verifyCommitSignature(ctx, GPG_INPUT);

        // Assert
        expect(result).toMatchObject({ fingerprint: 'FFFF', primaryKeyFingerprint: '' });
      });
    });
  });

  describe('Given a BADSIG after a GOODSIG and a line without the gnupg prefix', () => {
    describe('When the signature is verified', () => {
      it('Then the later status wins and the unprefixed line is ignored', async () => {
        // Arrange
        const ctx = gpgContext(
          `${status('GOODSIG K One')}GOODSIG K Ignored\n${status('BADSIG K Two', 'NEWSIG')}`,
        );

        // Act
        const result = await verifyCommitSignature(ctx, GPG_INPUT);

        // Assert
        expect(result).toMatchObject({ result: 'B', signer: 'Two' });
      });
    });
  });

  describe('Given a verifier printing no status but a diagnostic on stderr', () => {
    describe('When the signature is verified', () => {
      it('Then the result is N, the trust undefined and the output is the stderr', async () => {
        // Arrange
        const ctx = gpgContext('', 'gpg: no public key\n');

        // Act
        const result = await verifyCommitSignature(ctx, GPG_INPUT);

        // Assert
        expect(result).toEqual({
          result: 'N',
          trust: 'undefined',
          signer: '',
          key: '',
          fingerprint: '',
          primaryKeyFingerprint: '',
          output: 'gpg: no public key\n',
        });
      });
    });
  });

  describe('Given an openpgp signature and a configured gpg.program', () => {
    describe('When the signature is verified', () => {
      it('Then the program is run with the buffer file and the payload on stdin', async () => {
        // Arrange
        const rig = harness(() => ({ stdout: status('GOODSIG K Who') }));

        // Act
        await verifyCommitSignature(rig.ctx, {
          payload: PAYLOAD,
          signature: PGP_SIG,
          gpg: { program: "my gpg's" },
        });

        // Assert
        expect(rig.requests).toHaveLength(1);
        expect(rig.requests[0]?.command).toBe(
          `'my gpg'\\''s' --keyid-format=long --status-fd=1 --verify '${rig.bufferPath}' - 2> '${rig.bufferPath}.err'`,
        );
        expect(rig.requests[0]?.stdin).toBe(PAYLOAD);
        expect(rig.requests[0]?.env).toEqual({ GIT_DIR: rig.ctx.layout.gitDir });
        expect(rig.seenBuffer).toEqual([PGP_SIG]);
      });
    });
  });

  describe('Given an openpgp signature and no configured program', () => {
    describe('When the signature is verified', () => {
      it('Then gpg runs', async () => {
        // Arrange
        const rig = harness(() => ({}));

        // Act
        await verifyCommitSignature(rig.ctx, { payload: PAYLOAD, signature: PGP_SIG });

        // Assert
        expect(rig.requests[0]?.command.startsWith("'gpg' --keyid-format=long")).toBe(true);
      });
    });
  });

  describe('Given an x509 signature', () => {
    describe('When the signature is verified', () => {
      it('Then gpgsm runs even when gpg.program is configured', async () => {
        // Arrange
        const rig = harness(() => ({ stdout: status('GOODSIG K Who') }));

        // Act
        const result = await verifyCommitSignature(rig.ctx, {
          payload: PAYLOAD,
          signature: X509_SIG,
          gpg: { program: 'other' },
        });

        // Assert
        expect(rig.requests[0]?.command.startsWith("'gpgsm' --keyid-format=long")).toBe(true);
        expect(result.result).toBe('G');
      });
    });
  });

  describe('Given an ssh signature and a principal found in the allowed signers', () => {
    describe('When the signature is verified', () => {
      it('Then the result is G with the principal, the fully trust and the fingerprint', async () => {
        // Arrange
        const rig = harness((request) =>
          request.command.includes('find-principals')
            ? { stdout: 'a@b.c\n' }
            : { stdout: `Good "git" signature for a@b.c with ED25519 key ${FPR}\n` },
        );

        // Act
        const result = await verifyCommitSignature(rig.ctx, {
          payload: PAYLOAD,
          signature: SSH_SIG,
          gpg: { ssh: { allowedSignersFile: '/allowed', revocationFile: '/revoked' } },
        });

        // Assert
        expect(result).toEqual({
          result: 'G',
          trust: 'fully',
          signer: 'a@b.c',
          key: FPR,
          fingerprint: FPR,
          primaryKeyFingerprint: '',
          output: `Good "git" signature for a@b.c with ED25519 key ${FPR}\n`,
        });
        expect(rig.requests.map((r) => r.command)).toEqual([
          `'ssh-keygen' -Y find-principals -f '/allowed' -s '${rig.bufferPath}' 2> '${rig.bufferPath}.err'`,
          `'ssh-keygen' -Y verify -n git -f '/allowed' -I 'a@b.c' -s '${rig.bufferPath}' -r '/revoked' 2> '${rig.bufferPath}.err'`,
        ]);
        expect(rig.requests[0]?.stdin).toBeUndefined();
        expect(rig.requests[1]?.stdin).toBe(PAYLOAD);
      });
    });
  });

  describe('Given an ssh signature, a program override and no revocation file', () => {
    describe('When the signature is verified', () => {
      it('Then the verify command has no -r and uses the program', async () => {
        // Arrange
        const rig = harness((request) =>
          request.command.includes('find-principals') ? { stdout: 'a@b.c\n' } : { stdout: 'Good' },
        );

        // Act
        await verifyCommitSignature(rig.ctx, {
          payload: PAYLOAD,
          signature: SSH_SIG,
          gpg: { ssh: { program: 'sk', allowedSignersFile: '/allowed' } },
        });

        // Assert
        expect(rig.requests[1]?.command).toBe(
          `'sk' -Y verify -n git -f '/allowed' -I 'a@b.c' -s '${rig.bufferPath}' 2> '${rig.bufferPath}.err'`,
        );
      });
    });
  });

  describe('Given an ssh signature with two principals of which only the second verifies', () => {
    describe('When the signature is verified', () => {
      it('Then both are tried and the second one is reported', async () => {
        // Arrange
        const rig = harness((request) => {
          if (request.command.includes('find-principals')) return { stdout: 'a@b.c\nd@e.f\n' };
          return request.command.includes("'d@e.f'")
            ? { stdout: `Good "git" signature for d@e.f with ED25519 key ${FPR}\n` }
            : { exitCode: 255, stdout: 'Could not verify signature.\n' };
        });

        // Act
        const result = await verifyCommitSignature(rig.ctx, {
          payload: PAYLOAD,
          signature: SSH_SIG,
          gpg: { ssh: { allowedSignersFile: '/allowed' } },
        });

        // Assert
        expect(rig.requests).toHaveLength(3);
        expect(result).toMatchObject({ result: 'G', signer: 'd@e.f' });
      });
    });
  });

  describe('Given an ssh signature with two principals that both verify', () => {
    describe('When the signature is verified', () => {
      it('Then the first verifying principal stops the search', async () => {
        // Arrange
        const rig = harness((request) =>
          request.command.includes('find-principals')
            ? { stdout: 'a@b.c\nd@e.f\n' }
            : { stdout: `Good "git" signature for a@b.c with ED25519 key ${FPR}\n` },
        );

        // Act
        await verifyCommitSignature(rig.ctx, {
          payload: PAYLOAD,
          signature: SSH_SIG,
          gpg: { ssh: { allowedSignersFile: '/allowed' } },
        });

        // Assert
        expect(rig.requests).toHaveLength(2);
      });
    });
  });

  describe('Given an ssh signature whose verification fails', () => {
    describe('When the signature is verified', () => {
      it('Then the result is B with the never trust and both outputs', async () => {
        // Arrange
        const rig = harness((request) =>
          request.command.includes('find-principals')
            ? { stdout: 'a@b.c\n' }
            : {
                exitCode: 255,
                stdout: 'Could not verify signature.\n',
                stderr: 'Signature verification failed: incorrect signature\n',
              },
        );

        // Act
        const result = await verifyCommitSignature(rig.ctx, {
          payload: PAYLOAD,
          signature: SSH_SIG,
          gpg: { ssh: { allowedSignersFile: '/allowed' } },
        });

        // Assert
        expect(result).toMatchObject({
          result: 'B',
          trust: 'never',
          signer: '',
          key: '',
          output:
            'Could not verify signature.\nSignature verification failed: incorrect signature\n',
        });
      });
    });
  });

  describe('Given an ssh signature whose key matches no principal', () => {
    describe('When the signature is verified', () => {
      it('Then the key is reported with the undefined trust and the no-principal notice', async () => {
        // Arrange
        const rig = harness((request) => {
          if (request.command.includes('find-principals')) {
            return { exitCode: 255, stderr: 'sig_find_principals: not found\n' };
          }
          return { stdout: `Good "git" signature with ED25519 key ${FPR}\n` };
        });

        // Act
        const result = await verifyCommitSignature(rig.ctx, {
          payload: PAYLOAD,
          signature: SSH_SIG,
          gpg: { ssh: { allowedSignersFile: '/allowed' } },
        });

        // Assert
        expect(result).toEqual({
          result: 'G',
          trust: 'undefined',
          signer: '',
          key: FPR,
          fingerprint: FPR,
          primaryKeyFingerprint: '',
          output: `Good "git" signature with ED25519 key ${FPR}\nsig_find_principals: not found\nNo principal matched.\n`,
        });
        expect(rig.requests[1]?.command).toBe(
          `'ssh-keygen' -Y check-novalidate -n git -s '${rig.bufferPath}' 2> '${rig.bufferPath}.err'`,
        );
        expect(rig.requests[1]?.stdin).toBe(PAYLOAD);
      });
    });
  });

  describe('Given an ssh signature that no key check accepts', () => {
    describe('When the signature is verified', () => {
      it('Then the result is B with the never trust', async () => {
        // Arrange
        const rig = harness((request) =>
          request.command.includes('find-principals')
            ? { stdout: '' }
            : { exitCode: 255, stdout: 'Could not verify signature.\n', stderr: 'bad\n' },
        );

        // Act
        const result = await verifyCommitSignature(rig.ctx, {
          payload: PAYLOAD,
          signature: SSH_SIG,
          gpg: { ssh: { allowedSignersFile: '/allowed' } },
        });

        // Assert
        expect(result).toMatchObject({
          result: 'B',
          trust: 'never',
          output: 'Could not verify signature.\nbad\n',
        });
      });
    });
  });

  describe('Given an ssh-keygen too old for find-principals', () => {
    describe('When the signature is verified', () => {
      it('Then the result is N and nothing else runs', async () => {
        // Arrange
        const rig = harness(() => ({ exitCode: 1, stderr: 'usage: ssh-keygen ...\n' }));

        // Act
        const result = await verifyCommitSignature(rig.ctx, {
          payload: PAYLOAD,
          signature: SSH_SIG,
          gpg: { ssh: { allowedSignersFile: '/allowed' } },
        });

        // Assert
        expect(result.result).toBe('N');
        expect(rig.requests).toHaveLength(1);
      });
    });
  });

  describe('Given an ssh signature and no allowed signers file', () => {
    describe('When the signature is verified', () => {
      it('Then the result is N and no verifier runs', async () => {
        // Arrange
        const rig = harness(() => ({}));

        // Act
        const result = await verifyCommitSignature(rig.ctx, {
          payload: PAYLOAD,
          signature: SSH_SIG,
        });

        // Assert
        expect(result.result).toBe('N');
        expect(rig.requests).toHaveLength(0);
      });
    });
  });

  describe('Given a context without a command runner', () => {
    describe('When the signature is verified', () => {
      it('Then the result is N with empty fields and undefined trust', async () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        const result = await verifyCommitSignature(ctx, { payload: PAYLOAD, signature: PGP_SIG });

        // Assert
        expect(result).toMatchObject({ result: 'N', trust: 'undefined', output: '' });
      });
    });
  });

  describe('Given a signature in no known format', () => {
    describe('When the signature is verified', () => {
      it('Then the result is N and no verifier runs', async () => {
        // Arrange
        const rig = harness(() => ({}));

        // Act
        const result = await verifyCommitSignature(rig.ctx, {
          payload: PAYLOAD,
          signature: 'garbage',
        });

        // Assert
        expect(result.result).toBe('N');
        expect(rig.requests).toHaveLength(0);
      });
    });
  });

  describe.each([
    ['the runner throws', 'throw' as const],
    ['the shell reports command not found', { exitCode: 127, stderr: 'sh: gpg: not found\n' }],
    ['the shell reports not executable', { exitCode: 126, stderr: 'sh: gpg: denied\n' }],
  ])('Given %s', (_title, outcome) => {
    describe('When an openpgp signature is verified', () => {
      it('Then the result is N with empty output and the buffer is removed', async () => {
        // Arrange
        const rig = harness(() => outcome);

        // Act
        const result = await verifyCommitSignature(rig.ctx, {
          payload: PAYLOAD,
          signature: PGP_SIG,
        });

        // Assert
        expect(result).toMatchObject({ result: 'N', trust: 'undefined', output: '' });
        expect(await rig.ctx.fs.exists(rig.bufferPath)).toBe(false);
      });
    });
  });

  describe('Given the ssh verifier cannot be executed', () => {
    describe('When an ssh signature is verified', () => {
      it('Then the result is B with the never trust and empty output', async () => {
        // Arrange
        const rig = harness(() => 'throw');

        // Act
        const result = await verifyCommitSignature(rig.ctx, {
          payload: PAYLOAD,
          signature: SSH_SIG,
          gpg: { ssh: { allowedSignersFile: '/allowed' } },
        });

        // Assert
        expect(result).toMatchObject({ result: 'B', trust: 'never', output: '' });
      });
    });
  });

  describe('Given a runner aborted through the context signal', () => {
    describe('When the signature is verified', () => {
      it('Then the abort is rethrown and the buffer is removed', async () => {
        // Arrange
        const controller = new AbortController();
        const rig = harness(() => {
          controller.abort();
          return 'throw';
        });
        const aborted = { ...rig.ctx, signal: controller.signal };

        // Act
        const act = verifyCommitSignature(aborted, { payload: PAYLOAD, signature: PGP_SIG });

        // Assert
        await expect(act).rejects.toThrow('spawn failed');
        expect(await rig.ctx.fs.exists(rig.bufferPath)).toBe(false);
      });
    });
  });

  describe('Given a context signal', () => {
    describe('When the signature is verified', () => {
      it('Then the signal is passed to the runner', async () => {
        // Arrange
        const rig = harness(() => ({}));
        const signal = new AbortController().signal;

        // Act
        await verifyCommitSignature(
          { ...rig.ctx, signal },
          { payload: PAYLOAD, signature: PGP_SIG },
        );

        // Assert
        expect(rig.requests[0]?.signal).toBe(signal);
      });
    });
  });

  describe('Given a successful verification', () => {
    describe('When it completes', () => {
      it('Then neither the buffer nor the stderr capture file remain', async () => {
        // Arrange
        const rig = harness(() => ({ stdout: status('GOODSIG K Who'), stderr: 'note\n' }));

        // Act
        await verifyCommitSignature(rig.ctx, { payload: PAYLOAD, signature: PGP_SIG });

        // Assert
        expect(await rig.ctx.fs.exists(rig.bufferPath)).toBe(false);
        expect(await rig.ctx.fs.exists(`${rig.bufferPath}.err`)).toBe(false);
      });
    });
  });

  describe('Given a runner that fails the removal of the buffer', () => {
    describe('When the signature is verified', () => {
      it('Then the removal error surfaces rather than being swallowed', async () => {
        // Arrange
        const rig = harness(() => ({}));
        const failing = {
          ...rig.ctx,
          fs: {
            ...rig.ctx.fs,
            read: rig.ctx.fs.read.bind(rig.ctx.fs),
            write: rig.ctx.fs.write.bind(rig.ctx.fs),
            rm: async () => {
              throw new Error('disk on fire');
            },
          },
        } as Context;

        // Act
        const act = verifyCommitSignature(failing, { payload: PAYLOAD, signature: PGP_SIG });

        // Assert
        await expect(act).rejects.toThrow('disk on fire');
      });
    });
  });

  describe('Given a runner that leaves no stderr capture file', () => {
    describe('When the signature is verified', () => {
      it('Then the output is empty', async () => {
        // Arrange
        const ctx = createMemoryContext({
          command: { run: async () => ({ exitCode: 0 }) },
        });

        // Act
        const result = await verifyCommitSignature(ctx, { payload: PAYLOAD, signature: PGP_SIG });

        // Assert
        expect(result.output).toBe('');
      });
    });
  });

  describe('Given a stderr capture file that cannot be read', () => {
    describe('When the signature is verified', () => {
      it('Then the read error surfaces rather than being swallowed', async () => {
        // Arrange
        const base = createMemoryContext({
          command: { run: async () => ({ exitCode: 0, stdout: enc('') }) },
        });
        const failing = {
          ...base,
          fs: {
            ...base.fs,
            write: base.fs.write.bind(base.fs),
            rm: base.fs.rm.bind(base.fs),
            read: async () => {
              throw new Error('unreadable');
            },
          },
        } as Context;

        // Act
        const act = verifyCommitSignature(failing, { payload: PAYLOAD, signature: PGP_SIG });

        // Assert
        await expect(act).rejects.toThrow('unreadable');
      });
    });
  });
});
