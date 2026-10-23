import { TsgitError } from '../../../domain/error.js';
import { hasEntryBeneath } from '../../../domain/git-index/directory-file-conflict.js';
import type { IndexEntry } from '../../../domain/git-index/index-entry.js';
import type { FilePath, ObjectId } from '../../../domain/objects/object-id.js';
import type { Context } from '../../../ports/context.js';
import { type GitlinkCheckout, probeGitlinkCheckout } from './gitlink-head.js';

/** The repositories one command call meets, each classified once. */
export interface EmbeddedRepositories {
  /** The walk hook: no index entry lies beneath `directory`, and its .git leads to a repository. */
  readonly holds: (directory: FilePath) => Promise<boolean>;
  /** The commit checked out there; undefined when it is no repository, its HEAD does not resolve, or git refuses its format. */
  readonly headOf: (directory: FilePath) => Promise<ObjectId | undefined>;
}

export const embeddedRepositories = (
  ctx: Context,
  sorted: ReadonlyArray<IndexEntry>,
): EmbeddedRepositories => {
  const probed = new Map<FilePath, Promise<GitlinkCheckout>>();
  const checkoutOf = (directory: FilePath): Promise<GitlinkCheckout> => {
    const known = probed.get(directory);
    if (known !== undefined) return known;
    const probe = probeGitlinkCheckout(ctx, directory);
    probed.set(directory, probe);
    return probe;
  };
  const holds = async (directory: FilePath): Promise<boolean> => {
    // An indexed entry beneath the directory means git tracks it as a tree, so its .git is never looked at.
    if (hasEntryBeneath(sorted, directory)) return false;
    return (await checkoutOf(directory)).kind === 'repository';
  };
  const headOf = async (directory: FilePath): Promise<ObjectId | undefined> => {
    const checkout = await checkoutOf(directory);
    if (checkout.kind !== 'repository') return undefined;
    try {
      return await checkout.head();
    } catch (err) {
      // An unborn branch, an unparsable ref and a refused format are all git's "no commit checked out".
      if (err instanceof TsgitError) return undefined;
      throw err;
    }
  };
  return { holds, headOf };
};
