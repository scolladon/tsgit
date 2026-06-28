import { archiveScenario } from './archive.scenario.ts';
import { bisectMidpointScenario } from './bisect-midpoint.scenario.ts';
import { blameScenario } from './blame.scenario.ts';
import { branchLifecycleScenario } from './branch-lifecycle.scenario.ts';
import { bundleScenario } from './bundle.scenario.ts';
import { cherryPickScenario } from './cherry-pick.scenario.ts';
import { configScenario } from './config.scenario.ts';
import { describeScenario } from './describe.scenario.ts';
import { diffPipelineScenario } from './diff-pipeline.scenario.ts';
import { fsckScenario } from './fsck.scenario.ts';
import { grepScenario } from './grep.scenario.ts';
import { initAddCommitStatusScenario } from './init-add-commit-status.scenario.ts';
import { mergeAbortScenario } from './merge-abort.scenario.ts';
import { mergeContinueScenario } from './merge-continue.scenario.ts';
import { mergeFfScenario } from './merge-ff.scenario.ts';
import { mvScenario } from './mv.scenario.ts';
import { nameRevScenario } from './name-rev.scenario.ts';
import { notesScenario } from './notes.scenario.ts';
import { phase202PrimitivesScenario } from './phase-20-2-primitives.scenario.ts';
import { rangeDiffScenario } from './range-diff.scenario.ts';
import { readPipelineScenario } from './read-pipeline.scenario.ts';
import { rebaseScenario } from './rebase.scenario.ts';
import { refsPipelineScenario } from './refs-pipeline.scenario.ts';
import { remoteCrudScenario } from './remote-crud.scenario.ts';
import { resetRmReflogScenario } from './reset-rm-reflog.scenario.ts';
import { revertScenario } from './revert.scenario.ts';
import { shortlogScenario } from './shortlog.scenario.ts';
import { showScenario } from './show.scenario.ts';
import { sparseCheckoutScenario } from './sparse-checkout.scenario.ts';
import { stashScenario } from './stash.scenario.ts';
import { submodulesEmptyScenario } from './submodules-empty.scenario.ts';
import type { Scenario } from './types.ts';
import { whatchangedScenario } from './whatchanged.scenario.ts';
import { worktreeScenario } from './worktree.scenario.ts';
import { writePipelineScenario } from './write-pipeline.scenario.ts';

export const SCENARIOS: ReadonlyArray<Scenario<unknown>> = [
  archiveScenario,
  bisectMidpointScenario,
  bundleScenario,
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
  mvScenario,
  sparseCheckoutScenario,
  submodulesEmptyScenario,
  phase202PrimitivesScenario,
  remoteCrudScenario,
  configScenario,
  stashScenario,
  cherryPickScenario,
  revertScenario,
  rebaseScenario,
  showScenario,
  describeScenario,
  blameScenario,
  shortlogScenario,
  rangeDiffScenario,
  whatchangedScenario,
  nameRevScenario,
  notesScenario,
  worktreeScenario,
  grepScenario,
  fsckScenario,
];
