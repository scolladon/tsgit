/**
 * Pure path helpers composing `ctx.layout.gitDir` with known sub-paths.
 * No I/O. No port access. Primitive step 3.
 */
import type { ObjectId, RefName } from '../../domain/objects/index.js';
import type { FilePath } from '../../domain/objects/object-id.js';
import { computeLooseObjectPath } from '../../domain/storage/loose-path.js';
import type { Context } from '../../ports/context.js';

/**
 * Repository working-tree root. Returns the workDir from the current context;
 * facade-tier code is responsible for discovery / realpath pinning
 * at construction time. Primitives consume the already-resolved path.
 */
export const getRepoRoot = (ctx: Context): FilePath => ctx.layout.workDir as FilePath;

export const looseObjectPath = (gitDir: string, id: ObjectId): string =>
  `${gitDir}/objects/${computeLooseObjectPath(id)}`;

export const looseRefPath = (gitDir: string, name: RefName): string => `${gitDir}/${name}`;

export const packedRefsPath = (gitDir: string): string => `${gitDir}/packed-refs`;

export const indexPath = (gitDir: string): string => `${gitDir}/index`;

export const objectsDir = (gitDir: string, prefix: string): string => `${gitDir}/objects/${prefix}`;

export const packsDir = (gitDir: string): string => `${gitDir}/objects/pack`;

export const logsDir = (gitDir: string): string => `${gitDir}/logs`;

export const reflogPath = (gitDir: string, ref: RefName): string => `${gitDir}/logs/${ref}`;

export const sparseCheckoutPath = (gitDir: string): string => `${gitDir}/info/sparse-checkout`;

export const lockSuffix = '.lock';
