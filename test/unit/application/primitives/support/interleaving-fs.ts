/**
 * A file-system double that forces the interleaving a case-insensitive disk
 * allows: a symlink is created between another task's leading-path scan and
 * that task's write. Paths under `foldUnder` are lower-cased before reaching
 * the inner file system, so `A` and `a` are one entry on every platform; the
 * git directory is never folded.
 *
 * Gate 1: `symlink` resolves only after an `lstat` of a path folding to its
 * own resolved (the competing scan has looked), or after one macrotask when it
 * is the only operation in flight (nobody else is racing it).
 * Gate 2: a `write` / `writeStream` whose leading prefix folds to a pending
 * symlink path waits for that symlink to exist.
 * Recorder: every `write`, `writeStream` and `mkdir` lists the leading
 * prefixes that are symlinks at that instant, in `recorded`.
 */
import type { FileStat, FileSystem } from '../../../../../src/ports/file-system.js';

export interface SymlinkTraversal {
  readonly op: 'write' | 'writeStream' | 'mkdir';
  readonly path: string;
  readonly prefix: string;
}

export interface InterleavingFs {
  readonly fs: FileSystem;
  readonly recorded: SymlinkTraversal[];
}

interface InterleavingOpts {
  readonly foldUnder: string;
}

type Waiter = () => void;

const GIT_DIR_SEGMENT = '.git';
const nextMacrotask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const leadingPrefixes = (path: string): string[] => {
  const segments = path.split('/');
  return segments.slice(1, -1).map((_segment, i) => segments.slice(0, i + 2).join('/'));
};

export const createInterleavingFs = (inner: FileSystem, opts: InterleavingOpts): InterleavingFs => {
  const recorded: SymlinkTraversal[] = [];
  const lstattedSpellings = new Map<string, Set<string>>();
  const pendingSymlinks = new Set<string>();
  const waiters = new Set<Waiter>();
  let inFlight = 0;

  const fold = (path: string): string => {
    const root = `${opts.foldUnder}/`;
    if (!path.startsWith(root) || path.startsWith(`${root}${GIT_DIR_SEGMENT}/`)) return path;
    return `${root}${path.slice(root.length).toLowerCase()}`;
  };

  const wake = (): void => {
    for (const waiter of [...waiters]) waiter();
  };
  const untilWoken = (): Promise<void> =>
    new Promise((resolve) => {
      const waiter: Waiter = () => {
        waiters.delete(waiter);
        resolve();
      };
      waiters.add(waiter);
    });

  const tracked = async <T>(run: () => Promise<T>): Promise<T> => {
    inFlight += 1;
    try {
      return await run();
    } finally {
      inFlight -= 1;
      wake();
    }
  };

  const recordTraversals = async (
    op: SymlinkTraversal['op'],
    path: string,
    folded: string,
  ): Promise<void> => {
    for (const prefix of leadingPrefixes(folded)) {
      const stat = await inner.tryLstat?.(prefix);
      if (stat?.isSymbolicLink) recorded.push({ op, path, prefix });
    }
  };

  const awaitPendingLeadingSymlink = async (folded: string): Promise<void> => {
    while (leadingPrefixes(folded).some((prefix) => pendingSymlinks.has(prefix))) {
      await untilWoken();
    }
  };

  const gatedWrite =
    <A extends unknown[]>(
      op: 'write' | 'writeStream',
      run: (folded: string, ...rest: A) => Promise<FileStat>,
    ) =>
    async (path: string, ...rest: A): Promise<FileStat> => {
      const folded = fold(path);
      if (leadingPrefixes(folded).length > 0) await nextMacrotask();
      await awaitPendingLeadingSymlink(folded);
      return tracked(async () => {
        await recordTraversals(op, path, folded);
        return run(folded, ...rest);
      });
    };

  const isCompeting = (folded: string, spelling: string): boolean =>
    [...(lstattedSpellings.get(folded) ?? [])].some((seen) => seen !== spelling);

  const awaitCompetingLstat = async (folded: string, spelling: string): Promise<void> => {
    while (!isCompeting(folded, spelling)) {
      if (inFlight === 1) {
        await nextMacrotask();
        if (inFlight === 1) return;
      } else {
        await untilWoken();
      }
    }
  };

  const symlink = async (target: string, path: string): Promise<void> => {
    const folded = fold(path);
    pendingSymlinks.add(folded);
    await tracked(async () => {
      await awaitCompetingLstat(folded, path);
      await inner.symlink(target, folded);
    });
    pendingSymlinks.delete(folded);
    wake();
  };

  const lstat: FileSystem['lstat'] = (path) =>
    tracked(async () => {
      const folded = fold(path);
      try {
        return await inner.lstat(folded);
      } finally {
        const spellings = lstattedSpellings.get(folded) ?? new Set<string>();
        spellings.add(path);
        lstattedSpellings.set(folded, spellings);
      }
    });

  const mkdir: FileSystem['mkdir'] = (path) =>
    tracked(async () => {
      const folded = fold(path);
      await recordTraversals('mkdir', path, folded);
      await inner.mkdir(folded);
    });

  const overrides: Partial<FileSystem> = {
    symlink,
    lstat,
    mkdir,
    write: gatedWrite('write', (folded, data: Uint8Array) => inner.write(folded, data)),
    writeStream: gatedWrite('writeStream', (folded, source: AsyncIterable<Uint8Array>) =>
      inner.writeStream(folded, source),
    ),
  };

  const fs = new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop in overrides) return overrides[prop as keyof FileSystem];
      const member = Reflect.get(target, prop, receiver);
      if (typeof member !== 'function') return member;
      return (...args: unknown[]) => {
        const folded = args.map((arg, i) =>
          typeof arg === 'string' && (i === 0 || (prop === 'rename' && i === 1)) ? fold(arg) : arg,
        );
        const result: unknown = member.apply(target, folded);
        return result instanceof Promise ? tracked(() => result) : result;
      };
    },
  });
  return { fs, recorded };
};
