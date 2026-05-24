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
}
