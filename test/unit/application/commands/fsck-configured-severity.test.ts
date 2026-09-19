/**
 * `fsck.<msg-id>` re-typings driven end to end. Every pass that consults the
 * severity table — the object catalogue and both ref passes — must answer with
 * the CONFIGURED severity and with the exit bit that severity carries, not with
 * the catalogue default. Each expectation below was measured against git 2.55.0
 * on the same fixture shape.
 */
import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { type FsckFinding, fsck } from '../../../../src/application/commands/fsck.js';
import { __resetConfigCacheForTests } from '../../../../src/application/primitives/config-read.js';
import { looseObjectPath, objectsDir } from '../../../../src/application/primitives/path-layout.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import type { ObjectId } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';

const sut = fsck;

const ENCODER = new TextEncoder();

/** The three bits this file reasons about, spelled once. */
const BIT_CONTENT = 1;
const BIT_MISSING = 2;
const BIT_REFS_CONTENT = 8;

const AUTHOR = { name: 'Ada', email: 'ada@example.com' } as const;

/** A bare-ish memory repository with a HEAD the audit accepts. */
const initRepo = async (): Promise<Context> => {
  const ctx = createMemoryContext();
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
  return ctx;
};

/** Point `[fsck]` at one re-typing and drop the config the earlier writes cached. */
const configure = async (ctx: Context, body: string): Promise<void> => {
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, body);
  __resetConfigCacheForTests();
};

const looseBytes = (type: string, body: Uint8Array): Uint8Array => {
  const header = ENCODER.encode(`${type} ${body.length}\0`);
  const out = new Uint8Array(header.length + body.length);
  out.set(header, 0);
  out.set(body, header.length);
  return out;
};

/** Plant bytes no serializer would produce at their own loose path. */
const plantLoose = async (ctx: Context, raw: Uint8Array): Promise<ObjectId> => {
  const id = (await ctx.hash.hashHex(raw)) as ObjectId;
  await ctx.fs.mkdir(objectsDir(ctx.layout.gitDir, id.slice(0, 2)));
  await ctx.fs.writeExclusive(
    looseObjectPath(ctx.layout.gitDir, id),
    await ctx.compressor.deflate(raw),
  );
  return id;
};

const oidBytes = (id: ObjectId): Uint8Array => {
  const bytes = new Uint8Array(20);
  for (let i = 0; i < 20; i += 1)
    bytes[i] = Number.parseInt((id as string).slice(i * 2, 2 + i * 2), 16);
  return bytes;
};

/**
 * A repository whose only branch roots a commit carrying
 * `missingSpaceBeforeEmail` — an ERROR-default catalogue message.
 */
const repoWithBadCommit = async (): Promise<{ ctx: Context; commitId: ObjectId }> => {
  const ctx = await initRepo();
  const treeId = await writeObject(ctx, { type: 'tree', id: '' as ObjectId, entries: [] });
  const body = ENCODER.encode(
    `tree ${treeId}\nauthor Ada<${AUTHOR.email}> 1700000000 +0000\ncommitter Ada <${AUTHOR.email}> 1700000000 +0000\n\nmessage\n`,
  );
  const commitId = await plantLoose(ctx, looseBytes('commit', body));
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${commitId}\n`);
  return { ctx, commitId };
};

/**
 * A repository whose only branch roots a commit over a tree whose single entry
 * carries `modeText` verbatim: `0100644` reports `zeroPaddedFilemode` (a
 * WARNING default), `100666` reports `badFilemode` (an INFO default).
 */
const repoWithRawTreeMode = async (
  modeText: string,
): Promise<{ ctx: Context; treeId: ObjectId }> => {
  const ctx = await initRepo();
  const blobId = await writeObject(ctx, {
    type: 'blob',
    id: '' as ObjectId,
    content: ENCODER.encode('content'),
  });
  const prefix = ENCODER.encode(`${modeText} file.txt\0`);
  const treeBody = new Uint8Array(prefix.length + 20);
  treeBody.set(prefix, 0);
  treeBody.set(oidBytes(blobId), prefix.length);
  const treeId = await plantLoose(ctx, looseBytes('tree', treeBody));
  const commitId = await writeObject(ctx, {
    type: 'commit',
    id: '' as ObjectId,
    data: {
      tree: treeId,
      parents: [],
      author: { ...AUTHOR, timestamp: 1_700_000_000, timezoneOffset: '+0000' },
      committer: { ...AUTHOR, timestamp: 1_700_000_000, timezoneOffset: '+0000' },
      message: 'c1',
      extraHeaders: [],
    },
  });
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${commitId}\n`);
  return { ctx, treeId };
};

/** A healthy repository whose every loose ref is an ordinary file. */
const healthyRepo = async (): Promise<Context> => {
  const ctx = await initRepo();
  const treeId = await writeObject(ctx, { type: 'tree', id: '' as ObjectId, entries: [] });
  const commitId = await writeObject(ctx, {
    type: 'commit',
    id: '' as ObjectId,
    data: {
      tree: treeId,
      parents: [],
      author: { ...AUTHOR, timestamp: 1_700_000_000, timezoneOffset: '+0000' },
      committer: { ...AUTHOR, timestamp: 1_700_000_000, timezoneOffset: '+0000' },
      message: 'c1',
      extraHeaders: [],
    },
  });
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${commitId}\n`);
  return ctx;
};

/** A healthy repository carrying one loose ref that is a symbolic link. */
const repoWithSymlinkedRef = async (): Promise<Context> => {
  const ctx = await healthyRepo();
  await ctx.fs.symlink('refs/heads/main', `${ctx.layout.gitDir}/refs/heads/sym`);
  return ctx;
};

/** A repository whose one loose ref holds text that is not an object name. */
const repoWithGarbageRef = async (): Promise<Context> => {
  const ctx = await initRepo();
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/garbage`, 'not-a-valid-sha\n');
  return ctx;
};

type BadObject = Extract<FsckFinding, { type: 'bad-object' }>;
type BadRef = Extract<FsckFinding, { type: 'bad-ref' }>;

const badObjects = (findings: ReadonlyArray<FsckFinding>, msgId: string): BadObject[] =>
  findings.filter((f): f is BadObject => f.type === 'bad-object' && f.msgId === msgId);

const badRefs = (findings: ReadonlyArray<FsckFinding>, msgId: string): BadRef[] =>
  findings.filter((f): f is BadRef => f.type === 'bad-ref' && f.msgId === msgId);

// ---------------------------------------------------------------------------
// Object catalogue — the severity table reaches every catalogue finding
// ---------------------------------------------------------------------------

describe('Given an ERROR-default catalogue message softened to warn', () => {
  describe('When fsck runs', () => {
    it('Then the finding is reported as a warning and carries no content exit bit', async () => {
      // Arrange
      const { ctx, commitId } = await repoWithBadCommit();
      await configure(ctx, '[fsck]\n\tmissingSpaceBeforeEmail = warn\n');

      // Act
      const result = await sut(ctx);

      // Assert
      expect(badObjects(result.findings, 'missingSpaceBeforeEmail')).toEqual([
        {
          type: 'bad-object',
          id: commitId,
          objectType: 'commit',
          msgId: 'missingSpaceBeforeEmail',
          severity: 'warning',
        },
      ]);
      expect(result.exitCode & BIT_CONTENT).toBe(0);
    });
  });
});

describe('Given an ERROR-default catalogue message silenced outright', () => {
  describe('When fsck runs', () => {
    it('Then no finding is reported and the content exit bit goes with it', async () => {
      // Arrange
      const { ctx } = await repoWithBadCommit();
      await configure(ctx, '[fsck]\n\tmissingSpaceBeforeEmail = ignore\n');

      // Act
      const result = await sut(ctx);

      // Assert
      expect(badObjects(result.findings, 'missingSpaceBeforeEmail')).toEqual([]);
      expect(result.exitCode & BIT_CONTENT).toBe(0);
    });
  });
});

describe('Given a WARNING-default catalogue message hardened to error', () => {
  describe('When fsck runs', () => {
    it('Then the finding is reported as an error and raises the content exit bit', async () => {
      // Arrange
      const { ctx, treeId } = await repoWithRawTreeMode('0100644');
      await configure(ctx, '[fsck]\n\tzeroPaddedFilemode = error\n');

      // Act
      const result = await sut(ctx);

      // Assert
      expect(badObjects(result.findings, 'zeroPaddedFilemode')).toEqual([
        {
          type: 'bad-object',
          id: treeId,
          objectType: 'tree',
          msgId: 'zeroPaddedFilemode',
          severity: 'error',
        },
      ]);
      expect(result.exitCode & BIT_CONTENT).toBe(BIT_CONTENT);
    });
  });
});

describe('Given an INFO-default catalogue message hardened to error', () => {
  describe('When fsck runs', () => {
    it('Then the finding is reported as an error and raises the content exit bit', async () => {
      // Arrange
      const { ctx, treeId } = await repoWithRawTreeMode('100666');
      await configure(ctx, '[fsck]\n\tbadFilemode = error\n');

      // Act
      const result = await sut(ctx);

      // Assert
      expect(badObjects(result.findings, 'badFilemode')).toEqual([
        {
          type: 'bad-object',
          id: treeId,
          objectType: 'tree',
          msgId: 'badFilemode',
          severity: 'error',
        },
      ]);
      expect(result.exitCode & BIT_CONTENT).toBe(BIT_CONTENT);
    });
  });
});

describe('Given a non-empty table that says nothing about the message a check reports', () => {
  describe('When fsck runs', () => {
    it('Then the INFO catalogue default stands and no exit bit is raised', async () => {
      // Arrange
      const { ctx, treeId } = await repoWithRawTreeMode('100666');
      await configure(ctx, '[fsck]\n\tzeroPaddedFilemode = error\n');

      // Act
      const result = await sut(ctx);

      // Assert
      expect(badObjects(result.findings, 'badFilemode')).toEqual([
        {
          type: 'bad-object',
          id: treeId,
          objectType: 'tree',
          msgId: 'badFilemode',
          severity: 'info',
        },
      ]);
      expect(result.exitCode & BIT_CONTENT).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Refs pass — symlinkRef
// ---------------------------------------------------------------------------

describe('Given a symlinked ref whose WARNING default is hardened to error', () => {
  describe('When fsck runs', () => {
    it('Then the notice is reported as an error and raises the refs-content exit bit', async () => {
      // Arrange
      const ctx = await repoWithSymlinkedRef();
      await configure(ctx, '[fsck]\n\tsymlinkRef = error\n');

      // Act
      const result = await sut(ctx);

      // Assert
      expect(badRefs(result.findings, 'symlinkRef')).toEqual([
        { type: 'bad-ref', ref: 'refs/heads/sym', msgId: 'symlinkRef', severity: 'error' },
      ]);
      expect(result.exitCode & BIT_REFS_CONTENT).toBe(BIT_REFS_CONTENT);
    });
  });
});

describe('Given no symlinked ref at all and that notice hardened to error', () => {
  describe('When fsck runs', () => {
    it('Then nothing is reported and the refs-content exit bit stays clear', async () => {
      // Arrange — measured against git 2.55.0: the hardened severity raises the
      // bit only for a notice that actually fired, so a clean repository exits 0.
      const ctx = await healthyRepo();
      await configure(ctx, '[fsck]\n\tsymlinkRef = error\n');

      // Act
      const result = await sut(ctx);

      // Assert
      expect(badRefs(result.findings, 'symlinkRef')).toEqual([]);
      expect(result.exitCode & BIT_REFS_CONTENT).toBe(0);
      expect(result.exitCode).toBe(0);
    });
  });
});

describe('Given a symlinked ref silenced outright', () => {
  describe('When fsck runs', () => {
    it('Then no notice is reported and the audit exits clean', async () => {
      // Arrange
      const ctx = await repoWithSymlinkedRef();
      await configure(ctx, '[fsck]\n\tsymlinkRef = ignore\n');

      // Act
      const result = await sut(ctx);

      // Assert
      expect(badRefs(result.findings, 'symlinkRef')).toEqual([]);
      expect(result.exitCode).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Refs pass — badRefContent and the zero pointer beside it
// ---------------------------------------------------------------------------

describe('Given a ref whose content is not an object name, softened to warn', () => {
  describe('When fsck runs', () => {
    it('Then the notice warns, the zero pointer still errors, and only the missing bit stands', async () => {
      // Arrange
      const ctx = await repoWithGarbageRef();
      await configure(ctx, '[fsck]\n\tbadRefContent = warn\n');

      // Act
      const result = await sut(ctx);

      // Assert
      expect(badRefs(result.findings, 'badRefContent')).toEqual([
        {
          type: 'bad-ref',
          ref: 'refs/heads/garbage',
          msgId: 'badRefContent',
          severity: 'warning',
        },
      ]);
      expect(badRefs(result.findings, 'badRefOid')).toEqual([
        {
          type: 'bad-ref',
          ref: 'refs/heads/garbage',
          msgId: 'badRefOid',
          severity: 'error',
          target: '0'.repeat(40),
        },
      ]);
      expect(result.exitCode).toBe(BIT_MISSING);
    });
  });
});

describe('Given a ref whose content is not an object name, silenced outright', () => {
  describe('When fsck runs', () => {
    it('Then the notice is gone, the zero pointer stands alone, and only the missing bit stands', async () => {
      // Arrange
      const ctx = await repoWithGarbageRef();
      await configure(ctx, '[fsck]\n\tbadRefContent = ignore\n');

      // Act
      const result = await sut(ctx);

      // Assert
      expect(badRefs(result.findings, 'badRefContent')).toEqual([]);
      expect(badRefs(result.findings, 'badRefOid')).toEqual([
        {
          type: 'bad-ref',
          ref: 'refs/heads/garbage',
          msgId: 'badRefOid',
          severity: 'error',
          target: '0'.repeat(40),
        },
      ]);
      expect(result.exitCode).toBe(BIT_MISSING);
    });
  });
});

describe('Given the zero pointer silenced through the msg-id that names it', () => {
  describe('When fsck runs', () => {
    it('Then the pointer stands anyway — it is reported outside the catalogue', async () => {
      // Arrange
      const ctx = await repoWithGarbageRef();
      await configure(ctx, '[fsck]\n\tbadRefOid = ignore\n');

      // Act
      const result = await sut(ctx);

      // Assert
      expect(badRefs(result.findings, 'badRefOid')).toEqual([
        {
          type: 'bad-ref',
          ref: 'refs/heads/garbage',
          msgId: 'badRefOid',
          severity: 'error',
          target: '0'.repeat(40),
        },
      ]);
      expect(result.exitCode).toBe(BIT_MISSING | BIT_REFS_CONTENT);
    });
  });
});
