import type { FsckFinding } from '../../../../src/application/commands/fsck.js';
import type { ObjectId } from '../../../../src/domain/objects/index.js';

/**
 * Collect every ObjectId-shaped value a finding may carry, across all
 * variants. One copy shared by the example suite and the property suite — a
 * new id-bearing variant updated in one oracle but not the other would
 * silently weaken the other's negative assertion while staying green.
 */
export const findingIds = (finding: FsckFinding): ReadonlyArray<ObjectId> => {
  const ids: ObjectId[] = [];
  if ('id' in finding) ids.push(finding.id);
  if ('fromId' in finding) ids.push(finding.fromId, finding.toId);
  if ('actual' in finding) ids.push(finding.actual);
  if ('target' in finding && finding.target !== undefined) ids.push(finding.target);
  if ('tag' in finding) ids.push(finding.tag);
  return ids;
};
