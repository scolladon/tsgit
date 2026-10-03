/**
 * git's `check_filename` `lstat`: whether anything occupies `path` as the operating
 * system resolves it — `..` and symbolic links walked physically, wherever that leads,
 * outside the repository included. Existence only: nothing is read, nothing written.
 * Resolves `false` where git's `is_missing_file_error` holds (nothing there, or a
 * non-directory on the way); rejects with the mapped refusal for any other failure.
 */
export type FilenameProbe = (path: string) => Promise<boolean>;
