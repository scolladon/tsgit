import type { AuthorIdentity } from '../../../src/domain/objects/author-identity.ts';
import type { Repository } from '../../../src/repository.ts';

export interface ScenarioFile {
  readonly path: string;
  readonly content: string;
}

export interface ScenarioInputs {
  readonly files: ReadonlyArray<ScenarioFile>;
  readonly author: AuthorIdentity;
  readonly message: string;
}

export interface Scenario<TResult> {
  readonly name: string;
  readonly inputs: ScenarioInputs;
  readonly expected: TResult;
  readonly run: (repo: Repository, inputs: ScenarioInputs) => Promise<TResult>;
  /**
   * Runtimes this scenario is intentionally skipped on, with the reason
   * documented in the scenario itself. Example: `['workers']` for scenarios
   * that rely on lenient DecompressionStream behaviour not available in workerd.
   */
  readonly unsupportedRuntimes?: readonly string[];
}
