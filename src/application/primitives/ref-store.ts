/**
 * Loose-first-then-packed ref lookup with mtime-based packed-refs cache invalidation.
 */
import { TsgitError } from '../../domain/error.js';
import type { ObjectId, RefName } from '../../domain/objects/index.js';
import {
  type PackedRefs,
  parseLooseRef,
  parsePackedRefs,
  serializeDirectRef,
} from '../../domain/refs/index.js';
import type { Context } from '../../ports/context.js';
import {
  commonGitDir,
  looseObjectPath,
  looseRefPath,
  packedRefsPath,
  perWorktreeRefDir,
} from './path-layout.js';

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
  /**
   * Every ref this backend knows, merged across the per-worktree and common
   * scopes, deduplicated, sorted by name. An optional `prefix` restricts the
   * result to names starting with it (e.g. `refs/heads/`). A loose ref whose
   * content fails to parse is silently excluded — {@link verifyIntegrity}
   * reports it instead.
   */
  listRefs(prefix?: RefName): Promise<readonly RefEntry[]>;
  /**
   * Backend-owned ref-content health: loose refs whose body is neither a
   * well-formed OID nor a `ref: <target>` line (`badRefContent`), and
   * well-formed loose OIDs with no LOOSE object backing them
   * (`badRefOid`) — a cheap local-store probe, not a pack-aware
   * reachability audit. Independent of any external reachability scope.
   */
  verifyIntegrity(): Promise<readonly RefIntegrityFinding[]>;
}

export type ResolveDirectResult =
  | { readonly kind: 'direct'; readonly id: ObjectId }
  | { readonly kind: 'symbolic'; readonly target: RefName }
  | { readonly kind: 'missing' };

export interface RefEntry {
  readonly name: RefName;
  readonly value: ResolveDirectResult;
}

export type RefIntegrityFinding =
  | { readonly ref: RefName; readonly msgId: 'badRefContent' }
  | { readonly ref: RefName; readonly msgId: 'badRefOid'; readonly target: ObjectId };

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

/** Whether `name` exists in either loose or packed storage — the one seam every existence-probe caller shares. */
export async function refExists(ctx: Context, name: RefName): Promise<boolean> {
  return (await getRefStore(ctx).resolveDirect(name)).kind !== 'missing';
}

const HEAD_NAME: RefName = 'HEAD' as RefName;
const REFS_DIR = 'refs';
const SYMBOLIC_PREFIX = 'ref: ';
/** Matches valid SHA-1 (40-hex) or SHA-256 (64-hex) loose-ref content. */
const LOOSE_OID_RE = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

/** Byte-wise total order over ref names, matching git's own ref ordering (never `localeCompare`). */
const byName = (a: RefEntry, b: RefEntry): number => {
  if (a.name < b.name) return -1;
  if (a.name > b.name) return 1;
  return 0;
};

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

  async function resolveDirect(name: RefName): Promise<ResolveDirectResult> {
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
  }

  /** Recursively walk one `refs/**` root, composing slash-joined ref names as it descends. */
  async function walkRefDir(dir: string, prefix: string): Promise<ReadonlyArray<RefName>> {
    const entries = await ctx.fs.readdir(dir);
    const names: RefName[] = [];
    for (const entry of entries) {
      const rel = `${prefix}/${entry.name}`;
      if (entry.isDirectory) {
        for (const name of await walkRefDir(`${dir}/${entry.name}`, rel)) {
          names.push(name);
        }
      } else {
        names.push(rel as RefName);
      }
    }
    return names;
  }

  /**
   * Every loose ref name this Context can see: `HEAD` plus a full walk of
   * `refs/**` under both the worktree's own gitdir and the common dir (the
   * two roots collapse into a single walk when they're the same directory).
   */
  async function walkAllLooseRefNames(): Promise<ReadonlyArray<RefName>> {
    const names: RefName[] = [];
    if (await ctx.fs.exists(`${ctx.layout.gitDir}/HEAD`)) {
      names.push(HEAD_NAME);
    }
    const ownRefs = `${ctx.layout.gitDir}/${REFS_DIR}`;
    const commonRefs = `${commonGitDir(ctx)}/${REFS_DIR}`;
    const roots = ownRefs === commonRefs ? [ownRefs] : [ownRefs, commonRefs];
    for (const root of roots) {
      if (!(await ctx.fs.exists(root))) continue;
      for (const name of await walkRefDir(root, REFS_DIR)) {
        names.push(name);
      }
    }
    return names;
  }

  const matchesPrefix = (name: RefName, prefix: RefName | undefined): boolean =>
    prefix === undefined || name.startsWith(prefix);

  async function collectCandidateNames(prefix: RefName | undefined): Promise<ReadonlySet<RefName>> {
    const names = new Set<RefName>();
    for (const name of await walkAllLooseRefNames()) {
      if (matchesPrefix(name, prefix)) names.add(name);
    }
    const packed = await loadPackedRefs();
    for (const entry of packed.entries) {
      if (matchesPrefix(entry.name, prefix)) names.add(entry.name);
    }
    return names;
  }

  /**
   * Resolve one candidate name, or `undefined` when it isn't a usable ref
   * (fails to parse — `verifyIntegrity()` reports that case on its own terms
   * — or resolves to nothing). Excluding it here, rather than aborting,
   * keeps one bad entry from taking down enumeration of every OTHER ref.
   */
  async function resolveEntry(name: RefName): Promise<RefEntry | undefined> {
    let value: ResolveDirectResult;
    try {
      value = await resolveDirect(name);
    } catch (err) {
      if (err instanceof TsgitError) return undefined;
      throw err;
    }
    return value.kind === 'missing' ? undefined : { name, value };
  }

  async function listRefs(prefix?: RefName): Promise<readonly RefEntry[]> {
    const names = await collectCandidateNames(prefix);
    const entries: RefEntry[] = [];
    for (const name of names) {
      const entry = await resolveEntry(name);
      if (entry !== undefined) entries.push(entry);
    }
    return entries.sort(byName);
  }

  async function verifyIntegrity(): Promise<readonly RefIntegrityFinding[]> {
    const findings: RefIntegrityFinding[] = [];
    for (const name of await walkAllLooseRefNames()) {
      const raw = await readLooseContent(name);
      if (raw === undefined) continue;
      const content = raw.replace(/[\r\n]+$/, '');
      if (content.startsWith(SYMBOLIC_PREFIX)) continue;
      if (!LOOSE_OID_RE.test(content)) {
        findings.push({ ref: name, msgId: 'badRefContent' });
        continue;
      }
      const oid = content as ObjectId;
      // Loose-only: a pack-registry probe (multi-pack-index, delta bases…)
      // belongs to a caller's own reachability audit, not this grammar
      // check — fsck's refs-verify pass runs its own OID-presence check
      // against its scan-scoped universe once no `badRefContent` finding
      // has already flagged this ref.
      if (!(await ctx.fs.exists(looseObjectPath(commonGitDir(ctx), oid)))) {
        findings.push({ ref: name, msgId: 'badRefOid', target: oid });
      }
    }
    return findings;
  }

  return {
    resolveDirect,

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

    listRefs,
    verifyIntegrity,
  };
}
