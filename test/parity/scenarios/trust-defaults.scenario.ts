/**
 * Trust-defaults scenario — proves the capability-omitted-is-trusted path:
 * with no trust option set, a repository initialises, commits and logs
 * normally, and the resolved layout carries neither `untrusted` nor
 * `implicitBare`. Runs identically on the Node, Memory and Browser drivers
 * since all three shims converge on the same layout-resolution path.
 *
 * Surfaces closed: commands: init, add, commit, log.
 */
import { AUTHOR, FILES, MESSAGES } from '../fixtures.ts';
import type { Scenario } from './types.ts';

interface TrustDefaultsResult {
  readonly untrustedPresent: boolean;
  readonly implicitBarePresent: boolean;
  readonly headId: string;
  readonly logLength: number;
}

export const trustDefaultsScenario: Scenario<TrustDefaultsResult> = {
  name: 'trust-defaults',
  inputs: { files: [FILES.helloA], author: AUTHOR, message: MESSAGES.seed },
  expected: {
    untrustedPresent: false,
    implicitBarePresent: false,
    headId: 'fa8b886eee0d470d870e786878657cac05d686e6',
    logLength: 1,
  },
  run: async (repo, inputs) => {
    await repo.init();
    await repo.add(['a.txt']);
    const committed = await repo.commit({ message: inputs.message, author: inputs.author });
    const log = await repo.log();

    return {
      untrustedPresent: repo.layout.untrusted === true,
      implicitBarePresent: repo.layout.implicitBare === true,
      headId: committed.id,
      logLength: log.length,
    };
  },
};
