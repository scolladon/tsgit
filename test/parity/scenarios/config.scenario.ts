/**
 * Config parity scenario — drives set → get → unset at local scope and
 * captures the read-backs. Local scope reads/writes `.git/config` through
 * pure FS I/O (no transport, no POSIX), so it runs identically on Node,
 * Memory, and Browser/OPFS. Every `get` is scoped to `local` so a host
 * global gitconfig never bleeds into the golden.
 *
 * Surfaces closed: commands: config.
 */
import { AUTHOR, MESSAGES } from '../fixtures.ts';
import type { Scenario } from './types.ts';

interface ConfigResult {
  readonly setScope: string;
  readonly nameAfterSet: string | null | undefined;
  readonly emailAfterSet: string | null | undefined;
  readonly emailAfterUnset: string | null | undefined;
  readonly emailRemoved: boolean;
}

export const configScenario: Scenario<ConfigResult> = {
  name: 'config',
  inputs: {
    // Config CRUD does not touch the working tree; the inputs satisfy the
    // registry contract but the scenario body ignores them.
    files: [],
    author: AUTHOR,
    message: MESSAGES.seed,
  },
  expected: {
    setScope: 'local',
    nameAfterSet: 'Alice',
    emailAfterSet: 'alice@example.com',
    emailAfterUnset: undefined,
    emailRemoved: true,
  },
  run: async (repo) => {
    await repo.init();

    // 1) set two local keys.
    const set = await repo.config.set({ key: 'user.name', value: 'Alice', scope: 'local' });
    await repo.config.set({ key: 'user.email', value: 'alice@example.com', scope: 'local' });

    // 2) read them back.
    const name = await repo.config.get({ key: 'user.name', scope: 'local' });
    const email = await repo.config.get({ key: 'user.email', scope: 'local' });

    // 3) unset one and confirm it is gone.
    const unset = await repo.config.unset({ key: 'user.email', scope: 'local' });
    const after = await repo.config.get({ key: 'user.email', scope: 'local' });

    return {
      setScope: set.scope,
      nameAfterSet: name.value,
      emailAfterSet: email.value,
      emailAfterUnset: after.value,
      emailRemoved: unset.removed === true,
    };
  },
};
