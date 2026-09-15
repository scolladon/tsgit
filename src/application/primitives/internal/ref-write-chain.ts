/**
 * The refs one `updateRef` call touches, as git's own ref transaction
 * splits them at each symbolic hop. `resolveWriteChain` picks the walk:
 * git's default dereferences through every symbolic ref it meets; `noDeref`
 * (git's `--no-deref`) acts on the given name itself.
 */
import { errorDataCode } from '../../../domain/error-data-code.js';
import type { ObjectId, RefName } from '../../../domain/objects/index.js';
import { refCycleDetected } from '../../../domain/refs/error.js';
import { validateRefName } from '../../../domain/refs/ref-validation.js';
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
 *  "multiple updates" refusal. A `Set` keeps membership O(1) — this walk
 *  has no depth cap, so an O(n²) scan (the read path's own check) would
 *  scale with a hostile chain's own length. */
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
    current = validateRefName(value.target);
  }
}

/** `noDeref`'s referent read: reuses the read chain's own depth cap and
 *  cycle detection, mapping a cycle or over-depth chain to `'absent'` only
 *  when no old value is being checked (succeeds without one; refuses when
 *  one is checked). Every other failure propagates. */
async function readReferentValue(
  store: RefStore,
  target: RefName,
  expected: ObjectId | 'absent' | undefined,
): Promise<ObjectId | 'absent'> {
  try {
    const outcome = await resolveDirectChain(store, target, MAX_SYMBOLIC_REF_DEPTH);
    return outcome.kind === 'found' ? outcome.id : 'absent';
  } catch (err) {
    const code = errorDataCode(err);
    const isChainFault = code === 'REF_CYCLE_DETECTED' || code === 'REF_CHAIN_TOO_DEEP';
    if (expected === undefined && isChainFault) return 'absent';
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
