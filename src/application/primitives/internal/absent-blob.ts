import { TsgitError } from '../../../domain/error.js';

const ABSENT_BLOB_CODES = new Set(['OBJECT_NOT_FOUND', 'UNEXPECTED_OBJECT_TYPE']);

/**
 * git reads an index blob through `read_blob_data_from_index`, which yields
 * NULL for a missing object or one that is not a blob. Any other failure
 * (a corrupt or undecodable object) stays loud: it is damage, not absence.
 */
export const undefinedWhenBlobAbsent = async <T>(
  read: () => Promise<T>,
): Promise<T | undefined> => {
  try {
    return await read();
  } catch (err) {
    if (err instanceof TsgitError && ABSENT_BLOB_CODES.has(err.data.code)) return undefined;
    throw err;
  }
};
