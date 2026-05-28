/**
 * @deprecated — Source of truth moved to `primitives/internal/read-gitignore.ts`.
 * This shim keeps the existing command imports working; new callers should
 * import from the primitives location.
 */
export {
  readGitignore,
  readGlobalExcludes,
  readInfoExclude,
} from '../../primitives/internal/read-gitignore.js';
