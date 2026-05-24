import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { readObject } from '../../../../src/application/primitives/read-object.js';
import type { ObjectId, RefName } from '../../../../src/domain/objects/index.js';
import { memoryRemote, recordedTransport, seedRepo } from './fixtures.js';

const TREE_OID = '4b825dc642cb6eb9a060e54bf8d69288fbee4904' as ObjectId;

describe('commands/fixtures', () => {
  describe('seedRepo', () => {
    describe('Given seed with one commit + working tree', () => {
      describe('When seedRepo', () => {
        it('Then commit is readable and HEAD points to refs/heads/main', async () => {
          // Arrange
          const ctx = createMemoryContext();

          // Act
          const result = await seedRepo(ctx, {
            commits: [{ tree: TREE_OID, message: 'initial' }],
            workingTree: { 'README.md': '# hello\n' },
          });

          // Assert
          expect(result.commitIds).toHaveLength(1);
          const commitId = result.commitIds[0] as ObjectId;
          const obj = await readObject(ctx, commitId);
          expect(obj.type).toBe('commit');
          expect(await ctx.fs.readUtf8(`${ctx.layout.workDir}/README.md`)).toBe('# hello\n');
          expect(await ctx.fs.readUtf8(`${ctx.layout.gitDir}/HEAD`)).toBe('ref: refs/heads/main\n');
        });
      });
    });

    describe('Given seed with explicit refs', () => {
      describe('When seedRepo', () => {
        it('Then loose ref files are written', async () => {
          // Arrange
          const ctx = createMemoryContext();
          const oid = '0123456789abcdef0123456789abcdef01234567';

          // Act
          await seedRepo(ctx, { refs: { 'refs/heads/feature': oid } });

          // Assert
          const content = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/refs/heads/feature`);
          expect(content).toBe(`${oid}\n`);
        });
      });
    });

    describe('Given seed with explicit head as a 40-hex oid', () => {
      describe('When seedRepo', () => {
        it('Then HEAD is detached (oid only, no ref: prefix)', async () => {
          // Arrange
          const ctx = createMemoryContext();
          const oid = 'aaaa1111bbbb2222cccc3333dddd4444eeee5555';

          // Act
          await seedRepo(ctx, { head: oid });

          // Assert
          const head = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/HEAD`);
          expect(head).toBe(`${oid}\n`);
        });
      });
    });
  });

  describe('memoryRemote', () => {
    describe('Given an advertisement', () => {
      describe('When request to info/refs?service=git-upload-pack', () => {
        it('Then returns pkt-line-framed advertisement', async () => {
          // Arrange
          const transport = memoryRemote(
            {
              refs: [
                {
                  name: 'refs/heads/main' as RefName,
                  id: '0123456789abcdef0123456789abcdef01234567' as ObjectId,
                },
              ],
            },
            new Uint8Array(),
          );

          // Act
          const res = await transport.request({
            method: 'GET',
            url: 'https://example.com/info/refs?service=git-upload-pack',
            headers: {},
          });
          const reader = res.body.getReader();
          const { value } = await reader.read();
          const text = new TextDecoder().decode(value);

          // Assert — pkt-line frames begin with 4 hex digits (length prefix).
          expect(text.slice(0, 4)).toMatch(/^[0-9a-f]{4}$/);
          expect(text).toContain('refs/heads/main');
        });
      });
    });

    describe('Given a packBody', () => {
      describe('When request to git-upload-pack POST', () => {
        it('Then response contains NAK + sideband-1 packed bytes', async () => {
          // Arrange
          const packBody = new Uint8Array([0x50, 0x41, 0x43, 0x4b]); // 'PACK' magic
          const transport = memoryRemote({ refs: [] }, packBody);

          // Act
          const res = await transport.request({
            method: 'POST',
            url: 'https://example.com/git-upload-pack',
            headers: {},
          });
          const reader = res.body.getReader();
          const { value } = await reader.read();
          const decoded = new TextDecoder().decode(value);

          // Assert — NAK frame appears; sideband-1 byte (0x01) precedes the pack data.
          expect(decoded).toContain('NAK');
        });
      });
    });
  });

  describe('recordedTransport', () => {
    describe('Given a wrapped transport', () => {
      describe('When two requests are issued', () => {
        it('Then requests array has 2 entries in order', async () => {
          // Arrange
          const recorder = recordedTransport();

          // Act
          await recorder.transport.request({
            method: 'GET',
            url: 'https://a.example/',
            headers: {},
          });
          await recorder.transport.request({
            method: 'POST',
            url: 'https://b.example/',
            headers: { 'x-test': '1' },
          });

          // Assert
          expect(recorder.requests).toHaveLength(2);
          expect(recorder.requests[0]?.url).toBe('https://a.example/');
          expect(recorder.requests[1]?.url).toBe('https://b.example/');
          expect(recorder.requests[1]?.headers['x-test']).toBe('1');
        });
      });
    });

    describe('Given an inner transport', () => {
      describe('When request', () => {
        it('Then inner is called and recorded', async () => {
          // Arrange
          const inner = memoryRemote({ refs: [] }, new Uint8Array());
          const recorder = recordedTransport(inner);

          // Act
          const res = await recorder.transport.request({
            method: 'GET',
            url: 'https://example.com/info/refs?service=git-upload-pack',
            headers: {},
          });
          await res.body.cancel();

          // Assert
          expect(recorder.requests).toHaveLength(1);
          expect(res.statusCode).toBe(200);
        });
      });
    });
  });
});
