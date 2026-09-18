/**
 * The refs one `updateRef` call touches, as git's own ref transaction
 * splits them at each symbolic hop. `resolveWriteChain` picks the walk:
 * git's default dereferences through every symbolic ref it meets; `noDeref`
 * (git's `--no-deref`) acts on the given name itself.
 */
import { errorDataCode } from '../../../domain/error-data-code.js';
import type { ObjectId, RefName } from '../../../domain/objects/index.js';
import { refCycleDetected } from '../../../domain/refs/error.js';
import type { RefStore, ResolveDirectResult } from '../ref-store.js';
import { resolveDirectChain } from '../resolve-ref.js';
import { MAX_SYMBOLIC_REF_DEPTH } from '../types.js';

export interface RefWriteChain {
  /** Symbolic refs walked from the given name, in order; empty for a direct
   *  name or under `noDeref`. */
  readonly links: readonly RefName[];
  /** The ref whose value changes: the walk's end, or the given name under
   *  `noDeref`. */
  readonly terminal: RefName;
  /** The value the compare-and-swap reads and every entry's old id carries. */
  readonly old: ObjectId | 'absent';
  /** `noDeref` on a symbolic ref whose referent is absent: the name exists,
   *  its value does not. Always `false` when dereferencing. */
  readonly danglingSymref: boolean;
  /** Whether the terminal's OWN stored value is itself a symbolic ref —
   *  only reachable under `noDeref` (the dereferencing walk never stops on
   *  a symbolic value). Selects the reftable-only "kept, not tombstoned"
   *  delete log shape. */
  readonly terminalIsSymbolic: boolean;
}

const directIdOrAbsent = (value: ResolveDirectResult): ObjectId | 'absent' =>
  value.kind === 'direct' ? value.id : 'absent';

/** git's split loop: follow every symbolic hop; a name met twice is git's
 *  "multiple updates" refusal. The walk has no depth cap because git's own
 *  has none — its ref transaction splits at every hop it meets, and a write
 *  through a fifty-hop chain still lands on that chain's end (measured, git
 *  2.55.0), where a READ of the same chain stops at five. A `Set` keeps
 *  membership O(1), so an uncapped chain costs no O(n²) scan. */
async function walkSymbolicChain(store: RefStore, name: RefName): Promise<RefWriteChain> {
  const links: RefName[] = [];
  const seen = new Set<RefName>();
  let current = name;
  for (;;) {
    if (seen.has(current)) throw refCycleDetected([...links, current]);
    seen.add(current);
    const value = await store.resolveDirect(current);
    if (value.kind !== 'symbolic') {
      return {
        links,
        terminal: current,
        old: directIdOrAbsent(value),
        danglingSymref: false,
        terminalIsSymbolic: false,
      };
    }
    links.push(current);
    // Both stores hand back a target that already passed `validateRefName`:
    // `parseLooseRef` validates it, and the reftable decoder gates it through
    // `isSafeRefName`.
    current = value.target;
  }
}

/** The referent read failures git's `refs_read_ref_full` folds into "does
 *  not resolve": a cycle, an over-deep chain, and content that is not a ref
 *  (neither an id nor a valid `ref: …` line). */
const UNREADABLE_REFERENT_CODES: ReadonlySet<string> = new Set([
  'REF_CYCLE_DETECTED',
  'REF_CHAIN_TOO_DEEP',
  'INVALID_OBJECT_ID',
  'INVALID_REF',
]);

/** `noDeref`'s referent read: reuses the read chain's own depth cap and
 *  cycle detection, mapping an unreadable referent to `'absent'` only when
 *  no old value is being checked — git writes then, logging a null old id —
 *  and letting the read's own refusal propagate when one is checked (git's
 *  "error reading reference"). Every I/O failure propagates. */
async function readReferentValue(
  store: RefStore,
  target: RefName,
  expected: ObjectId | 'absent' | undefined,
): Promise<ObjectId | 'absent'> {
  try {
    const outcome = await resolveDirectChain(store, target, MAX_SYMBOLIC_REF_DEPTH);
    return outcome.kind === 'found' ? outcome.id : 'absent';
  } catch (err) {
    const unreadable = UNREADABLE_REFERENT_CODES.has(errorDataCode(err) ?? '');
    if (expected === undefined && unreadable) return 'absent';
    throw err;
  }
}

/** `noDeref`: the given name is always the terminal. A direct name's old
 *  value is its own; a symbolic name's old value is its referent's,
 *  read through {@link readReferentValue}. */
async function resolveWithoutDeref(
  store: RefStore,
  name: RefName,
  expected: ObjectId | 'absent' | undefined,
): Promise<RefWriteChain> {
  const value = await store.resolveDirect(name);
  if (value.kind !== 'symbolic') {
    return {
      links: [],
      terminal: name,
      old: directIdOrAbsent(value),
      danglingSymref: false,
      terminalIsSymbolic: false,
    };
  }
  const old = await readReferentValue(store, value.target, expected);
  return {
    links: [],
    terminal: name,
    old,
    danglingSymref: old === 'absent',
    terminalIsSymbolic: true,
  };
}

export function resolveWriteChain(
  store: RefStore,
  name: RefName,
  options: { readonly noDeref?: boolean; readonly expected?: ObjectId | 'absent' },
): Promise<RefWriteChain> {
  return options.noDeref === true
    ? resolveWithoutDeref(store, name, options.expected)
    : walkSymbolicChain(store, name);
}
