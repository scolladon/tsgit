/**
 * Cross-adapter parity — inert-fallback baseline.
 *
 * Proves that with no CommandRunner wired (memory adapter default, or node
 * adapter with command:false), all three driver surfaces — clean@add,
 * smudge@checkout, worktree-clean@status, and textconv@diff — fall back to
 * the no-driver baseline: raw stage, verbatim checkout, raw-byte comparison,
 * raw OID diff.
 *
 * The proof is CROSS-ADAPTER ONLY: it does not verify faithfulness against
 * real git (that is the job of filter-clean-smudge-interop.test.ts and
 * diff-textconv-interop.test.ts). It proves the `ctx.command !== undefined`
 * guard fires correctly on every chokepoint so that repos without a runner are
 * inert and never throw.
 *
 * No real `git` binary is needed — the test is pure in-memory for memory
 * adapter and uses a local tmp dir (no spawned git) for node adapter.
 *
 * @proves
 *   surface:  add / checkout / status / diff
 *   bucket:   cross-adapter-parity
 *   unique:   memory adapter with filter=lfs + diff=lfs declares attributes
 *             but has no runner — raw stage / verbatim checkout / raw-based
 *             status / raw OID diff (inert fallback)
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../src/adapters/memory/memory-adapter.js';
import { createNodeContext } from '../../src/adapters/node/index.js';
import { add } from '../../src/application/commands/add.js';
import { checkout } from '../../src/application/commands/checkout.js';
import { commit } from '../../src/application/commands/commit.js';
import { diff } from '../../src/application/commands/diff.js';
import { init } from '../../src/application/commands/init.js';
import { status } from '../../src/application/commands/status.js';
import { readBlob } from '../../src/application/primitives/read-blob.js';
import { readIndex } from '../../src/application/primitives/read-index.js';
import type { ModifyChange } from '../../src/domain/diff/diff-change.js';
import type { AuthorIdentity, ObjectId } from '../../src/domain/objects/index.js';
import type { Context } from '../../src/ports/context.js';

const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

const AUTHOR: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

/**
 * Declares filter=lfs and diff=lfs on all .bin files.
 * This mirrors the lfs-pointer-interop.test.ts declared-but-inert setup.
 */
const GITATTRIBUTES = '*.bin filter=lfs diff=lfs\n';

/**
 * Git config that wires a clean and smudge driver under [filter "lfs"].
 * The driver commands would require `git-lfs` to be installed; without a
 * CommandRunner wired on the Context, the config section is irrelevant — the
 * inert fallback fires before any driver lookup.
 */
const GIT_CONFIG =
  '[filter "lfs"]\n\tclean = git-lfs clean -- %f\n\tsmudge = git-lfs smudge -- %f\n\trequired = true\n';

const RAW_CONTENT_V1 = 'hello lfs content\n';
const RAW_CONTENT_V2 = 'updated lfs content\n';

// ── Shared memory-adapter fixture ────────────────────────────────────────────

interface MemoryFixture {
  readonly ctx: Context;
  readonly v1BlobOid: ObjectId;
  readonly v2BlobOid: ObjectId;
  readonly c1Id: ObjectId;
  readonly c2Id: ObjectId;
}

const buildMemoryFixture = async (): Promise<MemoryFixture> => {
  const ctx = createMemoryContext();
  await init(ctx);

  // Write .gitattributes and git config with filter=lfs diff=lfs
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitattributes`, GITATTRIBUTES);
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, GIT_CONFIG);

  // Stage .gitattributes first so the filter attribute is in place for a.bin
  await add(ctx, ['.gitattributes']);

  // Write and stage a.bin — clean filter must NOT run (no runner wired)
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.bin`, RAW_CONTENT_V1);
  await add(ctx, ['a.bin']);

  // Capture blob OID after first add
  const idxAfterV1 = await readIndex(ctx);
  const entryV1 = idxAfterV1.entries.find((e) => e.path === 'a.bin');
  const v1BlobOid = entryV1!.id as ObjectId;

  // First commit so we have a HEAD
  const c1 = await commit(ctx, { message: 'add a.bin', author: AUTHOR });

  // Modify and stage a.bin — clean filter must NOT run
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.bin`, RAW_CONTENT_V2);
  await add(ctx, ['a.bin']);

  const idxAfterV2 = await readIndex(ctx);
  const entryV2 = idxAfterV2.entries.find((e) => e.path === 'a.bin');
  const v2BlobOid = entryV2!.id as ObjectId;

  const c2 = await commit(ctx, { message: 'update a.bin', author: AUTHOR });

  return { ctx, v1BlobOid, v2BlobOid, c1Id: c1.id, c2Id: c2.id };
};

// ── Shared node-adapter fixture (command:false — no runner) ──────────────────

interface NodeFixture {
  readonly ctx: Context;
  readonly tmpDir: string;
  readonly v1BlobOid: ObjectId;
  readonly v2BlobOid: ObjectId;
  readonly c1Id: ObjectId;
  readonly c2Id: ObjectId;
}

let nodeFixture: NodeFixture;

beforeAll(async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-filter-parity-'));
  // command:false — NodeCommandRunner is NOT wired; mirrors memory inert default
  const ctx = createNodeContext({ workDir: tmpDir, command: false, hooks: false });
  await init(ctx);

  await writeFile(path.join(tmpDir, '.gitattributes'), GITATTRIBUTES);
  await writeFile(path.join(tmpDir, '.git', 'config'), GIT_CONFIG);

  await add(ctx, ['.gitattributes']);

  await writeFile(path.join(tmpDir, 'a.bin'), RAW_CONTENT_V1);
  await add(ctx, ['a.bin']);

  const idxAfterV1 = await readIndex(ctx);
  const entryV1 = idxAfterV1.entries.find((e) => e.path === 'a.bin');
  const v1BlobOid = entryV1!.id as ObjectId;

  const c1 = await commit(ctx, { message: 'add a.bin', author: AUTHOR });

  await writeFile(path.join(tmpDir, 'a.bin'), RAW_CONTENT_V2);
  await add(ctx, ['a.bin']);

  const idxAfterV2 = await readIndex(ctx);
  const entryV2 = idxAfterV2.entries.find((e) => e.path === 'a.bin');
  const v2BlobOid = entryV2!.id as ObjectId;

  const c2 = await commit(ctx, { message: 'update a.bin', author: AUTHOR });

  nodeFixture = { ctx, tmpDir, v1BlobOid, v2BlobOid, c1Id: c1.id, c2Id: c2.id };
});

afterAll(async () => {
  await rm(nodeFixture.tmpDir, { recursive: true, force: true });
});

// ── Memory adapter — inert-fallback suite ────────────────────────────────────

describe('Given a memory repo declaring *.bin filter=lfs diff=lfs with no CommandRunner', () => {
  describe('When add stages a .bin file', () => {
    it('Then the stored blob contains verbatim raw bytes (no clean filter applied)', async () => {
      // Arrange
      const sut = await buildMemoryFixture();

      // Act — blob already staged in fixture; read it back
      const blobV1 = await readBlob(sut.ctx, sut.v1BlobOid);

      // Assert — raw bytes stored (clean filter not invoked)
      expect(dec(blobV1.content)).toBe(RAW_CONTENT_V1);
    });
  });

  describe('When checkout restores a .bin file', () => {
    it('Then the worktree file contains verbatim blob bytes (no smudge filter applied)', async () => {
      // Arrange — fixture committed v2; restore via checkout paths
      const sut = await buildMemoryFixture();

      // Remove working-tree file so checkout writes it fresh
      await sut.ctx.fs.rm(`${sut.ctx.layout.workDir}/a.bin`);

      // Act — checkout restores HEAD's a.bin (which holds RAW_CONTENT_V2 blob)
      await checkout(sut.ctx, { paths: ['a.bin'] });

      // Assert — worktree bytes equal the raw blob bytes (no smudge)
      const worktreeBytes = await sut.ctx.fs.read(`${sut.ctx.layout.workDir}/a.bin`);
      expect(dec(worktreeBytes)).toBe(RAW_CONTENT_V2);
    });
  });

  describe('When status is queried after a clean checkout', () => {
    it('Then status is clean (raw worktree bytes compared against raw blob)', async () => {
      // Arrange — checkout restores the HEAD blob verbatim
      const sut = await buildMemoryFixture();
      await sut.ctx.fs.rm(`${sut.ctx.layout.workDir}/a.bin`);
      await checkout(sut.ctx, { paths: ['a.bin'] });

      // Act
      const result = await status(sut.ctx);

      // Assert — a.bin not in changes; repo is clean
      const changedEntry = result.changes.find((c) => c.path === 'a.bin');
      expect(changedEntry).toBeUndefined();
      expect(result.clean).toBe(true);
    });
  });

  describe('When diff is called between c1 and c2', () => {
    it('Then changes contain a.bin as modify with raw OIDs (no textconv transformation)', async () => {
      // Arrange
      const sut = await buildMemoryFixture();

      // Act
      const treeDiff = await diff(sut.ctx, { from: sut.c1Id, to: sut.c2Id, recursive: true });

      // Assert — exactly one relevant change, raw OIDs (textconv never ran)
      const change = treeDiff.changes.find(
        (c): c is ModifyChange => c.type === 'modify' && c.path === 'a.bin',
      );
      expect(change).toBeDefined();
      expect(change?.type).toBe('modify');
      expect(change?.oldId).toBe(sut.v1BlobOid);
      expect(change?.newId).toBe(sut.v2BlobOid);
    });
  });
});

// ── Node adapter (command:false) — inert-fallback suite ──────────────────────

describe('Given a node repo (command:false) declaring *.bin filter=lfs diff=lfs with no CommandRunner', () => {
  describe('When add stages a .bin file', () => {
    it('Then the stored blob OID matches the memory adapter OID (raw bytes, no clean)', async () => {
      // Arrange — memory fixture for cross-adapter OID comparison
      const mem = await buildMemoryFixture();

      // Act — node fixture built in beforeAll; read blob back
      const nodeBlob = await readBlob(nodeFixture.ctx, nodeFixture.v1BlobOid);

      // Assert — same raw content AND same OID (SHA determinism across adapters)
      expect(dec(nodeBlob.content)).toBe(RAW_CONTENT_V1);
      expect(nodeFixture.v1BlobOid).toBe(mem.v1BlobOid);
    });
  });

  describe('When checkout restores a .bin file', () => {
    it('Then the worktree file contains verbatim blob bytes (no smudge)', async () => {
      // Arrange — remove file so checkout writes fresh
      await rm(path.join(nodeFixture.tmpDir, 'a.bin'), { force: true });

      // Act
      await checkout(nodeFixture.ctx, { paths: ['a.bin'] });

      // Assert — verbatim raw content (no smudge applied)
      const worktreeBytes = await readFile(path.join(nodeFixture.tmpDir, 'a.bin'), 'utf8');
      expect(worktreeBytes).toBe(RAW_CONTENT_V2);
    });
  });

  describe('When status is queried after a clean checkout', () => {
    it('Then status is clean — identical outcome to memory adapter', async () => {
      // Act
      const result = await status(nodeFixture.ctx);

      // Assert
      const changedEntry = result.changes.find((c) => c.path === 'a.bin');
      expect(changedEntry).toBeUndefined();
      expect(result.clean).toBe(true);
    });
  });

  describe('When diff is called between c1 and c2', () => {
    it('Then raw OIDs match the memory adapter OIDs (no textconv)', async () => {
      // Arrange — memory fixture for cross-adapter OID comparison
      const mem = await buildMemoryFixture();

      // Act
      const treeDiff = await diff(nodeFixture.ctx, {
        from: nodeFixture.c1Id,
        to: nodeFixture.c2Id,
        recursive: true,
      });

      // Assert — raw OIDs identical across adapters (parity)
      const change = treeDiff.changes.find(
        (c): c is ModifyChange => c.type === 'modify' && c.path === 'a.bin',
      );
      expect(change).toBeDefined();
      expect(change?.type).toBe('modify');
      expect(change?.oldId).toBe(nodeFixture.v1BlobOid);
      expect(change?.newId).toBe(nodeFixture.v2BlobOid);
      expect(change?.oldId).toBe(mem.v1BlobOid);
      expect(change?.newId).toBe(mem.v2BlobOid);
    });
  });
});
