import { describe, expect, it } from 'vitest';
import { splitAgainstParent } from '../../../../src/domain/blame/split-blame.js';
import type { BlameEntry } from '../../../../src/domain/blame/types.js';
import type { LineDiff, LineHunk } from '../../../../src/domain/diff/line-diff.js';

const mkDiff = (hunks: ReadonlyArray<LineHunk>): LineDiff => ({
  hunks,
  oursLines: [],
  theirsLines: [],
  degraded: false,
});

const common = (oursStart: number, theirsStart: number, count: number): LineHunk => ({
  kind: 'common',
  oursStart,
  oursEnd: oursStart + count,
  theirsStart,
  theirsEnd: theirsStart + count,
});

const theirsOnly = (theirsStart: number, count: number, oursAt: number): LineHunk => ({
  kind: 'theirs-only',
  oursStart: oursAt,
  oursEnd: oursAt,
  theirsStart,
  theirsEnd: theirsStart + count,
});

const oursOnly = (oursStart: number, count: number, theirsAt: number): LineHunk => ({
  kind: 'ours-only',
  oursStart,
  oursEnd: oursStart + count,
  theirsStart: theirsAt,
  theirsEnd: theirsAt,
});

const entry = (finalStart: number, count: number, sourceStart: number): BlameEntry => ({
  finalStart,
  count,
  sourceStart,
});

describe('Given a child fully unchanged from its parent, When splitting blame against the parent', () => {
  it('Then every entry passes to the parent with sourceStart unchanged', () => {
    // Arrange
    const sut = splitAgainstParent;
    const entries = [entry(0, 3, 0)];

    // Act
    const result = sut(entries, mkDiff([common(0, 0, 3)]));

    // Assert
    expect(result.passed).toEqual([entry(0, 3, 0)]);
    expect(result.kept).toEqual([]);
  });
});

describe('Given the parent inserted lines above the common region, When splitting', () => {
  it('Then passed entries carry the parent line numbering (offset)', () => {
    // Arrange — parent has 2 extra leading lines: child line 0..2 ≡ parent line 2..4
    const sut = splitAgainstParent;
    const entries = [entry(0, 3, 0)];

    // Act
    const result = sut(entries, mkDiff([oursOnly(0, 2, 0), common(2, 0, 3)]));

    // Assert
    expect(result.passed).toEqual([entry(0, 3, 2)]);
    expect(result.kept).toEqual([]);
  });
});

describe('Given the child added leading lines absent in the parent, When splitting', () => {
  it('Then the added lines are kept and the trailing common lines pass', () => {
    // Arrange — child lines 0..1 are new; child lines 2..3 ≡ parent lines 0..1
    const sut = splitAgainstParent;
    const entries = [entry(0, 4, 0)];

    // Act
    const result = sut(entries, mkDiff([theirsOnly(0, 2, 0), common(0, 2, 2)]));

    // Assert
    expect(result.kept).toEqual([entry(0, 2, 0)]);
    expect(result.passed).toEqual([entry(2, 2, 0)]);
  });
});

describe('Given an entry straddling a common→added boundary, When splitting', () => {
  it('Then it splits into one passed and one kept entry, each preserving finalStart', () => {
    // Arrange — child 0..1 common (parent 0..1); child 2..3 added
    const sut = splitAgainstParent;
    const entries = [entry(10, 4, 0)];

    // Act
    const result = sut(entries, mkDiff([common(0, 0, 2), theirsOnly(2, 2, 2)]));

    // Assert
    expect(result.passed).toEqual([entry(10, 2, 0)]);
    expect(result.kept).toEqual([entry(12, 2, 2)]);
  });
});

describe('Given two common regions split by a parent-only deletion, When splitting', () => {
  it('Then the non-contiguous parent numbering forces two passed entries', () => {
    // Arrange — child 0..1 ≡ parent 0..1; parent 2..3 deleted; child 2..3 ≡ parent 4..5
    const sut = splitAgainstParent;
    const entries = [entry(0, 4, 0)];

    // Act
    const result = sut(entries, mkDiff([common(0, 0, 2), oursOnly(2, 2, 2), common(4, 2, 2)]));

    // Assert
    expect(result.passed).toEqual([entry(0, 2, 0), entry(2, 2, 4)]);
    expect(result.kept).toEqual([]);
  });
});

describe('Given multiple independent entries, When splitting', () => {
  it('Then each entry is partitioned independently', () => {
    // Arrange — child 0 common (parent 0); child 1 added
    const sut = splitAgainstParent;
    const entries = [entry(0, 1, 0), entry(1, 1, 1)];

    // Act
    const result = sut(entries, mkDiff([common(0, 0, 1), theirsOnly(1, 1, 1)]));

    // Assert
    expect(result.passed).toEqual([entry(0, 1, 0)]);
    expect(result.kept).toEqual([entry(1, 1, 1)]);
  });
});

describe('Given no entries, When splitting', () => {
  it('Then both partitions are empty', () => {
    // Arrange
    const sut = splitAgainstParent;

    // Act
    const result = sut([], mkDiff([common(0, 0, 3)]));

    // Assert
    expect(result.passed).toEqual([]);
    expect(result.kept).toEqual([]);
  });
});

describe('Given a wholly-rewritten (degraded) diff with no common region, When splitting', () => {
  it('Then every entry is kept at the suspect', () => {
    // Arrange — parent 0..2 deleted, child 0..2 added: nothing common
    const sut = splitAgainstParent;
    const entries = [entry(0, 3, 0)];

    // Act
    const result = sut(entries, mkDiff([oursOnly(0, 3, 0), theirsOnly(0, 3, 0)]));

    // Assert
    expect(result.kept).toEqual([entry(0, 3, 0)]);
    expect(result.passed).toEqual([]);
  });
});
