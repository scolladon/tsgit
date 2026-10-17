import { comparePaths } from '../../../domain/diff/index.js';
import { FILE_MODE, type FileMode, type FilePath } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import { boundedMapFor } from './concurrency.js';
import type { LeadingPathScanner } from './symlinked-leading-path.js';

export interface WaveWrite {
  readonly path: FilePath;
  readonly isLink: boolean;
  /** Throws on a path the write would refuse; runs before any directory is made for it. */
  readonly validate: () => void;
  readonly needsDirectories: boolean;
  readonly run: () => Promise<void>;
}

const byPath = (a: WaveWrite, b: WaveWrite): number => comparePaths(a.path, b.path);

const pool = (ctx: Context, writes: ReadonlyArray<WaveWrite>): Promise<void> =>
  boundedMapFor(ctx, 'ioBound', writes, (write) => write.run()).then(() => undefined);

// git's create_directories: a leading directory is made one component at a
// time and a link or file in its way is replaced, so no pooled write can be
// routed through a link another write of the wave has created. Memo keys are
// spellings and a case-folding disk answers for another one, so no verdict
// survives a link write.
const writeLinksFirst = async (
  writes: ReadonlyArray<WaveWrite>,
  scanner: LeadingPathScanner,
): Promise<void> => {
  for (const write of [...writes].sort(byPath)) {
    if (write.isLink) {
      await write.run();
      scanner.invalidateAll();
    } else if (write.needsDirectories) {
      write.validate();
      await scanner.ensureLeadingDirectories(write.path);
    }
  }
};

/**
 * Runs each batch pooled, in order. A wave holding a link first writes every
 * link sequentially and prepares the leading directories of the other writes,
 * so the pooled phase cannot race a link's creation; a link-free wave keeps
 * the plain pooled path.
 */
export const runLinkFirstWave = async (
  ctx: Context,
  batches: ReadonlyArray<ReadonlyArray<WaveWrite>>,
  scanner: LeadingPathScanner,
): Promise<void> => {
  if (!batches.some((batch) => batch.some((write) => write.isLink))) {
    for (const batch of batches) await pool(ctx, batch);
    return;
  }
  await writeLinksFirst(batches.flat(), scanner);
  for (const batch of batches)
    await pool(
      ctx,
      batch.filter((write) => !write.isLink),
    );
};

export const hasLinkMode = (modes: ReadonlyArray<FileMode | undefined>): boolean =>
  modes.includes(FILE_MODE.SYMLINK);

/** The sequential routes' counterpart of the wave's post-link reset: no memoised verdict outlives a link write. */
export const forgetAfterLink = (
  scanner: LeadingPathScanner,
  modes: ReadonlyArray<FileMode | undefined>,
): void => {
  if (hasLinkMode(modes)) scanner.invalidateAll();
};
