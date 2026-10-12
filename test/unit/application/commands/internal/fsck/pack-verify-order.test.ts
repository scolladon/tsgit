import { describe, expect, it } from 'vitest';
import {
  orderPacksForVerify,
  type TipHit,
} from '../../../../../../src/application/commands/internal/fsck/pack-verify-order.js';

const sut = orderPacksForVerify;

const pack = (name: string, seconds: number) => ({ name, seconds });
const scanHit = (...holders: ReadonlyArray<string>): TipHit => ({
  kind: 'scan',
  holders: new Set(holders),
});
const midxHit = (name: string): TipHit => ({ kind: 'midx', pack: name });
const names = (packs: ReadonlyArray<{ readonly name: string }>) => packs.map(({ name }) => name);

describe('Given scanned packs of different ages and no ref tip', () => {
  describe('When they are ordered', () => {
    it('Then the youngest comes first', () => {
      // Arrange
      const scanned = [pack('old', 1), pack('young', 3), pack('middle', 2)];

      // Act
      const result = sut(scanned, [], []);

      // Assert
      expect(names(result)).toEqual(['young', 'middle', 'old']);
    });
  });
});

describe('Given scanned packs of one age', () => {
  describe('When no ref tip touches them', () => {
    it('Then they keep their listing order', () => {
      // Arrange
      const scanned = [pack('first', 1), pack('second', 1), pack('third', 1)];

      // Act
      const result = sut(scanned, [], []);

      // Assert
      expect(names(result)).toEqual(['first', 'second', 'third']);
    });
  });

  describe('When a ref tip is found in the last of them', () => {
    it('Then that pack moves to the front, as git keeps its most recently used pack first', () => {
      // Arrange
      const scanned = [pack('first', 1), pack('second', 1), pack('third', 1)];

      // Act
      const result = sut(scanned, [], [scanHit('third')]);

      // Assert
      expect(names(result)).toEqual(['third', 'first', 'second']);
    });
  });

  describe('When a ref tip sits in two of them', () => {
    it('Then only the first holder in the current order moves', () => {
      // Arrange
      const scanned = [pack('first', 1), pack('second', 1), pack('third', 1)];

      // Act
      const result = sut(scanned, [], [scanHit('second', 'third')]);

      // Assert
      expect(names(result)).toEqual(['second', 'first', 'third']);
    });
  });
});

describe('Given a younger pack a ref tip moved behind an older one', () => {
  describe('When they are ordered', () => {
    it('Then age still wins over use', () => {
      // Arrange
      const scanned = [pack('young', 2), pack('old', 1)];

      // Act
      const result = sut(scanned, [], [scanHit('old')]);

      // Assert
      expect(names(result)).toEqual(['young', 'old']);
    });
  });
});

describe('Given multi-pack-index packs younger than a scanned pack', () => {
  describe('When no ref tip loads them', () => {
    it('Then they follow every scanned pack, in pack-int-id order', () => {
      // Arrange
      const scanned = [pack('scanned', 1)];
      const midx = [pack('midx-b', 5), pack('midx-a', 9)];

      // Act
      const result = sut(scanned, midx, []);

      // Assert
      expect(names(result)).toEqual(['scanned', 'midx-b', 'midx-a']);
    });
  });

  describe('When a ref tip loads one of them', () => {
    it('Then that one is ordered by age with the scanned packs, the rest still follow', () => {
      // Arrange
      const scanned = [pack('scanned', 1)];
      const midx = [pack('midx-b', 5), pack('midx-a', 9)];

      // Act
      const result = sut(scanned, midx, [midxHit('midx-a')]);

      // Assert
      expect(names(result)).toEqual(['midx-a', 'scanned', 'midx-b']);
    });
  });

  describe('When two ref tips load the same one', () => {
    it('Then it is listed once', () => {
      // Arrange
      const midx = [pack('midx-a', 9)];

      // Act
      const result = sut([], midx, [midxHit('midx-a'), midxHit('midx-a')]);

      // Assert
      expect(names(result)).toEqual(['midx-a']);
    });
  });
});

describe('Given multi-pack-index packs of one age loaded in reverse pack-int-id order', () => {
  describe('When they are ordered', () => {
    it('Then they keep their load order', () => {
      // Arrange
      const midx = [pack('midx-a', 1), pack('midx-b', 1)];

      // Act
      const result = sut([], midx, [midxHit('midx-b'), midxHit('midx-a')]);

      // Assert
      expect(names(result)).toEqual(['midx-b', 'midx-a']);
    });
  });
});

describe('Given a scan hit naming no listed pack', () => {
  describe('When they are ordered', () => {
    it('Then the order is unchanged', () => {
      // Arrange
      const scanned = [pack('first', 1), pack('second', 1)];

      // Act
      const result = sut(scanned, [], [scanHit('elsewhere')]);

      // Assert
      expect(names(result)).toEqual(['first', 'second']);
    });
  });
});
