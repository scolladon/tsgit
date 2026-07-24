import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  NodeSshTransport,
  type SshTransportOps,
} from '../../../../src/adapters/node/node-ssh-transport.js';
import type { SshSpawnRequest } from '../../../../src/ports/ssh-channel.js';

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly kill = vi.fn();
}

interface SpawnCall {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly options: {
    readonly env: NodeJS.ProcessEnv;
    readonly stdio: ['pipe', 'pipe', 'inherit'];
    readonly signal?: AbortSignal;
  };
}

const makeHarness = (): {
  transport: NodeSshTransport;
  child: FakeChild;
  calls: SpawnCall[];
} => {
  const child = new FakeChild();
  const calls: SpawnCall[] = [];
  const ops: SshTransportOps = {
    spawn: (command, args, options) => {
      calls.push({ command, args, options });
      return child;
    },
  };
  return { transport: new NodeSshTransport(ops), child, calls };
};

const baseRequest = (over: Partial<SshSpawnRequest> = {}): SshSpawnRequest => ({
  command: 'ssh',
  args: ['git@example.com', "git-upload-pack '/repo.git'"],
  env: {},
  ...over,
});

describe('NodeSshTransport', () => {
  describe('Given a request with a resolved command and full argv', () => {
    describe('When open runs', () => {
      it('Then it spawns with that exact command and args', async () => {
        // Arrange
        const { transport: sut, calls } = makeHarness();
        const request = baseRequest({
          command: '/usr/bin/ssh',
          args: ['-p', '2222', 'git@example.com', "git-upload-pack '/r.git'"],
        });

        // Act
        await sut.open(request);

        // Assert
        expect(calls[0]?.command).toBe('/usr/bin/ssh');
        expect(calls[0]?.args).toEqual([
          '-p',
          '2222',
          'git@example.com',
          "git-upload-pack '/r.git'",
        ]);
        expect(calls[0]?.options.stdio).toEqual(['pipe', 'pipe', 'inherit']);
      });
    });
  });

  describe('Given req.env with a key not present in the parent environment', () => {
    describe('When open runs', () => {
      it('Then the spawned env carries both the addition and the parent env', async () => {
        // Arrange
        const { transport: sut, calls } = makeHarness();

        // Act
        await sut.open(baseRequest({ env: { TSGIT_SSH_TEST_VAR: 'v' } }));

        // Assert
        expect(calls[0]?.options.env.TSGIT_SSH_TEST_VAR).toBe('v');
        expect(calls[0]?.options.env.PATH).toBe(process.env.PATH);
      });
    });
  });

  describe('Given req.env overrides a key already set in the parent environment', () => {
    describe('When open runs', () => {
      it('Then req.env wins over the parent environment', async () => {
        // Arrange
        const { transport: sut, calls } = makeHarness();

        // Act
        await sut.open(baseRequest({ env: { PATH: 'overridden-path' } }));

        // Assert — kills the `{...process.env, ...req.env}` → `{...req.env, ...process.env}` mutant.
        expect(calls[0]?.options.env.PATH).toBe('overridden-path');
      });
    });
  });

  describe('Given a request with no signal', () => {
    describe('When open runs', () => {
      it('Then the spawn options carry no signal key', async () => {
        // Arrange
        const { transport: sut, calls } = makeHarness();

        // Act
        await sut.open(baseRequest());

        // Assert
        expect(Object.hasOwn(calls[0]?.options ?? {}, 'signal')).toBe(false);
      });
    });
  });

  describe('Given a request with a signal', () => {
    describe('When open runs', () => {
      it('Then the signal is forwarded to the spawn options', async () => {
        // Arrange
        const { transport: sut, calls } = makeHarness();
        const controller = new AbortController();

        // Act
        await sut.open(baseRequest({ signal: controller.signal }));

        // Assert
        expect(calls[0]?.options.signal).toBe(controller.signal);
      });
    });
  });

  describe('Given an open channel', () => {
    describe('When bytes are written to channel.stdin', () => {
      it('Then the underlying child stdin receives them', async () => {
        // Arrange
        const { transport: sut, child } = makeHarness();
        const seen: number[][] = [];
        child.stdin.on('data', (chunk: Uint8Array) => seen.push(Array.from(chunk)));
        const channel = await sut.open(baseRequest());

        // Act
        const writer = channel.stdin.getWriter();
        await writer.write(new Uint8Array([1, 2, 3]));
        await writer.close();

        // Assert
        expect(seen).toEqual([[1, 2, 3]]);
      });
    });

    describe('When the underlying child stdout emits bytes', () => {
      it('Then channel.stdout surfaces them', async () => {
        // Arrange
        const { transport: sut, child } = makeHarness();
        const channel = await sut.open(baseRequest());
        const reader = channel.stdout.getReader();

        // Act
        child.stdout.write(Buffer.from([9, 9, 9]));
        child.stdout.end();
        const { value } = await reader.read();

        // Assert
        expect(Array.from(value ?? [])).toEqual([9, 9, 9]);
      });
    });

    describe('When the child ends and channel.exit is awaited', () => {
      it.each([
        {
          emit: (c: FakeChild) => c.emit('close', 3),
          expectedExit: 3,
          label: 'a close event with an exit code resolves channel.exit with that code',
        },
        {
          emit: (c: FakeChild) => c.emit('close', null),
          expectedExit: 128,
          label: 'a close event with a null code (signal-killed) resolves channel.exit with 128',
        },
        {
          emit: (c: FakeChild) => c.emit('error', new Error('ENOENT')),
          expectedExit: 127,
          label: 'a spawn error resolves channel.exit with 127',
        },
      ])('Then $label', async ({ emit, expectedExit }) => {
        // Arrange
        const { transport: sut, child } = makeHarness();
        const channel = await sut.open(baseRequest());

        // Act
        emit(child);

        // Assert
        await expect(channel.exit).resolves.toBe(expectedExit);
      });
    });

    describe('When close() is called', () => {
      it('Then it kills the child and resolves once exit settles', async () => {
        // Arrange
        const { transport: sut, child } = makeHarness();
        const channel = await sut.open(baseRequest());

        // Act
        const closed = channel.close();
        child.emit('close', 0);
        await closed;

        // Assert
        expect(child.kill).toHaveBeenCalledOnce();
      });
    });
  });
});
