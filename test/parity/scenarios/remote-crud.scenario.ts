/**
 * Remote CRUD parity scenario — drives add → setUrl → rename → remove and
 * captures one load-bearing fact: the URL after rename, which proves the
 * `[remote "upstream"]` block survived the section rename byte-for-byte.
 *
 * Surfaces closed (per 19.5a): commands: remote.
 */
import { AUTHOR, MESSAGES } from '../fixtures.ts';
import type { Scenario } from './types.ts';

interface RemoteCrudResult {
  readonly addedUrl: string;
  readonly addedFetchSpec: string;
  readonly pushUrlAfterSet: string | undefined;
  readonly renamedFrom: string;
  readonly renamedTo: string;
  readonly urlAfterRename: string;
  readonly fetchSpecAfterRename: string;
  readonly listAfterRename: ReadonlyArray<string>;
  readonly listAfterRemove: ReadonlyArray<string>;
}

export const remoteCrudScenario: Scenario<RemoteCrudResult> = {
  name: 'remote-crud',
  inputs: {
    // The remote CRUD pipeline does not touch the working tree; the inputs
    // satisfy the registry contract but the scenario body ignores them.
    files: [],
    author: AUTHOR,
    message: MESSAGES.seed,
  },
  expected: {
    addedUrl: 'https://example.com/r.git',
    addedFetchSpec: '+refs/heads/*:refs/remotes/origin/*',
    pushUrlAfterSet: 'git@example.com:r.git',
    renamedFrom: 'origin',
    renamedTo: 'upstream',
    urlAfterRename: 'https://example.com/r.git',
    fetchSpecAfterRename: '+refs/heads/*:refs/remotes/upstream/*',
    listAfterRename: ['upstream'],
    listAfterRemove: [],
  },
  run: async (repo) => {
    await repo.init();

    // 1) add origin.
    const added = await repo.remote.add({
      name: 'origin',
      url: 'https://example.com/r.git',
    });

    // 2) setUrl --push.
    await repo.remote.setUrl({
      name: 'origin',
      url: 'git@example.com:r.git',
      push: true,
    });
    const afterSet = await repo.remote.show({ name: 'origin' });

    // 3) rename origin → upstream.
    const renamed = await repo.remote.rename({
      from: 'origin',
      to: 'upstream',
    });
    const listAfter = await repo.remote.list();

    const upstream = listAfter.remotes[0];
    if (upstream === undefined) {
      throw new Error('remote.rename: upstream missing from list');
    }

    // 4) remove upstream.
    await repo.remote.remove({ name: 'upstream' });
    const finalList = await repo.remote.list();

    return {
      addedUrl: added.remote.url,
      addedFetchSpec: added.remote.fetchRefspecs[0] ?? '',
      pushUrlAfterSet: afterSet.remote.pushUrl,
      renamedFrom: renamed.from,
      renamedTo: renamed.to,
      urlAfterRename: upstream.url,
      fetchSpecAfterRename: upstream.fetchRefspecs[0] ?? '',
      listAfterRename: listAfter.remotes.map((r) => r.name),
      listAfterRemove: finalList.remotes.map((r) => r.name),
    };
  },
};
