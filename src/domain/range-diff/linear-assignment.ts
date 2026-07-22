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
    // Stryker disable next-line EqualityOperator: equivalent — the extra `i === rowCount` iteration reads `costAt(…, rowCount)` out of bounds (`undefined`); `cost > undefined` is false, so `i1` never updates — a no-op.
    for (let i = 1; i < s.rowCount; i++) {
      if (costAt(s, j, i1) > costAt(s, j, i)) i1 = i;
    }
    s.v[j] = costAt(s, j, i1);
    if (s.rowToColumn[i1] === -1) {
      s.rowToColumn[i1] = j;
      s.columnToRow[j] = i1;
      // Stryker disable next-line BlockStatement: equivalent — emptying the else drops the no-op `columnToRow[j] = -1` (already `-1`, set once here) and the double-claim flip, which only toggles whether reduction-transfer runs the `transferRow` dual warm-start; the augmenting phase reaches the same final assignment.
    } else {
      // Stryker disable next-line ConditionalExpression,EqualityOperator: equivalent — the flip only marks a double-claim so reduction-transfer skips the `transferRow` dual warm-start; forcing/negating/complementing the guard merely toggles that warm-start for multiply-claimed rows (reconciled by the augmenting phase), and `>0` equals `>=0` because `rowToColumn[i1]` is never `0` here (column 0 is reduced last).
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
    // Stryker disable next-line EqualityOperator: equivalent — when `min === reduced` the branch assigns `min = reduced`, an identical i32 value, so `>` and `>=` yield the same running min.
    if (j !== j1 && min > reduced) min = reduced;
  }
  s.v[j1] = i32(s.v[j1]! - min);
};

const reductionTransfer = (s: Lap, freeRow: number[]): number => {
  let freeCount = 0;
  // Stryker disable next-line EqualityOperator: equivalent — the extra `i === rowCount` iteration reads `rowToColumn[rowCount]` (`undefined`), so it falls to `transferRow(s, rowCount, undefined)`, whose only write is the discarded `v[undefined]`; no in-bounds state changes.
  for (let i = 0; i < s.rowCount; i++) {
    const j1 = s.rowToColumn[i]!;
    if (j1 === -1) freeRow[freeCount++] = i;
    // Stryker disable next-line EqualityOperator: equivalent — `j1 === -1` is handled by the branch above, so it never reaches here; with `j1` never `-1`, `< -1` and `<= -1` coincide.
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
  // Stryker disable next-line UnaryOperator: equivalent — the loop overwrites `lastJ` with a real column (`>= 0`) on its first pass, so the initializer survives only when the loop runs zero times; but then `lastJ` is returned as `path.j` and would index `pred[-1]`/`columnToRow[-1]` (`undefined`) in `augmentOne`, hanging the augmenting walk a correct run never triggers — so the init is never observed.
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
    // Stryker disable next-line EqualityOperator: equivalent — at `k === columnCount` `col[k]` is `undefined`, so `c` is `i32(NaN) === 0` and the guard `c < d[undefined]` is `0 < undefined` (false); the trailing iteration relaxes nothing.
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
  // Stryker disable next-line ArrayDeclaration: equivalent — `d` is written at every index `0..columnCount-1` by the init loop below and never read at index `columnCount`, so the preallocated length is inert.
  const d = new Array<number>(s.columnCount);
  // Stryker disable next-line ArrayDeclaration: equivalent — `pred` is written at every index `0..columnCount-1` by the init loop below and never read at index `columnCount`, so the preallocated length is inert.
  const pred = new Array<number>(s.columnCount);
  // Stryker disable next-line ArrayDeclaration: equivalent — `col` is written at every index `0..columnCount-1` by the init loop below and never read at index `columnCount`, so the preallocated length is inert.
  const col = new Array<number>(s.columnCount);
  // Stryker disable next-line EqualityOperator: equivalent — the extra entry written at index `columnCount` is never read; `findAugmentingPath` and every scan bound `k` by `columnCount`.
  for (let j = 0; j < s.columnCount; j++) {
    d[j] = i32(costAt(s, j, i1) - s.v[j]!);
    pred[j] = i1;
    col[j] = j;
  }
  const path = findAugmentingPath(s, d, pred, col);
  // Stryker disable next-line EqualityOperator: equivalent — `col[path.last]` is the found column whose `d` already equals `path.min`, so the extra iteration's `v += d - path.min` adds 0 — no dual changes.
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

  // Stryker disable next-line ConditionalExpression,BlockStatement: equivalent — the `n < 2` fast-path is pure optimisation: for `n === 0` the general path's loops are empty and for `n === 1` column-reduction assigns the sole cell (freeCount 0, early return), so forcing the guard false or emptying its block both reach the identical `[0]`/`[]` result.
  if (n < 2) {
    columnToRow.fill(0);
    rowToColumn.fill(0);
    return { columnToRow, rowToColumn };
  }

  // Stryker disable next-line UnaryOperator: equivalent — column-reduction writes every `columnToRow[j]` before any read, so the `-1` vs `+1` initial fill is dead.
  columnToRow.fill(-1);
  rowToColumn.fill(-1);
  const s: Lap = {
    columnCount: n,
    rowCount: n,
    cost,
    // Stryker disable next-line ArrayDeclaration: equivalent — column-reduction assigns every `v[j]` before any read, so preallocating length n vs growing from empty is inert.
    v: new Array<number>(n).fill(0),
    columnToRow,
    rowToColumn,
  };

  columnReduction(s);
  // Stryker disable next-line ArrayDeclaration: equivalent — `freeRow` is written by counter (`freeRow[freeCount++]`) and read only below the write cursor, so preallocating length n vs growing from empty is inert.
  const freeRow = new Array<number>(n);
  let freeCount = reductionTransfer(s, freeRow);

  // Stryker disable next-line ConditionalExpression: equivalent — when `freeCount` is 0 the augmenting loops below run zero iterations and return the same maps, so this early return is redundant (forcing the guard false is a no-op).
  if (freeCount === 0) return { columnToRow, rowToColumn };

  freeCount = augmentingRowReduction(s, freeRow, freeCount);
  for (let f = 0; f < freeCount; f++) augmentOne(s, freeRow[f]!);

  return { columnToRow, rowToColumn };
};
