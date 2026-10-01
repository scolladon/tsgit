const POSIX_ROOT = '/';
const UNC_SHARE = /^\\\\[^\\/]+[\\/][^\\/]+/;
const DRIVE = /^[A-Za-z]:/;
const WINDOWS_SEPARATOR = '\\';

/** The root a path hangs off: the POSIX root, a drive root or a UNC share. */
export const filesystemRootOf = (path: string): string => {
  const share = UNC_SHARE.exec(path);
  if (share !== null) return `${share[0].replaceAll('/', WINDOWS_SEPARATOR)}${WINDOWS_SEPARATOR}`;
  const drive = DRIVE.exec(path);
  if (drive !== null) return `${drive[0]}${WINDOWS_SEPARATOR}`;
  return POSIX_ROOT;
};
