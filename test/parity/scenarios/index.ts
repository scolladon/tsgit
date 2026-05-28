import { branchLifecycleScenario } from './branch-lifecycle.scenario.ts';
import { diffPipelineScenario } from './diff-pipeline.scenario.ts';
import { initAddCommitStatusScenario } from './init-add-commit-status.scenario.ts';
import { mergeAbortScenario } from './merge-abort.scenario.ts';
import { mergeContinueScenario } from './merge-continue.scenario.ts';
import { mergeFfScenario } from './merge-ff.scenario.ts';
import { phase202PrimitivesScenario } from './phase-20-2-primitives.scenario.ts';
import { readPipelineScenario } from './read-pipeline.scenario.ts';
import { refsPipelineScenario } from './refs-pipeline.scenario.ts';
import { remoteCrudScenario } from './remote-crud.scenario.ts';
import { resetRmReflogScenario } from './reset-rm-reflog.scenario.ts';
import { sparseCheckoutScenario } from './sparse-checkout.scenario.ts';
import { submodulesEmptyScenario } from './submodules-empty.scenario.ts';
import type { Scenario } from './types.ts';
import { writePipelineScenario } from './write-pipeline.scenario.ts';

export const SCENARIOS: ReadonlyArray<Scenario<unknown>> = [
  initAddCommitStatusScenario,
  branchLifecycleScenario,
  readPipelineScenario,
  refsPipelineScenario,
  writePipelineScenario,
  diffPipelineScenario,
  resetRmReflogScenario,
  mergeFfScenario,
  mergeAbortScenario,
  mergeContinueScenario,
  sparseCheckoutScenario,
  submodulesEmptyScenario,
  phase202PrimitivesScenario,
  remoteCrudScenario,
];
