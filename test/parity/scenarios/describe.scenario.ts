/**
 * Describe scenario — seeds a root commit, tags it, then exercises
 * `repo.describe()` so the nearest-tag selection runs identically on Node and in
 * the browser. Uses a lightweight tag with `tags: true` (annotated-tag creation
 * is not on the facade), asserting the exact-match structured result.
 *
 * Surfaces closed:
 *   commands: describe
 */
import { AUTHOR, FILES, MESSAGES } from '../fixtures.ts';
import type { Scenario } from './types.ts';

interface DescribeScenarioResult {
  readonly name: string;
  readonly distance: number;
  readonly exact: boolean;
  readonly hasTag: boolean;
}

export const describeScenario: Scenario<DescribeScenarioResult> = {
  name: 'describe',
  inputs: { files: [FILES.helloA], author: AUTHOR, message: MESSAGES.seed },
  expected: {
    name: 'v1.0',
    distance: 0,
    exact: true,
    hasTag: true,
  },
  run: async (repo, inputs) => {
    await repo.init();
    await repo.add(['a.txt']);
    await repo.commit({ message: inputs.message, author: inputs.author });
    await repo.tag.create({ name: 'v1.0' });

    const result = await repo.describe(undefined, { tags: true });
    return {
      name: result.name,
      distance: result.distance,
      exact: result.exact,
      hasTag: result.tag !== undefined,
    };
  },
};
