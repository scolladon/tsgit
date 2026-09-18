import type { FsckSeverityTable } from '../../../../domain/fsck/index.js';
import { retypeSeverity } from '../../../../domain/fsck/index.js';
import type { ObjectId } from '../../../../domain/objects/index.js';
import { zeroOid } from '../../../../domain/objects/index.js';
import type { Context } from '../../../../ports/context.js';
import type { RefIntegrityFinding, RefStore } from '../../../primitives/ref-store.js';
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
interface PassResult {
  readonly findings: ReadonlyArray<BadRefFinding>;
  readonly exitBit: number;
}

/**
 * git's deprecation notice for a symbolic link standing in for a symref:
 * one notice per link under `refs/`, defaulting to a warning that
 * contributes no exit bit — and re-typed, like every catalogue message, by
 * the repository's own `fsck.<msg-id>` table.
 */
function collectSymlinkNotices(
  integrityFindings: ReadonlyArray<RefIntegrityFinding>,
  severities: FsckSeverityTable,
): PassResult {
  const severity = retypeSeverity(severities, 'symlinkRef', 'warning');
  if (severity === 'ignore') return { findings: [], exitBit: 0 };
  const findings = integrityFindings
    .filter((finding) => finding.msgId === 'symlinkRef')
    .map(
      (finding): BadRefFinding => ({
        type: 'bad-ref',
        ref: finding.ref,
        msgId: 'symlinkRef',
        severity,
      }),
    );
  const exitBit = severity === 'error' && findings.length > 0 ? EXIT_REFS_CONTENT : 0;
  return { findings, exitBit };
}

/**
 * A ref whose content is not an object name: the content notice (gated by
 * `checkContentFormat`, and re-typable) plus the zero-OID pointer git
 * synthesises for it. That pointer is reported OUTSIDE the catalogue —
 * `fsck.badRefOid` does not reach it, measured against git 2.55.0 — so it
 * always stands, at error severity, contributing bit 2.
 */
function collectBadContentNotices(
  ctx: Context,
  integrityFindings: ReadonlyArray<RefIntegrityFinding>,
  checkContentFormat: boolean,
  severities: FsckSeverityTable,
): PassResult {
  const severity = retypeSeverity(severities, 'badRefContent', 'error');
  const reportContent = checkContentFormat && severity !== 'ignore';
  const findings: BadRefFinding[] = [];
  let exitBit = 0;
  for (const finding of integrityFindings) {
    if (finding.msgId !== 'badRefContent') continue;
    if (reportContent) {
      findings.push({ type: 'bad-ref', ref: finding.ref, msgId: 'badRefContent', severity });
    }
    findings.push({
      type: 'bad-ref',
      ref: finding.ref,
      msgId: 'badRefOid',
      severity: 'error',
      target: zeroOid(ctx.hashConfig),
    });
    exitBit |= EXIT_MISSING;
    if (reportContent && severity === 'error') exitBit |= EXIT_REFS_CONTENT;
  }
  return { findings, exitBit };
}

/** Every well-formed ref whose OID the object universe does not hold. */
async function collectAbsentTargets(
  ctx: Context,
  entries: Awaited<ReturnType<RefStore['listRefs']>>,
  universe: ReadonlySet<ObjectId>,
  confirmPackAccessibility: boolean,
): Promise<PassResult> {
  const findings: BadRefFinding[] = [];
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
  }
  return { findings, exitBit: findings.length > 0 ? EXIT_MISSING : 0 };
}

export async function runRefsVerifyPass(
  ctx: Context,
  universe: ReadonlySet<ObjectId>,
  checkContentFormat: boolean,
  confirmPackAccessibility: boolean,
  severities: FsckSeverityTable,
): Promise<PassResult> {
  const refStore = getRefStore(ctx);
  const [entries, integrityFindings] = await Promise.all([
    refStore.listRefs(),
    refStore.verifyIntegrity(),
  ]);

  const symlinks = collectSymlinkNotices(integrityFindings, severities);
  const badContent = collectBadContentNotices(
    ctx,
    integrityFindings,
    checkContentFormat,
    severities,
  );
  const absent = await collectAbsentTargets(ctx, entries, universe, confirmPackAccessibility);

  return {
    findings: [...symlinks.findings, ...badContent.findings, ...absent.findings],
    exitBit: symlinks.exitBit | badContent.exitBit | absent.exitBit,
  };
}
