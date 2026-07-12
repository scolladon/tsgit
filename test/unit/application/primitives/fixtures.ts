/**
 * Shared test fixtures for primitives —.
 */
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import type { GitIndex } from '../../../../src/domain/git-index/index-entry.js';
import { serializeIndex } from '../../../../src/domain/git-index/index-writer.js';
import { serializeObject } from '../../../../src/domain/objects/git-object.js';
import type { GitObject, ObjectId, RefName } from '../../../../src/domain/objects/index.js';
import { type PackedRefEntry, serializePackedRefs } from '../../../../src/domain/refs/index.js';
import { computeLooseObjectPath } from '../../../../src/domain/storage/loose-path.js';
import type { Context } from '../../../../src/ports/context.js';
import type { DirEntry, FileStat, FileSystem } from '../../../../src/ports/file-system.js';

export interface BuildSeededContextParts {
  readonly objects?: ReadonlyArray<GitObject>;
  readonly refs?: ReadonlyArray<{ readonly name: RefName; readonly id: ObjectId }>;
  readonly packedRefs?: ReadonlyArray<PackedRefEntry>;
  readonly index?: GitIndex;
  readonly signal?: AbortSignal;
}

export async function buildSeededContext(parts: BuildSeededContextParts = {}): Promise<Context> {
  const ctx =
    parts.signal === undefined
      ? createMemoryContext()
      : createMemoryContext({ signal: parts.signal });
  const { gitDir } = ctx.layout;

  // Seed objects
  for (const object of parts.objects ?? []) {
    const bytes = serializeObject(object, ctx.hashConfig);
    const id = (await ctx.hash.hashHex(bytes)) as ObjectId;
    const loosePath = `${gitDir}/objects/${computeLooseObjectPath(id)}`;
    const compressed = await ctx.compressor.deflate(bytes);
    await ctx.fs.write(loosePath, compressed);
  }

  // Seed loose refs
  for (const ref of parts.refs ?? []) {
    await ctx.fs.writeUtf8(`${gitDir}/${ref.name}`, `${ref.id}\n`);
  }

  // Seed packed-refs
  if (parts.packedRefs !== undefined && parts.packedRefs.length > 0) {
    const serialized = serializePackedRefs({
      entries: parts.packedRefs,
      peeling: 'none',
      sorted: false,
    });
    await ctx.fs.writeUtf8(`${gitDir}/packed-refs`, serialized);
  }

  // Seed index (with SHA1 trailer so parseIndex accepts it).
  if (parts.index !== undefined) {
    const indexBytes = await serializeIndexFixtureAsync(parts.index, ctx);
    await ctx.fs.write(`${gitDir}/index`, indexBytes);
  }

  return ctx;
}

/**
 * Instrument a Context by wrapping its fs with call-tracking. Returns the wrapped
 * context and a `calls()` accessor that returns the ordered list of fs operations.
 */
export interface InstrumentedContext {
  readonly ctx: Context;
  readonly calls: () => ReadonlyArray<{ readonly method: string; readonly path: string }>;
}

export function instrumentedContext(base: Context): InstrumentedContext {
  const log: Array<{ method: string; path: string }> = [];
  const record = (method: string, path: string): void => {
    log.push({ method, path });
  };

  const wrappedFs: FileSystem = {
    read: async (p) => {
      record('read', p);
      return base.fs.read(p);
    },
    readSlice: async (p, o, l) => {
      record('readSlice', p);
      return base.fs.readSlice(p, o, l);
    },
    readUtf8: async (p) => {
      record('readUtf8', p);
      return base.fs.readUtf8(p);
    },
    write: async (p, d) => {
      record('write', p);
      return base.fs.write(p, d);
    },
    writeStream: async (p, source) => {
      record('writeStream', p);
      return base.fs.writeStream(p, source);
    },
    writeExclusive: async (p, d) => {
      record('writeExclusive', p);
      return base.fs.writeExclusive(p, d);
    },
    writeUtf8: async (p, c) => {
      record('writeUtf8', p);
      return base.fs.writeUtf8(p, c);
    },
    appendUtf8: async (p, c) => {
      record('appendUtf8', p);
      return base.fs.appendUtf8(p, c);
    },
    exists: async (p) => {
      record('exists', p);
      return base.fs.exists(p);
    },
    stat: async (p): Promise<FileStat> => {
      record('stat', p);
      return base.fs.stat(p);
    },
    lstat: async (p): Promise<FileStat> => {
      record('lstat', p);
      return base.fs.lstat(p);
    },
    readdir: async (p): Promise<ReadonlyArray<DirEntry>> => {
      record('readdir', p);
      return base.fs.readdir(p);
    },
    mkdir: async (p) => {
      record('mkdir', p);
      return base.fs.mkdir(p);
    },
    rm: async (p) => {
      record('rm', p);
      return base.fs.rm(p);
    },
    rename: async (s, d) => {
      record('rename', `${s}->${d}`);
      return base.fs.rename(s, d);
    },
    readlink: async (p) => {
      record('readlink', p);
      return base.fs.readlink(p);
    },
    symlink: async (t, p) => {
      record('symlink', p);
      return base.fs.symlink(t, p);
    },
    chmod: async (p, m) => {
      record('chmod', p);
      return base.fs.chmod(p, m);
    },
    rmRecursive: async (p) => {
      record('rmRecursive', p);
      return base.fs.rmRecursive(p);
    },
    openWithNoFollow: async (p, m) => {
      record('openWithNoFollow', p);
      return base.fs.openWithNoFollow(p, m);
    },
    homedir: () => base.fs.homedir(),
    xdgConfigHome: () => base.fs.xdgConfigHome(),
    systemConfigPath: () => base.fs.systemConfigPath(),
  };

  const ctx: Context = {
    ...base,
    fs: wrappedFs,
  };
  return {
    ctx,
    calls: () => log.slice(),
  };
}

/**
 * Serialize a GitIndex through's serializeIndex, producing bytes
 * suitable for `ctx.fs.write('.git/index',...)`. readIndex tests
 * use this to round-trip without needing a writeIndex primitive.
 */
/**
 * Serialize a GitIndex with a trailing SHA1 checksum so that parseIndex
 * accepts the round-trip.'s `serializeIndex` omits the trailer;
 * this fixture adds it for readIndex tests.
 */
export async function serializeIndexFixtureAsync(
  index: GitIndex,
  ctx: Context,
): Promise<Uint8Array> {
  const body = serializeIndex(index);
  const hex = await ctx.hash.hashHex(body);
  const trailer = new Uint8Array(20);
  for (let i = 0; i < 20; i += 1) {
    trailer[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  const out = new Uint8Array(body.length + 20);
  out.set(body, 0);
  out.set(trailer, body.length);
  return out;
}

/**
 * Synchronous alias returning only the body (no trailer). Exposed for step 1
 * self-test which only checks size-shape, not parse round-trip.
 */
export function serializeIndexFixture(index: GitIndex): Uint8Array {
  return serializeIndex(index);
}
