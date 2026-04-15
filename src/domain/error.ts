import type { IndexError } from './git-index/error.js';
import type { DomainObjectError } from './objects/error.js';
import type { RefsError } from './refs/error.js';
import type { StorageError } from './storage/error.js';

export type TsgitErrorData = DomainObjectError | StorageError | RefsError | IndexError;

export class TsgitError extends Error {
  override readonly name = 'TsgitError';

  constructor(readonly data: TsgitErrorData) {
    super(`${data.code}: ${extractDetail(data)}`);
  }
}

function extractDetail(data: TsgitErrorData): string {
  switch (data.code) {
    case 'INVALID_OBJECT_ID':
    case 'INVALID_FILE_MODE':
      return data.value;
    case 'INVALID_OBJECT_HEADER':
    case 'INVALID_TREE_ENTRY':
    case 'INVALID_COMMIT':
    case 'INVALID_TAG':
    case 'INVALID_IDENTITY':
    case 'INVALID_PACK_HEADER':
    case 'INVALID_PACK_INDEX':
    case 'INVALID_PACK_ENTRY':
    case 'INVALID_DELTA':
    case 'INVALID_REF':
    case 'INVALID_PACKED_REFS':
    case 'INVALID_INDEX_HEADER':
    case 'INVALID_INDEX_ENTRY':
      return data.reason;
  }
}
