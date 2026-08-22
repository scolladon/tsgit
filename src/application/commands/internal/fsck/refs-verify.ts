import type { ObjectId } from '../../../../domain/objects/index.js';
import { zeroOid } from '../../../../domain/objects/index.js';
import type { Context } from '../../../../ports/context.js';
import { getRefStore } from '../../../primitives/ref-store.js';
import { EXIT_MISSING, EXIT_REFS_CONTENT } from './exit-codes.js';
import { objectIsPresent } from './object-presence.js';
import type { FsckFinding } from './types.js';

type BadRefFinding = FsckFinding & { readonly type: 'bad-ref' };

/**
 * Whether `oid` resolves to a readable object: present in `universe`, and,
 * when `universe` may optimistically admit an oid whose housing pack later
 * turns out inaccessible (`connectivityOnly`'s ungated pack half), confirmed
 * through `objectIsPresent` — the one loose-then-pack probe, shared with the
 * cache-tree check — rather than trusted at face value.
 */
async function isKnownOid(
  ctx: Context,
  universe: ReadonlySet<ObjectId>,
  oid: ObjectId,
  confirmPackAccessibility: boolean,
): Promise<boolean> {
  if (!universe.has(oid)) return false;
  if (!confirmPackAccessibility) return true;
  return objectIsPresent(ctx, oid);
}

/**
 * Verify ref content format and OID-reachability.
 *
 * Two sub-checks run independently:
 * - **Content format** (gated by `checkReferences`): a malformed loose ref —
 *   reported by the store's own `verifyIntegrity` as `badRefContent` —
 *   contributes `badRefContent` (bit 8, gated) + a synthesised zero-OID
 *   `badRefOid` (bit 2, always). Pinned: matrix #9b, composite exit 10 = 2|8.
 * - **OID presence** (always): every well-formed ref's OID (loose + packed,
 *   from `listRefs`) must be in the object universe, confirmed via
 *   `isKnownOid` rather than trusted at face value — `confirmPackAccessibility`
 *   is true exactly under `connectivityOnly`, the one mode where `universe`
 *   may admit an oid whose housing pack later fails its own header gate.
 *   Absent → `badRefOid` (bit 2). Pinned: matrix #9a, exit 2 same with/without
 *   `--no-references`. A symbolic ref (absent targets are not an error —
 *   unborn branch = OK, matrix #9c) never contributes.
 */
export async function runRefsVerifyPass(
  ctx: Context,
  universe: ReadonlySet<ObjectId>,
  checkContentFormat: boolean,
  confirmPackAccessibility: boolean,
): Promise<{ readonly findings: ReadonlyArray<BadRefFinding>; readonly exitBit: number }> {
  const findings: BadRefFinding[] = [];
  let exitBit = 0;

  const refStore = getRefStore(ctx);
  const [entries, integrityFindings] = await Promise.all([
    refStore.listRefs(),
    refStore.verifyIntegrity(),
  ]);

  for (const finding of integrityFindings) {
    if (finding.msgId !== 'badRefContent') continue;
    let bit = EXIT_MISSING; // synthesised zero-OID pointer always contributes bit 2
    if (checkContentFormat) {
      findings.push({
        type: 'bad-ref',
        ref: finding.ref,
        msgId: 'badRefContent',
        severity: 'error',
      });
      bit |= EXIT_REFS_CONTENT;
    }
    findings.push({
      type: 'bad-ref',
      ref: finding.ref,
      msgId: 'badRefOid',
      severity: 'error',
      target: zeroOid(ctx.hashConfig),
    });
    exitBit |= bit;
  }

  for (const entry of entries) {
    if (entry.value.kind !== 'direct') continue;
    if (await isKnownOid(ctx, universe, entry.value.id, confirmPackAccessibility)) continue;
    findings.push({
      type: 'bad-ref',
      ref: entry.name,
      msgId: 'badRefOid',
      severity: 'error',
      target: entry.value.id,
    });
    exitBit |= EXIT_MISSING;
  }

  return { findings, exitBit };
}
