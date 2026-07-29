/**
 * Minimal filesystem surface the discovery walk needs to inspect candidate
 * `.git` paths — narrower than the full `FileSystem` port so discovery can
 * run before any bounded adapter exists. Kept out of the public ports
 * barrel: it is an internal collaborator of `findLayout`, not part of the
 * published type surface.
 */
export interface LayoutProbe {
  /**
   * Stats `path`, following symlinks. Resolves to `undefined` when the path
   * is absent, OR when a path-confined adapter rejects it as outside its
   * containment root (e.g. `MemoryFileSystem` throws `PERMISSION_DENIED`
   * for anything outside `rootDir`). Both cases mean "nothing usable here"
   * to the discovery walk — treating them alike is what lets the walk
   * terminate cleanly at a sandbox boundary instead of throwing. This is
   * the port's documented contract, not a swallowed error: see
   * `fileSystemLayoutProbe` for the single, tested place it is implemented.
   */
  readonly stat: (
    path: string,
  ) => Promise<
    { readonly isDirectory: boolean; readonly isFile: boolean; readonly size: number } | undefined
  >;
  /**
   * Reads `path` as UTF-8. Resolves to `undefined` under the same absence /
   * containment-denial contract as `stat`.
   */
  readonly readUtf8: (path: string) => Promise<string | undefined>;
}
