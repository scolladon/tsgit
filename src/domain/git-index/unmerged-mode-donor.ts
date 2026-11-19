import type { FileMode } from '../objects/file-mode.js';

interface StagedModes {
  readonly stage1?: { readonly mode: FileMode };
  readonly stage2?: { readonly mode: FileMode };
  readonly stage3?: { readonly mode: FileMode };
}

/** git's index_name_pos_also_unmerged preference: ours (stage 2), else base (1), else theirs (3). */
export const unmergedModeDonor = (stages: StagedModes): FileMode | undefined =>
  (stages.stage2 ?? stages.stage1 ?? stages.stage3)?.mode;
