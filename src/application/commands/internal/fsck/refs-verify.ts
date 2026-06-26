import type { ObjectId, RefName } from '../../../../domain/objects/index.js';
import { ZERO_OID } from '../../../../domain/objects/index.js';
import type { Context } from '../../../../ports/context.js';
import { enumerateRefs } from '../../../primitives/enumerate-refs.js';
import { getRefStore } from '../../../primitives/ref-store.js';
import { EXIT_MISSING, EXIT_REFS_CONTENT } from './exit-codes.js';
import type { FsckFinding } from './types.js';

type BadRefFinding = FsckFinding & { readonly type: 'bad-ref' };

/** Matches valid SHA-1 (40-hex) or SHA-256 (64-hex) OID. */
const OID_RE = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

/**
 * Classify and report findings for a single loose ref's raw content.
 * Returns findings + accumulated exit-bit contribution.
 *
 * Content format check (badRefContent) gated by `checkContentFormat`.
 * Absent-OID check (badRefOid) always run, matching git's behaviour with
 * `--no-references` (pinned: matrix #9a, exit 2 both ways).
 */
function checkLooseRef(
  ref: RefName,
  raw: string,
  universe: ReadonlySet<ObjectId>,
  checkContentFormat: boolean,
): { readonly findings: ReadonlyArray<BadRefFinding>; readonly exitBit: number } {
  const content = raw.replace(/[\r\n]+$/, '');

  if (content.startsWith('ref: ')) {
    // Symref — absent symref targets are not an error (unborn branch = OK, matrix #9c)
    return { findings: [], exitBit: 0 };
  }

  if (!OID_RE.test(content)) {
    // Malformed content: badRefContent (gated) + synthesised zero-OID pointer (always)
    const badFindings: BadRefFinding[] = [];
    let bit = EXIT_MISSING; // zero-OID pointer always contributes bit 2
    if (checkContentFormat) {
      badFindings.push({ type: 'bad-ref', ref, msgId: 'badRefContent', severity: 'error' });
      bit |= EXIT_REFS_CONTENT;
    }
    badFindings.push({
      type: 'bad-ref',
      ref,
      msgId: 'badRefOid',
      severity: 'error',
      target: ZERO_OID,
    });
    return { findings: badFindings, exitBit: bit };
  }

  const oid = content as ObjectId;
  if (universe.has(oid)) return { findings: [], exitBit: 0 };
  // Valid OID format but absent from object store
  return {
    findings: [{ type: 'bad-ref', ref, msgId: 'badRefOid', severity: 'error', target: oid }],
    exitBit: EXIT_MISSING,
  };
}

/**
 * Verify ref content format and OID-reachability.
 *
 * Two sub-checks run independently:
 * - **Content format** (gated by `checkReferences`): loose-ref must be a hex OID or
 *   `ref: <target>`. Malformed → `badRefContent` (bit 8) + synthesised zero-OID → `badRefOid`
 *   (bit 2). Pinned: matrix #9b, composite exit 10 = 2|8.
 * - **OID presence** (always): ref OID (loose + packed) must be in object universe.
 *   Absent → `badRefOid` (bit 2). Pinned: matrix #9a, exit 2 same with/without `--no-references`.
 */
export async function runRefsVerifyPass(
  ctx: Context,
  universe: ReadonlySet<ObjectId>,
  checkContentFormat: boolean,
): Promise<{ readonly findings: ReadonlyArray<BadRefFinding>; readonly exitBit: number }> {
  const findings: BadRefFinding[] = [];
  let exitBit = 0;

  const refStore = getRefStore(ctx);
  const refNames = await enumerateRefs(ctx);

  for (const ref of refNames) {
    const raw = await refStore.readLooseRaw(ref);
    if (raw !== undefined) {
      const { findings: f, exitBit: b } = checkLooseRef(ref, raw, universe, checkContentFormat);
      findings.push(...f);
      exitBit |= b;
      continue;
    }

    // Not a loose ref — check packed-refs entry for OID presence
    const packed = await refStore.getPackedRefs();
    for (const entry of packed.entries) {
      if (entry.name !== ref) continue;
      if (!universe.has(entry.id)) {
        findings.push({
          type: 'bad-ref',
          ref,
          msgId: 'badRefOid',
          severity: 'error',
          target: entry.id,
        });
        exitBit |= EXIT_MISSING;
      }
      break;
    }
  }

  return { findings, exitBit };
}
