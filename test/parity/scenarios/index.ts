import { archiveScenario } from './archive.scenario.ts';
import { bisectMidpointScenario } from './bisect-midpoint.scenario.ts';
import { bitmapClosureScenario } from './bitmap-closure.scenario.ts';
import { blameScenario } from './blame.scenario.ts';
import { branchLifecycleScenario } from './branch-lifecycle.scenario.ts';
import { bundleScenario } from './bundle.scenario.ts';
import { cherryPickScenario } from './cherry-pick.scenario.ts';
import { configScenario } from './config.scenario.ts';
import { describeScenario } from './describe.scenario.ts';
import { diffPipelineScenario } from './diff-pipeline.scenario.ts';
import { fsckScenario } from './fsck.scenario.ts';
import { fsckDegradedStoreScenario } from './fsck-degraded-store.scenario.ts';
import { grepScenario } from './grep.scenario.ts';
import { initAddCommitStatusScenario } from './init-add-commit-status.scenario.ts';
import { mergeAbortScenario } from './merge-abort.scenario.ts';
import { mergeContinueScenario } from './merge-continue.scenario.ts';
import { mergeFfScenario } from './merge-ff.scenario.ts';
import { midxReadDegradedScenario, midxReadScenario } from './midx-read.scenario.ts';
import { mvScenario } from './mv.scenario.ts';
import { nameRevScenario } from './name-rev.scenario.ts';
import { notesScenario } from './notes.scenario.ts';
import { packDegradedIdxScenario } from './pack-degraded-idx.scenario.ts';
import { packObjectsScenario } from './pack-objects.scenario.ts';
import { packV3ReadScenario } from './pack-v3-read.scenario.ts';
import { phase202PrimitivesScenario } from './phase-20-2-primitives.scenario.ts';
import { rangeDiffScenario } from './range-diff.scenario.ts';
import { readPipelineScenario } from './read-pipeline.scenario.ts';
import { rebaseScenario } from './rebase.scenario.ts';
import { refsPipelineScenario } from './refs-pipeline.scenario.ts';
import { remoteCrudScenario } from './remote-crud.scenario.ts';
import { resetRmReflogScenario } from './reset-rm-reflog.scenario.ts';
import { revListScenario } from './rev-list.scenario.ts';
import { revertScenario } from './revert.scenario.ts';
import { sha256ObjectFormatScenario } from './sha256-object-format.scenario.ts';
import { shallowWalkScenario } from './shallow-walk.scenario.ts';
import { shortlogScenario } from './shortlog.scenario.ts';
import { showScenario } from './show.scenario.ts';
import { sparseCheckoutScenario } from './sparse-checkout.scenario.ts';
import { stashScenario } from './stash.scenario.ts';
import { submodulesEmptyScenario } from './submodules-empty.scenario.ts';
import { trustDefaultsScenario } from './trust-defaults.scenario.ts';
import type { Scenario } from './types.ts';
import { whatchangedScenario } from './whatchanged.scenario.ts';
import { worktreeScenario } from './worktree.scenario.ts';
import { writePipelineScenario } from './write-pipeline.scenario.ts';

export const SCENARIOS: ReadonlyArray<Scenario<unknown>> = [
  archiveScenario,
  bisectMidpointScenario,
  bitmapClosureScenario,
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
  revListScenario,
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
  shallowWalkScenario,
  packV3ReadScenario,
  packDegradedIdxScenario,
  fsckDegradedStoreScenario,
  midxReadScenario,
  midxReadDegradedScenario,
  packObjectsScenario,
  trustDefaultsScenario,
  sha256ObjectFormatScenario,
];
