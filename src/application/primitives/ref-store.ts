/**
 * Loose-first-then-packed ref lookup with mtime-based packed-refs cache invalidation.
 */
import type { ObjectId, RefName } from '../../domain/objects/index.js';
import {
  type PackedRefs,
  parseLooseRef,
  parsePackedRefs,
  serializeDirectRef,
} from '../../domain/refs/index.js';
import type { Context } from '../../ports/context.js';
import { commonGitDir, looseRefPath, packedRefsPath, perWorktreeRefDir } from './path-layout.js';

export interface RefStore {
  /**
   * Resolve a ref name to its direct ObjectId target, without following symbolic refs.
   * Returns undefined if the ref doesn't exist in either loose or packed storage.
   * Throws if the loose file content is a symbolic ref (callers must handle).
   */
  resolveDirect(name: RefName): Promise<ResolveDirectResult>;
  writeLoose(name: RefName, id: ObjectId): Promise<void>;
  removeLoose(name: RefName): Promise<void>;
  isLoose(name: RefName): Promise<boolean>;
  readLooseRaw(name: RefName): Promise<string | undefined>;
  getPackedRefs(): Promise<PackedRefs>;
}

export type ResolveDirectResult =
  | { readonly kind: 'direct'; readonly id: ObjectId }
  | { readonly kind: 'symbolic'; readonly target: RefName }
  | { readonly kind: 'missing' };

/**
 * Per-Context store cache. Mirrors the registryCache pattern in read-object —
 * a session that resolves N refs reuses one parsed packed-refs (with mtime-keyed
 * invalidation inside the closure) instead of re-parsing on every call.
 */
const storeCache = new WeakMap<Context, RefStore>();

export function getRefStore(ctx: Context): RefStore {
  let store = storeCache.get(ctx);
  if (store === undefined) {
    store = createRefStore(ctx);
    storeCache.set(ctx, store);
  }
  return store;
}

export function createRefStore(ctx: Context): RefStore {
  let packedCache: { readonly parsed: PackedRefs; readonly mtimeKey: string } | undefined;

  const refDir = (name: RefName): string => perWorktreeRefDir(ctx, name);

  async function loadPackedRefs(): Promise<PackedRefs> {
    const path = packedRefsPath(commonGitDir(ctx));
    if (!(await ctx.fs.exists(path))) {
      return { entries: [], peeling: 'none', sorted: false };
    }
    const stat = await ctx.fs.stat(path);
    const key = `${stat.mtimeMs}:${stat.size}`;
    if (packedCache !== undefined && packedCache.mtimeKey === key) {
      return packedCache.parsed;
    }
    const content = await ctx.fs.readUtf8(path);
    const parsed = parsePackedRefs(content);
    packedCache = { parsed, mtimeKey: key };
    return parsed;
  }

  async function readLooseContent(name: RefName): Promise<string | undefined> {
    const path = looseRefPath(refDir(name), name);
    if (!(await ctx.fs.exists(path))) return undefined;
    return ctx.fs.readUtf8(path);
  }

  return {
    async resolveDirect(name: RefName): Promise<ResolveDirectResult> {
      const looseContent = await readLooseContent(name);
      if (looseContent !== undefined) {
        const parsed = parseLooseRef(looseContent);
        if (parsed.type === 'symbolic') {
          return { kind: 'symbolic', target: parsed.target };
        }
        return { kind: 'direct', id: parsed.target };
      }
      const packed = await loadPackedRefs();
      for (const entry of packed.entries) {
        if (entry.name === name) {
          return { kind: 'direct', id: entry.id };
        }
      }
      return { kind: 'missing' };
    },

    async writeLoose(name: RefName, id: ObjectId): Promise<void> {
      const path = looseRefPath(refDir(name), name);
      await ctx.fs.writeUtf8(path, serializeDirectRef(id));
    },

    async removeLoose(name: RefName): Promise<void> {
      const path = looseRefPath(refDir(name), name);
      if (await ctx.fs.exists(path)) {
        await ctx.fs.rm(path);
      }
    },

    async isLoose(name: RefName): Promise<boolean> {
      return ctx.fs.exists(looseRefPath(refDir(name), name));
    },

    async readLooseRaw(name: RefName): Promise<string | undefined> {
      return readLooseContent(name);
    },

    getPackedRefs: loadPackedRefs,
  };
}
