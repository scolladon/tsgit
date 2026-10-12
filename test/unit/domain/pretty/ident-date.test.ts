import { describe, expect, it } from 'vitest';
import { DATE_MODE_BY_PART, showIdentDate } from '../../../../src/domain/pretty/ident-date.js';
import { GIT_DATE_ROWS } from './git-date-rows.js';

const NOW = 1700000000;
const FATAL_PREFIX = 'fatal: ';
const MODES = ['d', 'D', 'i', 'I', 's', 'h', 'r'] as const;
const LOCAL_OFFSET_MINUTES: Readonly<Record<string, number>> = {
  UTC: 0,
  'Europe/Paris': 60,
  'America/St_Johns': -210,
};
const ascii = (text: string): Uint8Array => new TextEncoder().encode(text);

const rows = GIT_DATE_ROWS.trim()
  .split('\n')
  .map((line) => {
    const [localZone, timestamp, zone, ...rendered] = line.split('|');
    return {
      localZone: localZone as string,
      timestamp: timestamp as string,
      zone: zone as string,
      rendered,
    };
  });

const renderOrFatal = (row: (typeof rows)[number], part: (typeof MODES)[number]): string => {
  const clock = {
    nowSeconds: NOW,
    localOffsetMinutes: LOCAL_OFFSET_MINUTES[row.localZone] as number,
  };
  try {
    const mode = DATE_MODE_BY_PART.get(part) as NonNullable<
      ReturnType<typeof DATE_MODE_BY_PART.get>
    >;
    return showIdentDate(ascii(row.timestamp), ascii(row.zone), mode, clock);
  } catch (error) {
    return `${FATAL_PREFIX}${(error as Error).message}`;
  }
};

const gitFatal = (cell: string): string =>
  cell.startsWith(FATAL_PREFIX)
    ? `${FATAL_PREFIX}TIMESTAMP_OUT_OF_RANGE: ${cell.slice(FATAL_PREFIX.length)}`
    : cell;

describe('showIdentDate', () => {
  describe.each(rows)(
    'Given author timestamp $timestamp zone $zone with local zone $localZone',
    (row) => {
      describe('When rendering every date placeholder', () => {
        it('Then each one is the bytes git renders or the death git reports', () => {
          // Arrange
          const sut = renderOrFatal;

          // Act
          const result = MODES.map((part) => sut(row, part));

          // Assert
          expect(result).toEqual(row.rendered.map(gitFatal));
        });
      });
    },
  );
});
