import { permissionDenied } from '../../domain/error.js';
import { errorDataCode } from '../../domain/error-data-code.js';
import type { Context } from '../../ports/context.js';
import type { FileSystem } from '../../ports/file-system.js';
import type { AlternatePathProbe, ObjectSourceAccess } from '../../ports/object-source-access.js';
import {
  type AlternateChainIo,
  type AlternateDiagnostic,
  resolveObjectSources,
} from './internal/alternate-chain.js';
import { readBigFileThreshold } from './internal/big-file-threshold.js';
import { createPromiseMemo, type PromiseMemo } from './internal/promise-memo.js';
import {
  assertRepoSettingsValid,
  repoSettingsVerdictSettled,
} from './internal/repo-settings-gate.js';
import type { SourceLocation } from './internal/source-location.js';
import { createPackRegistry, type PackRegistry } from './pack-registry.js';
import { commonGitDir } from './path-layout.js';

export interface ObjectSource extends SourceLocation {
  readonly local: boolean;
  readonly registry: PackRegistry;
}

export interface ObjectStore {
  readonly sources: ReadonlyArray<ObjectSource>;
  readonly primary: ObjectSource;
  readonly diagnostics: ReadonlyArray<AlternateDiagnostic>;
  readonly bigFileThreshold: number;
  refresh(): void;
  reprepare(): Promise<void>;
  dispose(): Promise<void>;
}

const ABSENT_LIST_CODES: ReadonlySet<string | undefined> = new Set([
  'FILE_NOT_FOUND',
  'NOT_A_DIRECTORY',
]);

const hasAlternatesList = async (ctx: Context, objectsDir: string): Promise<boolean> => {
  try {
    await ctx.fs.read(`${objectsDir}/info/alternates`);
    return true;
  } catch (error) {
    return !ABSENT_LIST_CODES.has(errorDataCode(error));
  }
};

const PARENT_SEGMENT = '..';

const isContained = (path: string, objectsDir: string): boolean =>
  path.startsWith(`${objectsDir}/`) && !path.split('/').includes(PARENT_SEGMENT);

const containedUtimeNow =
  (fs: FileSystem, objectsDir: string) =>
  async (path: string): Promise<void> => {
    if (!isContained(path, objectsDir)) throw permissionDenied(path);
    await fs.utimeNow?.(path);
  };

/**
 * A fresh, read-only view of `fs` for one object store: a write-mode open is refused outright and
 * the freshen touch is confined lexically to `objectsDir`, so a source can never be written through.
 */
export const narrowObjectSourceAccess = (
  fs: FileSystem,
  objectsDir: string,
): ObjectSourceAccess => ({
  read: fs.read.bind(fs),
  readUtf8: fs.readUtf8.bind(fs),
  readSlice: fs.readSlice.bind(fs),
  readdir: fs.readdir.bind(fs),
  stat: fs.stat.bind(fs),
  lstat: fs.lstat.bind(fs),
  exists: fs.exists.bind(fs),
  readlink: fs.readlink.bind(fs),
  openWithNoFollow: (path, mode) => {
    if (mode === 'write') return Promise.reject(permissionDenied(path));
    return fs.openWithNoFollow(path, mode);
  },
  ...(fs.utimeNow === undefined ? {} : { utimeNow: containedUtimeNow(fs, objectsDir) }),
});

const narrowProbe = (fs: FileSystem): AlternatePathProbe => ({
  lstat: fs.lstat.bind(fs),
  readlink: fs.readlink.bind(fs),
  stat: fs.stat.bind(fs),
});

const chainIo = (ctx: Context): AlternateChainIo => ({
  probe: () => narrowProbe(ctx.fs),
  reader: (objectsDir) => narrowObjectSourceAccess(ctx.fs, objectsDir),
});

const buildSource = async (
  ctx: Context,
  objectsDir: string,
  local: boolean,
): Promise<ObjectSource> => {
  const fs = local ? ctx.fs : narrowObjectSourceAccess(ctx.fs, objectsDir);
  return { objectsDir, fs, local, registry: await createPackRegistry(ctx, { objectsDir, fs }) };
};

interface Discovery {
  readonly alternates: ReadonlyArray<string>;
  readonly diagnostics: ReadonlyArray<AlternateDiagnostic>;
}

const discover = async (ctx: Context, objectsDir: string): Promise<Discovery> => {
  if (!(await hasAlternatesList(ctx, objectsDir))) return { alternates: [], diagnostics: [] };
  const { sources, diagnostics } = await resolveObjectSources(ctx, chainIo(ctx));
  const alternates = sources.filter((s) => !s.local).map((s) => s.objectsDir);
  return { alternates, diagnostics };
};

/** The store plus the one internal hook the session memo needs: bringing a stale list up to date. */
interface StoreHandle {
  readonly store: ObjectStore;
  readonly isStale: () => boolean;
  readonly resolveAgain: () => Promise<void>;
}

interface StoreState {
  sources: ReadonlyArray<ObjectSource>;
  diagnostics: ReadonlyArray<AlternateDiagnostic>;
  stale: boolean;
  inflight: Promise<void> | undefined;
}

/** Add-only: a source already held keeps its registry even when the list no longer names it. */
const appendDiscovered = async (ctx: Context, state: StoreState): Promise<void> => {
  const [primary] = state.sources as readonly [ObjectSource, ...ObjectSource[]];
  const found = await discover(ctx, primary.objectsDir);
  const known = new Set(state.sources.map((s) => s.objectsDir));
  const added: ObjectSource[] = [];
  for (const dir of found.alternates.filter((d) => !known.has(d))) {
    added.push(await buildSource(ctx, dir, false));
  }
  state.sources = [...state.sources, ...added];
  state.diagnostics = found.diagnostics;
};

const storeOver = (state: StoreState, bigFileThreshold: number): ObjectStore => {
  const [primary] = state.sources as readonly [ObjectSource, ...ObjectSource[]];
  return {
    get sources() {
      return state.sources;
    },
    primary,
    get diagnostics() {
      return state.diagnostics;
    },
    bigFileThreshold,
    refresh: () => {
      primary.registry.refresh();
      state.stale = true;
    },
    reprepare: async () => {
      await Promise.all(state.sources.map((s) => s.registry.reprepare()));
    },
    dispose: async () => {
      await Promise.all(state.sources.map((s) => s.registry.dispose()));
    },
  };
};

const resolveAgain = (ctx: Context, state: StoreState): Promise<void> => {
  if (state.inflight !== undefined) return state.inflight;
  state.stale = false;
  state.inflight = appendDiscovered(ctx, state).finally(() => {
    state.inflight = undefined;
  });
  return state.inflight;
};

const createHandle = (
  ctx: Context,
  primary: ObjectSource,
  discovery: Discovery,
  alternates: ReadonlyArray<ObjectSource>,
  bigFileThreshold: number,
): StoreHandle => {
  const state: StoreState = {
    sources: [primary, ...alternates],
    diagnostics: discovery.diagnostics,
    stale: false,
    inflight: undefined,
  };
  return {
    store: storeOver(state, bigFileThreshold),
    isStale: () => state.stale || state.inflight !== undefined,
    resolveAgain: () => resolveAgain(ctx, state),
  };
};

const buildHandle = async (ctx: Context): Promise<StoreHandle> => {
  const objectsDir = `${commonGitDir(ctx)}/objects`;
  const [primary, discovery, bigFileThreshold] = await Promise.all([
    buildSource(ctx, objectsDir, true),
    discover(ctx, objectsDir),
    readBigFileThreshold(ctx),
  ]);
  const alternates: ObjectSource[] = [];
  for (const dir of discovery.alternates) alternates.push(await buildSource(ctx, dir, false));
  return createHandle(ctx, primary, discovery, alternates, bigFileThreshold);
};

const memos = new WeakMap<Context['session'], PromiseMemo<StoreHandle>>();
const resolvedHandles = new WeakMap<Context['session'], StoreHandle>();

export const getObjectStore = async (ctx: Context): Promise<ObjectStore> => {
  if (!repoSettingsVerdictSettled(ctx)) await assertRepoSettingsValid(ctx);
  let memo = memos.get(ctx.session);
  if (memo === undefined) {
    memo = createPromiseMemo(() =>
      buildHandle(ctx).then((handle) => {
        resolvedHandles.set(ctx.session, handle);
        return handle;
      }),
    );
    memos.set(ctx.session, memo);
  }
  const handle = await memo.get();
  if (handle.isStale()) await handle.resolveAgain();
  return handle.store;
};

/** The settled store for a session whose repo-settings verdict is current; never starts a build. */
export const peekObjectStore = (ctx: Context): ObjectStore | undefined =>
  repoSettingsVerdictSettled(ctx) ? settledFreshStore(ctx) : undefined;

const settledFreshStore = (ctx: Context): ObjectStore | undefined => {
  const handle = resolvedHandles.get(ctx.session);
  return handle === undefined || handle.isStale() ? undefined : handle.store;
};

export const refreshObjectStore = (ctx: Context): void => {
  resolvedHandles.get(ctx.session)?.store.refresh();
};

/** Disposal never starts a build; a build that failed has nothing left to close. */
export const disposeObjectStore = async (ctx: Context): Promise<void> => {
  const pending = memos.get(ctx.session)?.peek();
  const handle = await pending?.catch(() => undefined);
  await handle?.store.dispose();
};

export interface ObjectSourcesView {
  readonly sources: ReadonlyArray<{ readonly objectsDir: string; readonly local: boolean }>;
  readonly unusable: ReadonlyArray<AlternateDiagnostic>;
}

/** Which object stores a session reads, and which listed alternates it could not use. */
export const objectSources = async (ctx: Context): Promise<ObjectSourcesView> => {
  const store = await getObjectStore(ctx);
  return {
    sources: store.sources.map(({ objectsDir, local }) => ({ objectsDir, local })),
    unusable: store.diagnostics,
  };
};
