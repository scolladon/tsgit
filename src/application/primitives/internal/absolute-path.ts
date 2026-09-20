/** True for a POSIX-absolute (`/…`) or Windows-absolute (`C:\…`) path. */
export const isAbsolutePath = (path: string): boolean =>
  path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path);
