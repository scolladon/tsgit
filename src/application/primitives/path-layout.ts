/**
 * Pure path helpers composing `ctx.config.gitDir` with known sub-paths.
 * No I/O. No port access. Primitive step 3.
 */
import type { ObjectId, RefName } from '../../domain/objects/index.js';
import { computeLooseObjectPath } from '../../domain/storage/loose-path.js';

export const looseObjectPath = (gitDir: string, id: ObjectId): string =>
  `${gitDir}/objects/${computeLooseObjectPath(id)}`;

export const looseRefPath = (gitDir: string, name: RefName): string => `${gitDir}/${name}`;

export const packedRefsPath = (gitDir: string): string => `${gitDir}/packed-refs`;

export const indexPath = (gitDir: string): string => `${gitDir}/index`;

export const objectsDir = (gitDir: string, prefix: string): string => `${gitDir}/objects/${prefix}`;

export const packsDir = (gitDir: string): string => `${gitDir}/objects/pack`;

export const lockSuffix = '.lock';
