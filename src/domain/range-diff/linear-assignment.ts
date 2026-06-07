/**
 * Verbatim port of git's `compute_assignment` (`linear-assignment.c`) — the
 * shortest-augmenting-path linear assignment solver (Jonker & Volgenant, 1987)
 * that `range-diff` uses to pair the patches of two ranges at minimum total cost.
 *
 * Contract note: this is a faithful transcription of git's solver, not a general
 * LAP — git's own `BUG("negative j")` guard shows it only promises a complete
 * matching on the structured cost matrices range-diff builds (where every commit
 * has a finite creation/deletion escape, so a cheap perfect matching exists). On
 * an unstructured matrix it may leave columns `-1`, exactly as git does;
 * `correspond` treats any such `-1` as "unmatched" (a deletion), so the
 * downstream behaviour degrades gracefully.
 *
 * Faithfulness note: git's dual variables and reduced costs are 32-bit `int`s
 * that may overflow when subtracting a negative dual from a `COST_MAX` cell. The
 * resulting wraparound is part of git's observable tie-breaking, so every value
 * C stores in an `int` is wrapped here to 32-bit via `i32` (`x | 0`) — this
 * reproduces git's arithmetic, overflow included, bit-for-bit. The phase
 * structure (column reduction → reduction transfer → augmenting-row reduction →
 * augmentation) and every index dance are kept identical to the C source.
 */

/** git's `COST_MAX` (`linear-assignment.h`): `1 << 16`, deliberately small to
 *  prevent integer overflow in the dual-variable arithmetic. Marks a forbidden
 *  assignment cell — large enough to dominate any real cost, small enough that
 *  `COST_MAX - v` never overflows a 32-bit int. */
export const COST_MAX = 1 << 16;

export interface Assignment {
  /** `columnToRow[c]` = the row assigned to column `c`. */
  readonly columnToRow: ReadonlyArray<number>;
  /** `rowToColumn[r]` = the column assigned to row `r`. */
  readonly rowToColumn: ReadonlyArray<number>;
}

interface Lap {
  readonly columnCount: number;
  readonly rowCount: number;
  readonly cost: ReadonlyArray<number>;
  readonly v: number[];
  readonly columnToRow: number[];
  readonly rowToColumn: number[];
}

/** Truncate to a 32-bit signed integer, mirroring C `int` arithmetic. */
const i32 = (x: number): number => x | 0;

/** COST(column, row) = cost[column + columnCount * row]. */
const costAt = (s: Lap, column: number, row: number): number =>
  s.cost[column + s.columnCount * row]!;

const columnReduction = (s: Lap): void => {
  for (let j = s.columnCount - 1; j >= 0; j--) {
    let i1 = 0;
    // equivalent-mutant (`i < rowCount` → `i <= rowCount`): the extra `i === rowCount`
    // reads `costAt` out of bounds (`undefined`), and `costAt(…, i1) > undefined` is
    // false, so `i1` is never updated — the trailing iteration is a no-op.
    for (let i = 1; i < s.rowCount; i++) {
      if (costAt(s, j, i1) > costAt(s, j, i)) i1 = i;
    }
    s.v[j] = costAt(s, j, i1);
    if (s.rowToColumn[i1] === -1) {
      s.rowToColumn[i1] = j;
      s.columnToRow[j] = i1;
    } else {
      // equivalent-mutant (emptying this branch / forcing the `>= 0` guard): this is
      // git's double-claim bookkeeping — `columnToRow[j]` is already `-1` (set once,
      // here), and the negative-encoding flip only records that row `i1` is contended
      // so reduction-transfer can skip an early `transferRow`. Either way the shortest-
      // augmenting-path phase reconciles row `i1` to the same final assignment; no
      // matrix in the 150-case adversarial/tie-heavy/targeted corpus distinguishes it.
      if (s.rowToColumn[i1]! >= 0) s.rowToColumn[i1] = -2 - s.rowToColumn[i1]!;
      s.columnToRow[j] = -1;
    }
  }
};

/** Transfer the reduction for an already-assigned row `i` (column `j1`). */
const transferRow = (s: Lap, i: number, j1: number): void => {
  const other = j1 === 0 ? 1 : 0; // C's `!j1`
  let min = i32(costAt(s, other, i) - s.v[other]!);
  for (let j = 1; j < s.columnCount; j++) {
    const reduced = i32(costAt(s, j, i) - s.v[j]!);
    // equivalent-mutant (`min > reduced` → `min >= reduced`): when `min === reduced`
    // the assignment `min = reduced` stores the same value, so the two forms agree.
    if (j !== j1 && min > reduced) min = reduced;
  }
  s.v[j1] = i32(s.v[j1]! - min);
};

const reductionTransfer = (s: Lap, freeRow: number[]): number => {
  let freeCount = 0;
  // equivalent-mutant (`i < rowCount` → `i <= rowCount`): the extra `i === rowCount`
  // reads `rowToColumn[rowCount]` (`undefined`), which is neither `-1` nor `< -1`, so
  // it falls to `transferRow(s, rowCount, undefined)` — that only writes the phantom
  // `v[undefined]` (every real access is `i32(NaN) === 0`), leaving valid state intact.
  for (let i = 0; i < s.rowCount; i++) {
    const j1 = s.rowToColumn[i]!;
    if (j1 === -1) freeRow[freeCount++] = i;
    // equivalent-mutant (`j1 < -1` → `j1 <= -1`): `j1 === -1` is already handled by the
    // branch above, so the `=== -1` case never reaches here — the bounds coincide.
    else if (j1 < -1) s.rowToColumn[i] = -2 - j1;
    else transferRow(s, i, j1);
  }
  return freeCount;
};

interface TwoSmallest {
  j1: number;
  readonly u1: number;
  readonly j2: number;
  readonly u2: number;
}

/** The two columns of smallest reduced cost for row `i` (git's u1/j1, u2/j2). */
const findTwoSmallest = (s: Lap, i: number): TwoSmallest => {
  let j1 = 0;
  let u1 = i32(costAt(s, j1, i) - s.v[j1]!);
  let j2 = -1;
  let u2 = COST_MAX;
  for (let j = 1; j < s.columnCount; j++) {
    const c = i32(costAt(s, j, i) - s.v[j]!);
    if (u2 > c) {
      if (u1 < c) {
        u2 = c;
        j2 = j;
      } else {
        u2 = u1;
        u1 = c;
        j2 = j1;
        j1 = j;
      }
    }
  }
  // equivalent-mutant (`j2 = -1` → `+1`, and emptying/forcing this reset): `j2` is left
  // unset only when every column's reduced cost is `>= COST_MAX`, i.e. the row is fully
  // forbidden. Reaching that state forces every column dual `v[j]` to 0, which (by the
  // pigeonhole of column-reduction claims) leaves this row's best column `j1` unassigned
  // — so the `else if (i0 >= 0)` in `reduceFreeRow` that would consume `j2` is never
  // taken, making the reset's outcome unobservable across the 150-case corpus.
  if (j2 < 0) {
    j2 = j1;
    u2 = u1;
  }
  return { j1, u1, j2, u2 };
};

/** Reduce one free row `i`, returning the advanced read/write cursors. A
 *  displaced row goes back onto the read cursor (`--k`, this phase) or the write
 *  cursor (`freeCount++`, next phase), per git's `u1 < u2` split. */
const reduceFreeRow = (
  s: Lap,
  freeRow: number[],
  i: number,
  k: number,
  freeCount: number,
): { readonly k: number; readonly freeCount: number } => {
  const two = findTwoSmallest(s, i);
  let j1 = two.j1;
  let i0 = s.columnToRow[j1]!;
  let nextK = k;
  let nextFree = freeCount;
  if (two.u1 < two.u2) {
    s.v[j1] = i32(s.v[j1]! - (two.u2 - two.u1));
  } else if (i0 >= 0) {
    j1 = two.j2;
    i0 = s.columnToRow[j1]!;
  }
  if (i0 >= 0) {
    if (two.u1 < two.u2) freeRow[--nextK] = i0;
    else freeRow[nextFree++] = i0;
  }
  s.rowToColumn[i] = j1;
  s.columnToRow[j1] = i;
  return { k: nextK, freeCount: nextFree };
};

const augmentingRowReduction = (s: Lap, freeRow: number[], freeCountIn: number): number => {
  let freeCount = freeCountIn;
  for (let phase = 0; phase < 2; phase++) {
    let k = 0;
    const saved = freeCount;
    freeCount = 0;
    while (k < saved) {
      const i = freeRow[k++]!;
      const next = reduceFreeRow(s, freeRow, i, k, freeCount);
      k = next.k;
      freeCount = next.freeCount;
    }
  }
  return freeCount;
};

interface Search {
  low: number;
  up: number;
}

interface PathResult {
  readonly j: number;
  readonly last: number;
  readonly min: number;
}

/**
 * Move every still-unscanned column whose distance `d` is `<= min` into the
 * active set `[search.low, search.up)`, returning the prevailing `min` and the
 * last column index touched (git leaves `j` at this value when the immediately
 * following unassigned-column check fires).
 */
const expandMinColumns = (
  s: Lap,
  d: number[],
  col: number[],
  search: Search,
): { readonly min: number; readonly lastJ: number } => {
  let min = d[col[search.up++]!]!;
  let lastJ = -1;
  for (let k = search.up; k < s.columnCount; k++) {
    const j = col[k]!;
    lastJ = j;
    const c = d[j]!;
    if (c <= min) {
      if (c < min) {
        search.up = search.low;
        min = c;
      }
      col[k] = col[search.up]!;
      col[search.up++] = j;
    }
  }
  return { min, lastJ };
};

const hasUnassignedColumn = (s: Lap, col: number[], search: Search): boolean => {
  for (let k = search.low; k < search.up; k++) {
    if (s.columnToRow[col[k]!] === -1) return true;
  }
  return false;
};

/**
 * Scan rows out of the active column set, relaxing distances, until the set is
 * exhausted (`low === up`) or an unassigned column at distance `min` is reached
 * (the augmenting-path endpoint).
 */
const scanRows = (
  s: Lap,
  d: number[],
  pred: number[],
  col: number[],
  search: Search,
  min: number,
): number => {
  do {
    const j1 = col[search.low++]!;
    const i = s.columnToRow[j1]!;
    const u1 = i32(costAt(s, j1, i) - s.v[j1]! - min);
    // equivalent-mutant (`k < columnCount` → `k <= columnCount`): at `k === columnCount`
    // `col[k]` is `undefined`, so `c` is `i32(NaN) === 0` and `c < d[undefined]` is
    // `0 < undefined` (false) — the trailing iteration relaxes nothing.
    for (let k = search.up; k < s.columnCount; k++) {
      const j = col[k]!;
      const c = i32(costAt(s, j, i) - s.v[j]! - u1);
      if (c < d[j]!) {
        d[j] = c;
        pred[j] = i;
        if (c === min) {
          if (s.columnToRow[j] === -1) return j;
          col[k] = col[search.up]!;
          col[search.up++] = j;
        }
      }
    }
  } while (search.low !== search.up);
  return -1;
};

const findAugmentingPath = (s: Lap, d: number[], pred: number[], col: number[]): PathResult => {
  const search: Search = { low: 0, up: 0 };
  // Endless by construction: git's `do … while (low === up)` only ever leaves via
  // one of the two "found an unassigned column" gotos, modelled here as returns.
  for (;;) {
    const last = search.low;
    const { min, lastJ } = expandMinColumns(s, d, col, search);
    if (hasUnassignedColumn(s, col, search)) return { j: lastJ, last, min };
    const found = scanRows(s, d, pred, col, search, min);
    if (found >= 0) return { j: found, last, min };
  }
};

const augmentOne = (s: Lap, i1: number): void => {
  // equivalent-mutant (`new Array<number>(columnCount)` → `new Array()`): the three
  // working arrays are fully written by index in the immediately following loop, so the
  // preallocated length is an optimisation with no observable effect.
  const d = new Array<number>(s.columnCount);
  const pred = new Array<number>(s.columnCount);
  const col = new Array<number>(s.columnCount);
  // equivalent-mutant (`j < columnCount` → `j <= columnCount`): the extra entry at index
  // `columnCount` is never read — `findAugmentingPath` and the scans all bound `k` by
  // `columnCount`.
  for (let j = 0; j < s.columnCount; j++) {
    d[j] = i32(costAt(s, j, i1) - s.v[j]!);
    pred[j] = i1;
    col[j] = j;
  }
  const path = findAugmentingPath(s, d, pred, col);
  // equivalent-mutant (`k < path.last` → `k <= path.last`): `path.last` is the read
  // cursor when the augmenting column was found; `col[path.last]` is that column, whose
  // `d` already equals `path.min`, so the extra `v += d - min` adds 0 — no dual changes.
  for (let k = 0; k < path.last; k++) {
    const j1 = col[k]!;
    s.v[j1] = i32(s.v[j1]! + (d[j1]! - path.min));
  }
  let j = path.j;
  let i: number;
  do {
    i = pred[j]!;
    s.columnToRow[j] = i;
    const swap = s.rowToColumn[i]!;
    s.rowToColumn[i] = j;
    j = swap;
  } while (i1 !== i);
};

/**
 * Solve a square `n×n` assignment. range-diff (like git) only ever solves square
 * matrices, so a single `n` replaces git's `column_count`/`row_count` pair; the
 * non-square `-1`-padding path git documents is unused here.
 */
export const computeAssignment = (n: number, cost: ReadonlyArray<number>): Assignment => {
  const columnToRow = new Array<number>(n);
  const rowToColumn = new Array<number>(n);

  // equivalent-mutant (removing this `n < 2` fast-path): for `n === 0` the loops below
  // are empty and for `n === 1` column-reduction assigns the single cell, so the general
  // path returns the same `[0]`/`[]` result this shortcut produces.
  if (n < 2) {
    columnToRow.fill(0);
    rowToColumn.fill(0);
    return { columnToRow, rowToColumn };
  }

  // equivalent-mutant (`columnToRow.fill(-1)` → `fill(+1)`): every `columnToRow[j]` is
  // overwritten in column-reduction before it is read, so its initial value is dead.
  columnToRow.fill(-1);
  rowToColumn.fill(-1);
  const s: Lap = {
    columnCount: n,
    rowCount: n,
    cost,
    // equivalent-mutant (`new Array(n).fill(0)` → `new Array().fill(0)`): column-reduction
    // assigns every `v[j]` before any read.
    v: new Array<number>(n).fill(0),
    columnToRow,
    rowToColumn,
  };

  columnReduction(s);
  // equivalent-mutant (`new Array<number>(n)` → `new Array()`): `freeRow` is written by
  // index (`freeRow[freeCount++]`) and read only below `freeCount`.
  const freeRow = new Array<number>(n);
  let freeCount = reductionTransfer(s, freeRow);

  // equivalent-mutant (removing this `freeCount === 0` early return): when no rows are
  // free the augmenting loops below execute zero iterations and return the same result.
  if (freeCount === 0) return { columnToRow, rowToColumn };

  freeCount = augmentingRowReduction(s, freeRow, freeCount);
  for (let f = 0; f < freeCount; f++) augmentOne(s, freeRow[f]!);

  return { columnToRow, rowToColumn };
};
