/// <reference lib="dom" />
/**
 * Scenario 2 — Hash interop.
 *
 * Given a blob committed in the browser,
 * When the same id is read back via readBlob,
 * Then the bytes are identical to the original
 *   AND the SHA-1 of the canonical blob header matches Git's standard.
 *
 * Git stores blobs as `blob <size>\0<content>` and hashes that with SHA-1.
 * The known id of `hello\n` is `ce013625030ba8dba906f756967f9e9ca394464a` —
 * this asserts SubtleCrypto produces bit-identical output to Node's crypto.
 */
import { expect, test } from './fixtures.js';

const HELLO_BLOB_OID = 'ce013625030ba8dba906f756967f9e9ca394464a';

interface Primitives {
  readBlob: (id: string) => Promise<{ type: 'blob'; id: string; content: Uint8Array }>;
  writeObject: (obj: { type: 'blob'; id: string; content: Uint8Array }) => Promise<string>;
}
interface BrowserRepo {
  init: () => Promise<unknown>;
  primitives: Primitives;
  dispose: () => Promise<void>;
}
interface Tsgit {
  openRepository: (opts: { rootHandle: FileSystemDirectoryHandle }) => Promise<BrowserRepo>;
  adapters: {
    BrowserHashService: new () => { hashHex: (b: Uint8Array) => Promise<string> };
  };
}

test.describe('SubtleCrypto SHA-1 parity', () => {
  test('Given a blob with content "hello\\n", When hashed via BrowserHashService, Then the id matches Git canonical SHA-1', async ({
    readyPage,
  }) => {
    const oid = await readyPage.evaluate(async () => {
      const tsgit = (window as unknown as { __tsgit: Tsgit }).__tsgit;
      const content = new TextEncoder().encode('hello\n');
      const header = new TextEncoder().encode(`blob ${content.length}\0`);
      const framed = new Uint8Array(header.length + content.length);
      framed.set(header, 0);
      framed.set(content, header.length);
      const hash = new tsgit.adapters.BrowserHashService();
      return hash.hashHex(framed);
    });

    expect(oid).toBe(HELLO_BLOB_OID);
  });

  test('Given a blob committed via the repo facade, When readBlob loads it back, Then the bytes round-trip exactly', async ({
    browserName,
    readyPage,
  }) => {
    // Same OPFS gap as test/browser/opfs-roundtrip.spec.ts — webkit's headless
    // test browser doesn't expose navigator.storage.getDirectory().
    test.skip(browserName === 'webkit', 'OPFS not exposed in Playwright WebKit');
    const roundTrip = await readyPage.evaluate(async () => {
      const tsgit = (window as unknown as { __tsgit: Tsgit }).__tsgit;
      const rootHandle = await navigator.storage.getDirectory();
      const repo = await tsgit.openRepository({ rootHandle });
      try {
        await repo.init();
        const expected = new TextEncoder().encode('roundtrip\n');
        const id = await repo.primitives.writeObject({ type: 'blob', id: '', content: expected });
        const blob = await repo.primitives.readBlob(id);
        // Return as decoded text and the explicit byte arrays so the Playwright
        // diff surfaces meaningful context on mismatch instead of "false".
        return {
          id,
          returnedId: blob.id,
          expectedText: new TextDecoder().decode(expected),
          actualText: new TextDecoder().decode(blob.content),
          expectedBytes: Array.from(expected),
          actualBytes: Array.from(blob.content),
        };
      } finally {
        await repo.dispose();
      }
    });

    expect(roundTrip.id).toMatch(/^[0-9a-f]{40}$/);
    expect(roundTrip.returnedId).toBe(roundTrip.id);
    expect(roundTrip.actualText).toBe(roundTrip.expectedText);
    expect(roundTrip.actualBytes).toEqual(roundTrip.expectedBytes);
  });
});
