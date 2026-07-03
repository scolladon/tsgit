/**
 * Real-process integration smoke test for `NodeSshTransport`. Spawns a real
 * `sh` child to prove the production web-stream bridge (`Writable.toWeb` /
 * `Readable.toWeb`) round-trips real process I/O end-to-end — exhaustive
 * branch coverage lives in `test/unit/adapters/node/node-ssh-transport.test.ts`.
 *
 * @proves
 *   surface: sshTransport
 *   bucket:  real-process
 *   unique:  NodeSshTransport bridges a real child's stdin/stdout to web streams and reports its real exit code
 */
import { describe, expect, it } from 'vitest';
import { NodeSshTransport } from '../../src/adapters/node/node-ssh-transport.js';

const readAll = async (stream: ReadableStream<Uint8Array>): Promise<Uint8Array> => {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
};

describe('NodeSshTransport (real-process smoke)', () => {
  describe('Given a channel spawning `sh -c cat`', () => {
    describe('When bytes are written to stdin and stdin is closed', () => {
      it('Then the same bytes come back on stdout and exit resolves 0', async () => {
        // Arrange
        const sut = new NodeSshTransport();
        const channel = await sut.open({ command: 'sh', args: ['-c', 'cat'], env: {} });

        // Act
        const writer = channel.stdin.getWriter();
        await writer.write(new TextEncoder().encode('hello ssh'));
        await writer.close();
        const output = await readAll(channel.stdout);
        const exitCode = await channel.exit;

        // Assert
        expect(new TextDecoder().decode(output)).toBe('hello ssh');
        expect(exitCode).toBe(0);
      });
    });
  });

  describe('Given a channel spawning `sh -c "exit 3"`', () => {
    describe('When the process runs to completion', () => {
      it('Then exit resolves with the real exit code 3', async () => {
        // Arrange
        const sut = new NodeSshTransport();

        // Act
        const channel = await sut.open({ command: 'sh', args: ['-c', 'exit 3'], env: {} });
        const exitCode = await channel.exit;

        // Assert
        expect(exitCode).toBe(3);
      });
    });
  });
});
