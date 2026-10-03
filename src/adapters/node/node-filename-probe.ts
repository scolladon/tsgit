/**
 * The node answer to the `FilenameProbe` port: a bare `lstat` on the path as given,
 * never normalised, so the operating system walks every `..` and link the way git's
 * `check_filename` sees them. It reaches outside the repository by design and only
 * ever learns whether something is there.
 */
import type { FilenameProbe } from '../../ports/filename-probe.js';
import { type FsOperations, realFsOps } from './fs-operations.js';
import { isErrnoException, mapErrno } from './node-file-system.js';

/** git's `is_missing_file_error`. */
const MISSING_FILE_ERRNOS: ReadonlySet<string | undefined> = new Set(['ENOENT', 'ENOTDIR']);

const presenceFrom = (error: unknown, path: string): false => {
  if (!isErrnoException(error)) throw error;
  if (MISSING_FILE_ERRNOS.has(error.code)) return false;
  throw mapErrno(error, path);
};

/** A `FilenameProbe` over the given `lstat`. */
export const filenameProbeOver =
  (ops: Pick<FsOperations, 'lstat'>): FilenameProbe =>
  async (path) => {
    try {
      await ops.lstat(path);
      return true;
    } catch (error) {
      return presenceFrom(error, path);
    }
  };

export const nodeFilenameProbe: FilenameProbe = filenameProbeOver(realFsOps);
