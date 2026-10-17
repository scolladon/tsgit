import type { EolSettings } from '../../../domain/eol/crlf-action.js';
import { hasEscapedBytes } from '../../../domain/objects/encoding.js';
import {
  FILE_MODE,
  type FileMode,
  type FilePath,
  type ObjectId,
} from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import { readBlob } from '../read-blob.js';
import {
  type Conversion,
  convertsInCore,
  isIdentityConversion,
  resolveConversion,
} from '../resolve-conversion.js';
import { type CheckoutMetadata, smudgesInCore } from './apply-smudge-filter.js';
import type { ConcurrencyLimiter } from './concurrency-limiter.js';
import { convertToWorkingTree, workingTreeStreamTransform } from './convert-blob.js';
import type { AttributeProvider } from './read-gitattributes.js';
import { serializeAndHash } from './serialize-and-hash.js';
import type { LeadingPathScanner } from './symlinked-leading-path.js';
import { writeWorkingTreeEntry, writeWorkingTreeEntryStream } from './write-working-tree-file.js';

export interface WorkingTreeWriterScope {
  readonly provider: () => Promise<AttributeProvider>;
  readonly settings: () => Promise<EolSettings>;
  /** Bounds smudge subprocesses: CPU/process-bound, narrower than the write wave. */
  readonly limiter: ConcurrencyLimiter;
  readonly metadata?: CheckoutMetadata;
}

export interface WorkingTreeWriter {
  readonly writeBlob: (
    path: FilePath,
    id: ObjectId,
    mode: FileMode,
    scanner?: LeadingPathScanner,
  ) => Promise<void>;
  readonly writeBytes: (
    path: FilePath,
    bytes: Uint8Array,
    mode: FileMode,
    scanner?: LeadingPathScanner,
  ) => Promise<void>;
}

const EMPTY_CONTENT = new Uint8Array();

const isConvertible = (mode: FileMode): boolean =>
  mode !== FILE_MODE.GITLINK && mode !== FILE_MODE.SYMLINK;

const concatChunks = (chunks: ReadonlyArray<Uint8Array>): Uint8Array => {
  const out = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
};

/** Stands in where no consumer reads the id: only an ident expansion and a filter's `blob=` metadata do. */
const NO_BLOB = '' as ObjectId;

const consumesBlobId = ({ ident, filter }: Conversion): boolean =>
  ident || filter.kind === 'external';

const blobIdOf = async (ctx: Context, bytes: Uint8Array): Promise<ObjectId> =>
  (await serializeAndHash(ctx, { type: 'blob', id: '' as ObjectId, content: bytes })).id;

export const createWorkingTreeWriter = (
  ctx: Context,
  scope: WorkingTreeWriterScope,
): WorkingTreeWriter => {
  const { metadata } = scope;

  const conversionFor = async (path: FilePath): Promise<Conversion> =>
    resolveConversion(ctx, await scope.provider(), path, await scope.settings(), {
      eagerSectionValidation: true,
    });

  const convertInCore = async (
    path: FilePath,
    blob: ObjectId,
    bytes: Uint8Array,
    conversion: Conversion,
  ): Promise<Uint8Array> => {
    const target = { path, blob, bytes, ...(metadata && { metadata }) };
    const settings = await scope.settings();
    const convert = () => convertToWorkingTree(ctx, { target, conversion, settings });
    // Only a smudge filter spawns a subprocess; the limiter is sized off cpuBound
    // so spawns stay bounded however wide the write wave runs.
    return smudgesInCore(conversion.filter) ? scope.limiter.run(convert) : convert();
  };

  const writeConvertibleBlob = async (
    path: FilePath,
    id: ObjectId,
    mode: FileMode,
    scanner?: LeadingPathScanner,
  ): Promise<void> => {
    const conversion = await conversionFor(path);
    if (convertsInCore(conversion)) {
      // A refused read leaves no file: nothing is opened before the blob is in memory.
      const blob = await readBlob(ctx, id);
      const content = await convertInCore(path, id, blob.content, conversion);
      await writeWorkingTreeEntry(ctx, path, content, mode, scanner);
      return;
    }
    const transform = workingTreeStreamTransform(conversion, id, await scope.settings());
    await writeWorkingTreeEntryStream(ctx, path, id, mode, scanner, transform);
  };

  const writeBlob: WorkingTreeWriter['writeBlob'] = async (path, id, mode, scanner) => {
    if (hasEscapedBytes(path)) return;
    if (mode === FILE_MODE.GITLINK) {
      await writeWorkingTreeEntry(ctx, path, EMPTY_CONTENT, mode, scanner);
      return;
    }
    if (mode === FILE_MODE.SYMLINK) {
      const blob = await readBlob(ctx, id);
      await writeWorkingTreeEntry(ctx, path, blob.content, mode, scanner);
      return;
    }
    await writeConvertibleBlob(path, id, mode, scanner);
  };

  const convertBytes = async (path: FilePath, bytes: Uint8Array): Promise<Uint8Array> => {
    const conversion = await conversionFor(path);
    // Stryker disable next-line ConditionalExpression: equivalent — for an identity conversion consumesBlobId is false (no ident, filter not external), convertsInCore is false and workingTreeStreamTransform returns undefined, so the fall-through returns the same bytes.
    if (isIdentityConversion(conversion)) return bytes;
    const blob = consumesBlobId(conversion) ? await blobIdOf(ctx, bytes) : NO_BLOB;
    if (convertsInCore(conversion)) return convertInCore(path, blob, bytes, conversion);
    const transform = workingTreeStreamTransform(conversion, blob, await scope.settings());
    if (transform === undefined) return bytes;
    return concatChunks([...transform.push(bytes), ...transform.flush()]);
  };

  const writeBytes: WorkingTreeWriter['writeBytes'] = async (path, bytes, mode, scanner) => {
    if (hasEscapedBytes(path)) return;
    const content = isConvertible(mode) ? await convertBytes(path, bytes) : bytes;
    await writeWorkingTreeEntry(ctx, path, content, mode, scanner);
  };

  return { writeBlob, writeBytes };
};
